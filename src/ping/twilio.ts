// Twilio API client — handles placing phone calls, checking call status, and
// sending SMS messages via Twilio's REST API. Uses HTTP Basic auth with the
// account SID and auth token.
//
// Required env vars for call mode:
//   TWILIO_ACCOUNT_SID  — Twilio account SID
//   TWILIO_AUTH_TOKEN   — Twilio auth token
//   TWILIO_FROM_NUMBER  — Twilio phone number to call from
//   TWILIO_TO_NUMBER    — Your phone number to call
// Optional:
//   TWILIO_TIMEOUT      — request timeout in ms (default: 15000)

import { info, error as logError, debug } from "../log"

const DEFAULT_TIMEOUT_MS = 15000

// Validated Twilio configuration loaded from env vars.
export interface TwilioConfig {
  accountSid: string
  authToken: string
  fromNumber: string
  toNumber: string
  timeoutMs?: number
}

// Result of placing a call — the SID is the unique call identifier.
export interface CallResult {
  sid: string
  status: string
}

// Result of sending an SMS — same structure as CallResult.
export interface SmsResult {
  sid: string
  status: string
}

// Read and validate Twilio config from env vars.
// Returns null if any required var is missing (with a debug log of which ones).
export function getTwilioConfig(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim()
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim()
  const fromNumber = process.env.TWILIO_FROM_NUMBER?.trim()
  const toNumber = process.env.TWILIO_TO_NUMBER?.trim()

  // Check all required vars and log which ones are missing
  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    const missing: string[] = []
    if (!accountSid) missing.push("TWILIO_ACCOUNT_SID")
    if (!authToken) missing.push("TWILIO_AUTH_TOKEN")
    if (!fromNumber) missing.push("TWILIO_FROM_NUMBER")
    if (!toNumber) missing.push("TWILIO_TO_NUMBER")
    debug("twilio", `config not complete, missing: ${missing.join(", ")}`)
    return null
  }

  return {
    accountSid,
    authToken,
    fromNumber,
    toNumber,
    timeoutMs: Number(process.env.TWILIO_TIMEOUT) || DEFAULT_TIMEOUT_MS,
  }
}

// Quick check: are all required Twilio env vars set?
export function isTwilioConfigured(): boolean {
  return getTwilioConfig() !== null
}

// Place an outbound phone call via Twilio.
// `twimlUrl` is the URL Twilio will fetch to get the TwiML instructions
// (typically the ngrok URL pointing to the audio server).
export async function placeCall(
  twimlUrl: string,
  config?: TwilioConfig
): Promise<CallResult> {
  const cfg = config ?? getTwilioConfig()
  if (!cfg) throw new Error("Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER")

  const controller = new AbortController()
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Twilio Calls API endpoint
    const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`
    // POST body: who to call, who to call from, and where to fetch TwiML
    const body = new URLSearchParams({
      To: cfg.toNumber,
      From: cfg.fromNumber,
      Url: twimlUrl,
    })

    info("twilio", `placing call to ${cfg.toNumber} from ${cfg.fromNumber}`, { twimlUrl })

    const res = await fetch(url, {
      method: "POST",
      headers: {
        // Twilio uses HTTP Basic auth with SID:token
        Authorization: `Basic ${btoa(`${cfg.accountSid}:${cfg.authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`Twilio responded ${res.status}: ${errBody}`)
    }

    // Parse the call SID and status from the response
    const data = (await res.json()) as { sid?: string; status?: string }
    if (!data.sid) {
      throw new Error(`Twilio response missing call SID: ${JSON.stringify(data)}`)
    }

    info("twilio", `call placed successfully`, { sid: data.sid, status: data.status })
    return { sid: data.sid, status: data.status ?? "unknown" }
  } catch (err) {
    // Convert AbortError to a clearer timeout message
    if (err instanceof Error && err.name === "AbortError") {
      logError("twilio", `call request timed out after ${timeoutMs}ms`)
      throw new Error(`Twilio request timed out after ${timeoutMs}ms`)
    }
    logError("twilio", `call placement failed`, { error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// Poll the status of a call by its SID.
// Returns the status string (e.g. "ringing", "in-progress", "completed", "failed")
// or null if the request fails or Twilio is not configured.
export async function getCallStatus(
  callSid: string,
  config?: TwilioConfig
): Promise<string | null> {
  const cfg = config ?? getTwilioConfig()
  if (!cfg) return null

  try {
    // Twilio Call resource endpoint for a specific call
    const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls/${callSid}.json`
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${btoa(`${cfg.accountSid}:${cfg.authToken}`)}`,
      },
    })

    if (!res.ok) {
      debug("twilio", `getCallStatus got non-OK response`, { callSid, status: res.status })
      return null
    }

    const data = (await res.json()) as { status?: string }
    const status = data.status ?? null
    debug("twilio", `call status polled`, { callSid, status })
    return status
  } catch (err) {
    debug("twilio", `getCallStatus failed`, { callSid, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// Send an SMS via Twilio Messages API.
// Implemented and exported but not used by the main ping flow — Telegram is
// used for text mode instead. Kept for potential future use.
export async function sendSMS(
  message: string,
  config?: TwilioConfig
): Promise<SmsResult> {
  const cfg = config ?? getTwilioConfig()
  if (!cfg) throw new Error("Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER")

  const controller = new AbortController()
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Twilio Messages API endpoint
    const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`
    const body = new URLSearchParams({
      To: cfg.toNumber,
      From: cfg.fromNumber,
      Body: message,
    })

    info("twilio", `sending SMS to ${cfg.toNumber} from ${cfg.fromNumber}`, { messageLength: message.length })

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${cfg.accountSid}:${cfg.authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`Twilio responded ${res.status}: ${errBody}`)
    }

    const data = (await res.json()) as { sid?: string; status?: string }
    if (!data.sid) {
      throw new Error(`Twilio response missing message SID: ${JSON.stringify(data)}`)
    }

    info("twilio", `SMS sent successfully`, { sid: data.sid, status: data.status })
    return { sid: data.sid, status: data.status ?? "unknown" }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logError("twilio", `SMS request timed out after ${timeoutMs}ms`)
      throw new Error(`Twilio request timed out after ${timeoutMs}ms`)
    }
    logError("twilio", `SMS failed`, { error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    clearTimeout(timeout)
  }
}