// Phone ping orchestrator — coordinates the three ping modes:
//   - textPing(): Telegram text message → poll for reply → inject into session
//   - pingPhone(): ElevenLabs audio → Twilio call → capture speech → inject
//   - pingWithEscalation(): text first → if high urgency & no reply, escalate to call
//
// All modes ultimately inject the user's response back into the opencode session
// via client.session.promptAsync(), so the agent can act on the user's reply
// without them being at the keyboard.

import { synthesize } from "../tts/elevenlabs"
import { getNgrokUrl, startAudioServer } from "./audio-server"
import { placeCall, getCallStatus, getTwilioConfig, type CallResult, type TwilioConfig } from "./twilio"
import { sendTelegram, waitForTelegramReply, isTelegramConfigured } from "./telegram"
import { summarize, summarizeForText } from "../summarize"
import { classifyUrgency, type Urgency } from "./urgency"
import { info, debug, warn, error as logError } from "../log"

// Re-export key functions so callers can import everything from one place
export { getNgrokUrl } from "./audio-server"
export { isTwilioConfigured } from "./twilio"
export { classifyUrgency, type Urgency } from "./urgency"
export { isTelegramConfigured, sendTelegram, waitForTelegramReply, clearTelegramUpdates } from "./telegram"

// All ping messages are prefixed with this so the user knows it's from opencode
// (unless the text already starts with "opencode:")
const PING_PREFIX = "OpenCode: "

// Minimal interface for the opencode SDK client — we only use a few methods.
// This is cast from the actual client in plugin.ts.
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

// Common options for phone ping (call mode).
export interface PingOptions {
  text: string
  summarizeFirst?: boolean // if true, summarize the text before synthesizing audio
  sessionId?: string       // session to inject the user's reply into
  client?: PingClient      // opencode SDK client for injection
}

// Result of a phone ping.
export interface PingResult {
  call: CallResult
  summary: string       // the text that was spoken (after summarization if any)
  spokenText: string    // same as summary (kept for clarity in the return shape)
  userResponse: string | null // the user's transcribed reply, or null if none
}

// Options for text ping (Telegram mode).
export interface TextPingOptions {
  text: string
  sessionId?: string
  client?: PingClient
  replyTimeoutMs?: number // how long to wait for a Telegram reply
}

// Result of a text ping.
export interface TextPingResult {
  sent: boolean
  userResponse: string | null
}

// === TEXT PING (Telegram) ===
// Sends a Telegram message with force_reply, waits for the user to reply,
// and injects the reply into the opencode session.
export async function textPing(opts: TextPingOptions): Promise<TextPingResult> {
  let message = opts.text.trim()
  if (!message) throw new Error("text ping message is empty")

  // Add "OpenCode: " prefix unless the text already starts with it
  if (!message.toLowerCase().startsWith("opencode:")) {
    message = PING_PREFIX + message
  }

  // Step 1: Send the Telegram message (returns the message ID for reply matching)
  const sentMessageId = await sendTelegram(message)
  info("ping", "text ping sent via Telegram", { messageId: sentMessageId })

  // Step 2: If we have a session + client, wait for the user's reply and inject it
  if (opts.sessionId && opts.client) {
    const replyTimeoutMs = opts.replyTimeoutMs ?? (Number(process.env.OCODE_VOICE_TEXT_REPLY_TIMEOUT) || 120_000)
    info("ping", `waiting for Telegram reply (timeout ${replyTimeoutMs}ms)`, { sessionId: opts.sessionId })

    // Long-poll Telegram for a reply to our specific message
    const userResponse = await waitForTelegramReply(replyTimeoutMs, sentMessageId)

    if (userResponse) {
      info("ping", "Telegram reply received, injecting into session", { response: userResponse.slice(0, 100), sessionId: opts.sessionId })
      // Inject the reply as a synthetic user message into the opencode session
      try {
        await opts.client.session.promptAsync({
          path: { id: opts.sessionId },
          body: {
            parts: [{ type: "text", text: userResponse, synthetic: true }],
          },
        })
        info("ping", "Telegram reply injected successfully")
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logError("ping", `failed to inject Telegram reply into session: ${msg}`)
      }
      return { sent: true, userResponse }
    }

    // No reply within timeout
    warn("ping", "no Telegram reply received within timeout")
    return { sent: true, userResponse: null }
  }

  // No session/client — just send the message, don't wait for a reply
  return { sent: true, userResponse: null }
}

// === PHONE PING (Twilio call) ===
// Full flow: synthesize audio → start HTTP server → place Twilio call →
// Twilio plays audio + gathers speech → receive transcription → inject into session.
export async function pingPhone(opts: PingOptions): Promise<PingResult> {
  info("ping", "pingPhone started", {
    textLength: opts.text.length,
    summarizeFirst: opts.summarizeFirst,
    sessionId: opts.sessionId,
    hasClient: !!opts.client,
  })

  // Validate: ngrok URL must be set (Twilio needs a public URL to fetch TwiML)
  const ngrokUrl = getNgrokUrl()
  if (!ngrokUrl) {
    logError("ping", "OCODE_VOICE_NGROK_URL is not set")
    throw new Error("OCODE_VOICE_NGROK_URL is not set — start ngrok (e.g. ngrok http 8088) and set this env var to the forwarding URL")
  }

  // Validate: Twilio credentials must be configured
  const twilioConfig = getTwilioConfig()
  if (!twilioConfig) {
    logError("ping", "Twilio is not configured")
    throw new Error("Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER")
  }

  // Prepare the text to be spoken — optionally summarize it first
  let spokenText = opts.text.trim()
  if (!spokenText) {
    warn("ping", "ping text is empty")
    throw new Error("ping text is empty")
  }

  // If summarizeFirst is set, run the text through the summarizer to keep
  // the call audio concise (important for phone calls)
  if (opts.summarizeFirst) {
    info("ping", "summarizing text before synthesis")
    const summarized = await summarize(spokenText)
    if (summarized) {
      debug("ping", "summarized", { originalLength: spokenText.length, summarizedLength: summarized.length })
      spokenText = summarized
    }
  }

  // Add "OpenCode: " prefix unless the text already has it
  if (!spokenText.toLowerCase().startsWith("opencode needs")) {
    spokenText = PING_PREFIX + spokenText
  }

  // Step 1: Synthesize the text to audio bytes using ElevenLabs
  info("ping", "synthesizing audio with ElevenLabs", { textLength: spokenText.length })
  const audioBuffer = await synthesize(spokenText)
  info("ping", "audio synthesized", { audioBytes: audioBuffer.byteLength })

  // Step 2: Start the ephemeral HTTP server (serves TwiML + audio to Twilio)
  info("ping", "starting audio server", { ngrokUrl })
  const audioServer = await startAudioServer({
    ngrokUrl,
    audioBuffer,
  })

  // Step 3: Place the Twilio call — Twilio will fetch TwiML from the audio server
  let call: CallResult
  try {
    call = await placeCall(audioServer.twimlUrl, twilioConfig)
  } catch (err) {
    // Call failed — close the audio server before re-throwing
    logError("ping", "placeCall failed, closing audio server", { error: err instanceof Error ? err.message : String(err) })
    await audioServer.close()
    throw err
  }

  // Step 4: Wait for the user's spoken response (via the Gather webhook)
  info("ping", "call placed, awaiting user response", { callSid: call.sid })
  // Schedule a backup cleanup that polls Twilio call status — in case the
  // webhook never fires (e.g., call fails to connect)
  const cleanupInterval = scheduleCallStatusCleanup(audioServer, call.sid, twilioConfig)

  // This promise resolves when Twilio sends the Gather webhook with the
  // transcribed speech, or null on timeout/no speech
  const userResponse = await audioServer.responsePromise

  // Clean up: clear the status polling interval and close the HTTP server
  if (cleanupInterval) clearInterval(cleanupInterval)
  await audioServer.close()

  if (userResponse) {
    info("ping", "user responded", { response: userResponse, sessionId: opts.sessionId })
  } else {
    warn("ping", "no user response received (timeout or no speech)")
  }

  // Step 5: Inject the user's response into the opencode session
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
      // Log the error to the opencode app log as well
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

// === ESCALATION PING (text first, call if high urgency & no reply) ===
// Options for the escalation flow.
export interface EscalationOptions {
  text: string
  summarizeFirst?: boolean
  sessionId?: string
  client?: PingClient
  escalationTimeoutMs?: number // how long to wait for text reply before calling
}

// Result of the escalation flow.
export interface EscalationResult {
  urgency: Urgency
  smsSent: boolean
  callEscalated: boolean
  callResult?: PingResult
}

// Escalation flow:
// 1. Classify urgency (heuristic first, LLM if ambiguous)
// 2. Summarize text if requested (uses text style for Telegram)
// 3. Send Telegram text ping
// 4. If user replies → done (no call needed)
// 5. If low urgency → done (text is sufficient)
// 6. If high urgency & no reply within timeout → escalate to phone call
export async function pingWithEscalation(opts: EscalationOptions): Promise<EscalationResult> {
  const escalationTimeoutMs = opts.escalationTimeoutMs ?? (Number(process.env.OCODE_VOICE_PING_ESCALATION_TIMEOUT) || 60_000)

  info("ping", "escalation flow started", { textLength: opts.text.length, escalationTimeoutMs })

  // Step 1: Classify urgency to decide whether escalation to a call is warranted
  const urgency = await classifyUrgency(opts.text)
  info("ping", `urgency classified: ${urgency}`, { text: opts.text.slice(0, 100) })

  // Step 2: Optionally summarize the text (text style = longer, third person)
  let smsText = opts.text
  if (opts.summarizeFirst) {
    const summarized = await summarizeForText(opts.text)
    if (summarized) smsText = summarized
  }

  // Add "OpenCode: " prefix
  if (!smsText.toLowerCase().startsWith("opencode:")) {
    smsText = PING_PREFIX + smsText
  }

  // Step 3: Send the Telegram text ping
  let smsResult = false
  try {
    const result = await textPing({
      text: smsText,
      sessionId: opts.sessionId,
      client: opts.client,
    })
    smsResult = result.sent
    // Step 4: User replied via text — no need to escalate to a call
    if (result.userResponse) {
      info("ping", "user replied via text, skipping call escalation")
      return { urgency, smsSent: smsResult, callEscalated: false }
    }
  } catch (err) {
    logError("ping", `escalation text ping failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Step 5: Low urgency — text is sufficient, no escalation needed
  if (urgency === "low") {
    info("ping", "low urgency — text sent, no escalation")
    return { urgency, smsSent: smsResult, callEscalated: false }
  }

  // Step 6: High urgency & no text reply — wait, then escalate to a phone call
  info("ping", `high urgency — SMS sent, waiting ${escalationTimeoutMs}ms before escalating to call`)

  // Give the user time to reply to the text before calling
  await new Promise((resolve) => setTimeout(resolve, escalationTimeoutMs))

  // Check if ngrok is available (needed for the call)
  const ngrokUrl = getNgrokUrl()
  if (!ngrokUrl) {
    warn("ping", "cannot escalate to call — ngrok URL not set")
    return { urgency, smsSent: smsResult, callEscalated: false }
  }

  // Escalate to a phone call
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

// Backup cleanup mechanism — polls Twilio call status every 5 seconds.
// If the call ends (completed/failed/canceled/no-answer/busy) and the Gather
// webhook hasn't fired, this closes the audio server so it doesn't hang.
// Also has a hard max wait of 120s.
function scheduleCallStatusCleanup(
  audioServer: { close: () => Promise<void> },
  callSid: string,
  config: TwilioConfig
): NodeJS.Timeout | null {
  const checkInterval = 5_000 // poll every 5 seconds
  const maxWait = 120_000     // hard cap on how long we poll
  let elapsed = 0

  debug("ping", "scheduling call status cleanup", { callSid, checkInterval, maxWait })

  const interval = setInterval(async () => {
    elapsed += checkInterval
    // Hard timeout — close regardless of call status
    if (elapsed >= maxWait) {
      warn("ping", `cleanup max wait reached (${maxWait}ms), closing`, { callSid })
      clearInterval(interval)
      await audioServer.close()
      return
    }

    // Poll Twilio for the call status
    const status = await getCallStatus(callSid, config)
    // Terminal states — the call is over, close the server
    if (status && (status === "completed" || status === "failed" || status === "canceled" || status === "no-answer" || status === "busy")) {
      info("ping", `call ended: ${status}, closing audio server`, { callSid })
      clearInterval(interval)
      await audioServer.close()
    }
  }, checkInterval)
  return interval
}