// Ephemeral HTTP server for Twilio phone ping.
// Serves TwiML (play audio + gather speech), the audio file, and receives the
// POST webhook from Twilio with the transcribed speech.
// Started per-ping and auto-closes after lifetime (120s default, max 300s),
// when the Gather response arrives, or when the call ends.
// Accessible to Twilio through an ngrok tunnel.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http"
import { info, debug, warn, error as logError } from "../log"

const DEFAULT_PORT = 8088
const DEFAULT_LIFETIME_MS = 120_000
const MAX_LIFETIME_MS = 300_000
const DEFAULT_GATHER_TIMEOUT = 10
const DEFAULT_GATHER_SILENCE = 3
const DEFAULT_GATHER_PROFANITY_FILTER = "true"

export interface AudioServerOptions {
  port?: number
  ngrokUrl: string
  audioBuffer: ArrayBuffer
  lifetimeMs?: number
  gatherTimeout?: number
  gatherSilence?: number
}

export interface AudioServer {
  server: Server
  port: number
  twimlUrl: string
  close: () => Promise<void>
  responsePromise: Promise<string | null>
}

export function getNgrokUrl(): string | null {
  const url = process.env.OCODE_VOICE_NGROK_URL?.trim()
  if (!url) {
    debug("audio-server", "OCODE_VOICE_NGROK_URL not set")
    return null
  }
  return url.replace(/\/$/, "")
}

// Three endpoints:
//   GET  /twiml (or / or /twiml.xml) — returns TwiML with <Gather> + <Play>
//   GET  /audio.mp3                  — returns the synthesized audio bytes
//   POST /gather                     — Twilio webhook with transcribed speech
export async function startAudioServer(opts: AudioServerOptions): Promise<AudioServer> {
  const port = opts.port ?? (Number(process.env.OCODE_VOICE_PING_PORT) || DEFAULT_PORT)
  const lifetimeMs = Math.min(opts.lifetimeMs ?? (Number(process.env.OCODE_VOICE_PING_LIFETIME_MS) || DEFAULT_LIFETIME_MS), MAX_LIFETIME_MS)
  const ngrokUrl = opts.ngrokUrl.replace(/\/$/, "")
  const gatherTimeout = opts.gatherTimeout ?? (Number(process.env.OCODE_VOICE_GATHER_TIMEOUT) || DEFAULT_GATHER_TIMEOUT)
  const gatherSilence = opts.gatherSilence ?? (Number(process.env.OCODE_VOICE_GATHER_SILENCE) || DEFAULT_GATHER_SILENCE)

  const audioBytes = Buffer.from(opts.audioBuffer)

  let responseResolve: (value: string | null) => void
  const responsePromise = new Promise<string | null>((resolve) => {
    responseResolve = resolve
  })

  info("audio-server", `starting on port ${port}`, { ngrokUrl, audioBytes: audioBytes.length, lifetimeMs, gatherTimeout, gatherSilence })

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/"
    debug("audio-server", `request`, { method: req.method, url })

    if (url === "/" || url === "/twiml" || url === "/twiml.xml") {
      const twiml = buildPlayAndGatherTwiml(`${ngrokUrl}/audio.mp3`, `${ngrokUrl}/gather`)
      info("audio-server", "serving TwiML to Twilio")
      res.writeHead(200, { "Content-Type": "application/xml" })
      res.end(twiml)
      return
    }

    if (url === "/audio.mp3") {
      debug("audio-server", `serving audio (${audioBytes.length} bytes)`)
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBytes.length.toString(),
      })
      res.end(audioBytes)
      return
    }

    if (url === "/gather" && req.method === "POST") {
      info("audio-server", "Gather webhook received from Twilio")
      handleGatherWebhook(req, res, responseResolve!)
      return
    }

    if (url === "/gather" && req.method === "GET") {
      debug("audio-server", "GET /gather — returning hangup TwiML")
      const twiml = buildHangupTwiml()
      res.writeHead(200, { "Content-Type": "application/xml" })
      res.end(twiml)
      return
    }

    warn("audio-server", `unknown path: ${req.method} ${url}`)
    res.writeHead(404)
    res.end("not found")
  })

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err) => {
      logError("audio-server", `failed to listen on port ${port}`, { error: err.message })
      reject(err)
    })
    server.listen(port, () => {
      server.removeListener("error", reject)
      info("audio-server", `listening on port ${port}`)
      resolve()
    })
  })

  const lifetimeTimeout = setTimeout(() => {
    warn("audio-server", `lifetime expired (${lifetimeMs}ms), shutting down`)
    responseResolve!(null)
    closeServer(server)
  }, lifetimeMs)

  responsePromise.finally(() => {
    clearTimeout(lifetimeTimeout)
    void closeServer(server)
  })

  const close = async () => {
    clearTimeout(lifetimeTimeout)
    responseResolve!(null)
    await closeServer(server)
  }

  return {
    server,
    port,
    twimlUrl: `${ngrokUrl}/twiml`,
    close,
    responsePromise,
  }
}

function handleGatherWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  resolve: (value: string | null) => void
): void {
  let body = ""
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString()
  })
  req.on("end", () => {
    try {
      const params = new URLSearchParams(body)
      const speechResult = params.get("SpeechResult")?.trim()
      const confidence = params.get("Confidence")?.trim()
      const callSid = params.get("CallSid")?.trim()
      const unresolved = params.get("UnresolvedSpeech")?.trim()

      debug("audio-server", "gather webhook parsed", { speechResult, confidence, callSid, unresolved })

      if (speechResult) {
        info("audio-server", `user responded: "${speechResult}"`, { confidence, callSid })
        resolve(speechResult)
      } else if (unresolved) {
        warn("audio-server", "Twilio returned UnresolvedSpeech — speech not transcribed", { callSid })
        resolve(null)
      } else {
        warn("audio-server", "gather webhook had no SpeechResult or UnresolvedSpeech", { callSid })
        resolve(null)
      }

      const twiml = buildHangupTwiml()
      res.writeHead(200, { "Content-Type": "application/xml" })
      res.end(twiml)
    } catch (err) {
      logError("audio-server", "failed to parse gather webhook", { error: err instanceof Error ? err.message : String(err) })
      resolve(null)
      const twiml = buildHangupTwiml()
      res.writeHead(200, { "Content-Type": "application/xml" })
      res.end(twiml)
    }
  })
  req.on("error", (err) => {
    logError("audio-server", "gather request stream error", { error: err.message })
    resolve(null)
    res.writeHead(500)
    res.end()
  })
}

// <Gather> wraps <Play> so Twilio starts listening for speech while audio plays.
// If no speech is detected, it falls through to <Say> + <Hangup>.
function buildPlayAndGatherTwiml(audioUrl: string, gatherActionUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${gatherActionUrl}" method="POST" timeout="${DEFAULT_GATHER_TIMEOUT}" speechTimeout="${DEFAULT_GATHER_SILENCE}" profanityFilter="${DEFAULT_GATHER_PROFANITY_FILTER}">
    <Play loop="1">${audioUrl}</Play>
  </Gather>
  <Say voice="alice">No response detected. Goodbye.</Say>
  <Hangup/>
</Response>`
}

function buildHangupTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) {
      server.close(() => resolve())
    } else {
      resolve()
    }
  })
}