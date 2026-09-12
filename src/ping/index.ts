import { synthesize } from "../tts/elevenlabs"
import { getNgrokUrl, startAudioServer } from "./audio-server"
import { placeCall, getCallStatus, getTwilioConfig, type CallResult, type TwilioConfig } from "./twilio"
import { sendTelegram, waitForTelegramReply, isTelegramConfigured } from "./telegram"
import { summarize, summarizeForText } from "../summarize"
import { classifyUrgency, type Urgency } from "./urgency"
import { info, debug, warn, error as logError } from "../log"

export { getNgrokUrl } from "./audio-server"
export { isTwilioConfigured } from "./twilio"
export { classifyUrgency, type Urgency } from "./urgency"
export { isTelegramConfigured, sendTelegram, waitForTelegramReply, clearTelegramUpdates } from "./telegram"

const PING_PREFIX = "OpenCode: "

export interface PingClient {
  session: {
    promptAsync: (options: {
      path: { id: string }
      body: {
        parts: Array<{ type: "text"; text: string; synthetic?: boolean }>
      }
    }) => Promise<unknown>
    prompt: (options: {
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

export interface TextPingOptions {
  text: string
  sessionId?: string
  client?: PingClient
  replyTimeoutMs?: number
}

export interface TextPingResult {
  sent: boolean
  userResponse: string | null
}

export async function textPing(opts: TextPingOptions): Promise<TextPingResult> {
  let message = opts.text.trim()
  if (!message) throw new Error("text ping message is empty")

  if (!message.toLowerCase().startsWith("opencode:")) {
    message = PING_PREFIX + message
  }

  const sentMessageId = await sendTelegram(message)
  info("ping", "text ping sent via Telegram", { messageId: sentMessageId })

  if (opts.sessionId && opts.client) {
    const replyTimeoutMs = opts.replyTimeoutMs ?? (Number(process.env.OCODE_VOICE_TEXT_REPLY_TIMEOUT) || 120_000)
    info("ping", `waiting for Telegram reply (timeout ${replyTimeoutMs}ms)`, { sessionId: opts.sessionId })

    const userResponse = await waitForTelegramReply(replyTimeoutMs, sentMessageId)

    if (userResponse) {
      info("ping", "Telegram reply received, injecting into session", { response: userResponse.slice(0, 100), sessionId: opts.sessionId })
      try {
        const result = await opts.client.session.promptAsync({
          path: { id: opts.sessionId },
          body: {
            parts: [{ type: "text", text: userResponse, synthetic: true }],
          },
        })
        info("ping", "Telegram reply injected successfully", { result: JSON.stringify(result).slice(0, 200) })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logError("ping", `failed to inject Telegram reply into session: ${msg}`)
        try {
          const result2 = await opts.client.session.prompt({
            path: { id: opts.sessionId },
            body: {
              parts: [{ type: "text", text: userResponse, synthetic: true }],
            },
          })
          info("ping", "Telegram reply injected via prompt() fallback", { result: JSON.stringify(result2).slice(0, 200) })
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2)
          logError("ping", `prompt() fallback also failed: ${msg2}`)
        }
      }
      return { sent: true, userResponse }
    }

    warn("ping", "no Telegram reply received within timeout")
    return { sent: true, userResponse: null }
  }

  return { sent: true, userResponse: null }
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

export interface EscalationOptions {
  text: string
  summarizeFirst?: boolean
  sessionId?: string
  client?: PingClient
  escalationTimeoutMs?: number
}

export interface EscalationResult {
  urgency: Urgency
  smsSent: boolean
  callEscalated: boolean
  callResult?: PingResult
}

export async function pingWithEscalation(opts: EscalationOptions): Promise<EscalationResult> {
  const escalationTimeoutMs = opts.escalationTimeoutMs ?? (Number(process.env.OCODE_VOICE_PING_ESCALATION_TIMEOUT) || 60_000)

  info("ping", "escalation flow started", { textLength: opts.text.length, escalationTimeoutMs })

  const urgency = await classifyUrgency(opts.text)
  info("ping", `urgency classified: ${urgency}`, { text: opts.text.slice(0, 100) })

  let smsText = opts.text
  if (opts.summarizeFirst) {
    const summarized = await summarizeForText(opts.text)
    if (summarized) smsText = summarized
  }

  if (!smsText.toLowerCase().startsWith("opencode:")) {
    smsText = PING_PREFIX + smsText
  }

  let smsResult = false
  try {
    const result = await textPing({
      text: smsText,
      sessionId: opts.sessionId,
      client: opts.client,
    })
    smsResult = result.sent
    if (result.userResponse) {
      info("ping", "user replied via text, skipping call escalation")
      return { urgency, smsSent: smsResult, callEscalated: false }
    }
  } catch (err) {
    logError("ping", `escalation text ping failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (urgency === "low") {
    info("ping", "low urgency — text sent, no escalation")
    return { urgency, smsSent: smsResult, callEscalated: false }
  }

  info("ping", `high urgency — SMS sent, waiting ${escalationTimeoutMs}ms before escalating to call`)

  await new Promise((resolve) => setTimeout(resolve, escalationTimeoutMs))

  const ngrokUrl = getNgrokUrl()
  if (!ngrokUrl) {
    warn("ping", "cannot escalate to call — ngrok URL not set")
    return { urgency, smsSent: smsResult, callEscalated: false }
  }

  info("ping", "escalating to phone call")
  try {
    const callResult = await pingPhone({
      text: opts.text,
      summarizeFirst: opts.summarizeFirst,
      sessionId: opts.sessionId,
      client: opts.client,
    })
    return { urgency, smsSent: smsResult, callEscalated: true, callResult }
  } catch (err) {
    logError("ping", `escalation call failed: ${err instanceof Error ? err.message : String(err)}`)
    return { urgency, smsSent: smsResult, callEscalated: false }
  }
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