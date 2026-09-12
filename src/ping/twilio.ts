import { info, error as logError, debug } from "../log"

const DEFAULT_TIMEOUT_MS = 15000

export interface TwilioConfig {
  accountSid: string
  authToken: string
  fromNumber: string
  toNumber: string
  timeoutMs?: number
}

export interface CallResult {
  sid: string
  status: string
}

export interface SmsResult {
  sid: string
  status: string
}

export function getTwilioConfig(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim()
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim()
  const fromNumber = process.env.TWILIO_FROM_NUMBER?.trim()
  const toNumber = process.env.TWILIO_TO_NUMBER?.trim()

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

export function isTwilioConfigured(): boolean {
  return getTwilioConfig() !== null
}

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
    const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`
    const body = new URLSearchParams({
      To: cfg.toNumber,
      From: cfg.fromNumber,
      Url: twimlUrl,
    })

    info("twilio", `placing call to ${cfg.toNumber} from ${cfg.fromNumber}`, { twimlUrl })

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
      throw new Error(`Twilio response missing call SID: ${JSON.stringify(data)}`)
    }

    info("twilio", `call placed successfully`, { sid: data.sid, status: data.status })
    return { sid: data.sid, status: data.status ?? "unknown" }
  } catch (err) {
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

export async function getCallStatus(
  callSid: string,
  config?: TwilioConfig
): Promise<string | null> {
  const cfg = config ?? getTwilioConfig()
  if (!cfg) return null

  try {
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