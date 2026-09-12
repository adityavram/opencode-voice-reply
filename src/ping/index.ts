import { synthesize } from "../tts/elevenlabs"
import { getNgrokUrl, startAudioServer } from "./audio-server"
import { placeCall, getCallStatus, getTwilioConfig, type CallResult, type TwilioConfig } from "./twilio"
import { summarize } from "../summarize"
import { info, debug, warn, error as logError } from "../log"

export { getNgrokUrl } from "./audio-server"
export { isTwilioConfigured } from "./twilio"

const PING_PREFIX = "opencode needs your attention. "

export interface PingClient {
  session: {
    promptAsync: (options: {
      path: { id: string }
      body: {
        parts: Array<{ type: "text"; text: string; synthetic?: boolean }>
      }
    }) => Promise<unknown>
  }
  app: {
    log: (options: { body: { service: string; level: string; message: string } }) => Promise<unknown>
  }
  tui: {
    showToast: (options: { body: { title: string; message: string; variant: string } }) => Promise<unknown>
  }
}

export interface PingOptions {
  text: string
  summarizeFirst?: boolean
  sessionId?: string
  client?: PingClient
}

export interface PingResult {
  call: CallResult
  summary: string
  spokenText: string
  userResponse: string | null
}

export async function pingPhone(opts: PingOptions): Promise<PingResult> {
  info("ping", "pingPhone started", {
    textLength: opts.text.length,
    summarizeFirst: opts.summarizeFirst,
    sessionId: opts.sessionId,
    hasClient: !!opts.client,
  })

  const ngrokUrl = getNgrokUrl()
  if (!ngrokUrl) {
    logError("ping", "OCODE_VOICE_NGROK_URL is not set")
    throw new Error("OCODE_VOICE_NGROK_URL is not set — start ngrok (e.g. ngrok http 8088) and set this env var to the forwarding URL")
  }

  const twilioConfig = getTwilioConfig()
  if (!twilioConfig) {
    logError("ping", "Twilio is not configured")
    throw new Error("Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER")
  }

  let spokenText = opts.text.trim()
  if (!spokenText) {
    warn("ping", "ping text is empty")
    throw new Error("ping text is empty")
  }

  if (opts.summarizeFirst) {
    info("ping", "summarizing text before synthesis")
    const summarized = await summarize(spokenText)
    if (summarized) {
      debug("ping", "summarized", { originalLength: spokenText.length, summarizedLength: summarized.length })
      spokenText = summarized
    }
  }

  if (!spokenText.toLowerCase().startsWith("opencode needs")) {
    spokenText = PING_PREFIX + spokenText
  }

  info("ping", "synthesizing audio with ElevenLabs", { textLength: spokenText.length })
  const audioBuffer = await synthesize(spokenText)
  info("ping", "audio synthesized", { audioBytes: audioBuffer.byteLength })

  info("ping", "starting audio server", { ngrokUrl })
  const audioServer = await startAudioServer({
    ngrokUrl,
    audioBuffer,
  })

  let call: CallResult
  try {
    call = await placeCall(audioServer.twimlUrl, twilioConfig)
  } catch (err) {
    logError("ping", "placeCall failed, closing audio server", { error: err instanceof Error ? err.message : String(err) })
    await audioServer.close()
    throw err
  }

  info("ping", "call placed, awaiting user response", { callSid: call.sid })
  const cleanupInterval = scheduleCallStatusCleanup(audioServer, call.sid, twilioConfig)

  const userResponse = await audioServer.responsePromise

  if (cleanupInterval) clearInterval(cleanupInterval)
  await audioServer.close()

  if (userResponse) {
    info("ping", "user responded", { response: userResponse, sessionId: opts.sessionId })
  } else {
    warn("ping", "no user response received (timeout or no speech)")
  }

  if (userResponse && opts.sessionId && opts.client) {
    try {
      info("ping", "injecting response into session", { sessionId: opts.sessionId, response: userResponse.slice(0, 100) })
      await opts.client.session.promptAsync({
        path: { id: opts.sessionId },
        body: {
          parts: [{ type: "text", text: userResponse, synthetic: true }],
        },
      })
      info("ping", "response injected successfully")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logError("ping", "failed to inject response into session", { error: msg, sessionId: opts.sessionId })
      try {
        await opts.client.app.log({
          body: {
            service: "voice-reply",
            level: "error",
            message: `Failed to inject voice response into session: ${msg}`,
          },
        })
      } catch {}
    }
  } else if (!userResponse) {
    debug("ping", "skipping injection — no user response")
  } else if (!opts.sessionId) {
    warn("ping", "skipping injection — no session ID available")
  } else if (!opts.client) {
    warn("ping", "skipping injection — no client available")
  }

  info("ping", "pingPhone complete", { callSid: call.sid, hadResponse: !!userResponse })
  return { call, summary: spokenText, spokenText, userResponse }
}

function scheduleCallStatusCleanup(
  audioServer: { close: () => Promise<void> },
  callSid: string,
  config: TwilioConfig
): NodeJS.Timeout | null {
  const checkInterval = 5_000
  const maxWait = 120_000
  let elapsed = 0

  debug("ping", "scheduling call status cleanup", { callSid, checkInterval, maxWait })

  const interval = setInterval(async () => {
    elapsed += checkInterval
    if (elapsed >= maxWait) {
      warn("ping", `cleanup max wait reached (${maxWait}ms), closing`, { callSid })
      clearInterval(interval)
      await audioServer.close()
      return
    }

    const status = await getCallStatus(callSid, config)
    if (status && (status === "completed" || status === "failed" || status === "canceled" || status === "no-answer" || status === "busy")) {
      info("ping", `call ended: ${status}, closing audio server`, { callSid })
      clearInterval(interval)
      await audioServer.close()
    }
  }, checkInterval)
  return interval
}