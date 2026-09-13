// Ephemeral HTTP server for Twilio phone ping.
//
// When a phone ping is initiated, this server:
// 1. Serves TwiML (Twilio's XML instruction language) telling Twilio to play
//    the synthesized audio and then capture the user's spoken reply via <Gather>.
// 2. Serves the audio file (MP3) that Twilio downloads and plays on the call.
// 3. Receives the POST webhook from Twilio when the user speaks (or the Gather
//    times out), containing the transcribed speech ("SpeechResult").
//
// The server is started per-ping and auto-closes after a lifetime timeout
// (default 120s, max 300s) or when the Gather response arrives or the call ends.
// It's accessible to Twilio through an ngrok tunnel.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http"
import { info, debug, warn, error as logError } from "../log"

// Default local port the server listens on (must match ngrok tunnel config)
const DEFAULT_PORT = 8088
// How long the server stays alive waiting for a response (auto-shutdown)
const DEFAULT_LIFETIME_MS = 120_000
// Hard cap on lifetime to prevent zombie servers
const MAX_LIFETIME_MS = 300_000
// Twilio Gather: how many seconds to wait for the user to start speaking
const DEFAULT_GATHER_TIMEOUT = 10
// Twilio Gather: how many seconds of silence before ending the gather
const DEFAULT_GATHER_SILENCE = 3
// Twilio Gather: whether to filter profanity from the transcription
const DEFAULT_GATHER_PROFANITY_FILTER = "true"

// Options for starting the audio server.
export interface AudioServerOptions {
  port?: number
  ngrokUrl: string       // The public ngrok URL that tunnels to this server
  audioBuffer: ArrayBuffer // The synthesized ElevenLabs audio to play on the call
  lifetimeMs?: number
  gatherTimeout?: number
  gatherSilence?: number
}

// The running audio server instance.
// `responsePromise` resolves with the user's transcribed speech (or null on
// timeout/no speech). Callers await this to get the user's reply.
export interface AudioServer {
  server: Server
  port: number
  twimlUrl: string      // The public URL Twilio should fetch for TwiML
  close: () => Promise<void>
  responsePromise: Promise<string | null>
}

// Read the ngrok URL from the env var. Strips trailing slash for consistency.
// Returns null if not set.
export function getNgrokUrl(): string | null {
  const url = process.env.OCODE_VOICE_NGROK_URL?.trim()
  if (!url) {
    debug("audio-server", "OCODE_VOICE_NGROK_URL not set")
    return null
  }
  return url.replace(/\/$/, "")
}

// Start the ephemeral audio server. Returns once the server is listening.
// The server handles three endpoints:
//   GET  /twiml (or / or /twiml.xml) — returns TwiML with <Gather> + <Play>
//   GET  /audio.mp3                  — returns the synthesized audio bytes
//   POST /gather                     — Twilio webhook with transcribed speech
export async function startAudioServer(opts: AudioServerOptions): Promise<AudioServer> {
  const port = opts.port ?? (Number(process.env.OCODE_VOICE_PING_PORT) || DEFAULT_PORT)
  // Cap the lifetime at MAX_LIFETIME_MS to prevent zombie servers
  const lifetimeMs = Math.min(opts.lifetimeMs ?? (Number(process.env.OCODE_VOICE_PING_LIFETIME_MS) || DEFAULT_LIFETIME_MS), MAX_LIFETIME_MS)
  const ngrokUrl = opts.ngrokUrl.replace(/\/$/, "")
  const gatherTimeout = opts.gatherTimeout ?? (Number(process.env.OCODE_VOICE_GATHER_TIMEOUT) || DEFAULT_GATHER_TIMEOUT)
  const gatherSilence = opts.gatherSilence ?? (Number(process.env.OCODE_VOICE_GATHER_SILENCE) || DEFAULT_GATHER_SILENCE)

  const audioBytes = Buffer.from(opts.audioBuffer)

  // This promise resolves when we get the Gather webhook response (or timeout).
  // The caller awaits it to get the user's transcribed speech.
  let responseResolve: (value: string | null) => void
  const responsePromise = new Promise<string | null>((resolve) => {
    responseResolve = resolve
  })

  info("audio-server", `starting on port ${port}`, { ngrokUrl, audioBytes: audioBytes.length, lifetimeMs, gatherTimeout, gatherSilence })

  // Create the HTTP server with request routing
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/"
    debug("audio-server", `request`, { method: req.method, url })

    // Endpoint 1: TwiML — Twilio fetches this to get call instructions
    if (url === "/" || url === "/twiml" || url === "/twiml.xml") {
      const twiml = buildPlayAndGatherTwiml(`${ngrokUrl}/audio.mp3`, `${ngrokUrl}/gather`)
      info("audio-server", "serving TwiML to Twilio")
      res.writeHead(200, { "Content-Type": "application/xml" })
      res.end(twiml)
      return
    }

    // Endpoint 2: Audio file — Twilio downloads this to play on the call
    if (url === "/audio.mp3") {
      debug("audio-server", `serving audio (${audioBytes.length} bytes)`)
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBytes.length.toString(),
      })
      res.end(audioBytes)
      return
    }

    // Endpoint 3: Gather webhook — Twilio POSTs here with the transcribed speech
    if (url === "/gather" && req.method === "POST") {
      info("audio-server", "Gather webhook received from Twilio")
      handleGatherWebhook(req, res, responseResolve!)
      return
    }

    // GET on /gather returns a hangup TwiML (used if Twilio fetches it directly)
    if (url === "/gather" && req.method === "GET") {
      debug("audio-server", "GET /gather — returning hangup TwiML")
      const twiml = buildHangupTwiml()
      res.writeHead(200, { "Content-Type": "application/xml" })
      res.end(twiml)
      return
    }

    // Unknown path
    warn("audio-server", `unknown path: ${req.method} ${url}`)
    res.writeHead(404)
    res.end("not found")
  })

  // Wait for the server to start listening (or fail to bind)
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

  // Auto-shutdown after the lifetime expires — resolves the promise with null
  // so the caller doesn't hang forever if no response comes.
  const lifetimeTimeout = setTimeout(() => {
    warn("audio-server", `lifetime expired (${lifetimeMs}ms), shutting down`)
    responseResolve!(null)
    closeServer(server)
  }, lifetimeMs)

  // Also clean up whenever the response promise settles (response arrived or
  // close() was called manually).
  responsePromise.finally(() => {
    clearTimeout(lifetimeTimeout)
    void closeServer(server)
  })

  // Manual close function — called by the ping orchestrator when done
  const close = async () => {
    clearTimeout(lifetimeTimeout)
    responseResolve!(null)
    await closeServer(server)
  }

  return {
    server,
    port,
    // The public TwiML URL that Twilio will fetch (via ngrok)
    twimlUrl: `${ngrokUrl}/twiml`,
    close,
    responsePromise,
  }
}

// Handle the POST /gather webhook from Twilio.
// Twilio sends form-encoded params including SpeechResult (the transcription)
// and Confidence (how confident Twilio is in the transcription).
function handleGatherWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  resolve: (value: string | null) => void
): void {
  let body = ""
  // Collect the request body
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString()
  })
  req.on("end", () => {
    try {
      // Parse form-encoded parameters
      const params = new URLSearchParams(body)
      const speechResult = params.get("SpeechResult")?.trim()
      const confidence = params.get("Confidence")?.trim()
      const callSid = params.get("CallSid")?.trim()
      const unresolved = params.get("UnresolvedSpeech")?.trim()

      debug("audio-server", "gather webhook parsed", { speechResult, confidence, callSid, unresolved })

      if (speechResult) {
        // User spoke and Twilio transcribed it — this is the happy path
        info("audio-server", `user responded: "${speechResult}"`, { confidence, callSid })
        resolve(speechResult)
      } else if (unresolved) {
        // Twilio heard something but couldn't transcribe it
        warn("audio-server", "Twilio returned UnresolvedSpeech — speech not transcribed", { callSid })
        resolve(null)
      } else {
        // Gather timed out with no speech detected
        warn("audio-server", "gather webhook had no SpeechResult or UnresolvedSpeech", { callSid })
        resolve(null)
      }

      // Respond to Twilio with hangup TwiML to end the call
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

// Build the TwiML that tells Twilio to: play the audio, then gather speech.
// The <Gather> wraps <Play> so Twilio starts listening for speech while the
// audio plays. If no speech is detected, it falls through to <Say> + <Hangup>.
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

// Minimal TwiML that just hangs up the call.
function buildHangupTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`
}

// Gracefully close the HTTP server if it's still listening.
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) {
      server.close(() => resolve())
    } else {
      resolve()
    }
  })
}