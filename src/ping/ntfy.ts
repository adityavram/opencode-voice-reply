// ntfy notification client — sends push notifications via ntfy.sh.
// Implemented and exported but NOT wired into the main ping flow.
// Kept as an alternative notification channel for future use.
//
// Required env vars:
//   OCODE_VOICE_NTFY_TOPIC — ntfy.sh topic name (choose any unique string)
// Optional:
//   OCODE_VOICE_NTFY_URL   — ntfy server URL (default: https://ntfy.sh)
//   OCODE_VOICE_NTFY_TIMEOUT — request timeout in ms (default: 10000)

import { info, error as logError } from "../log"

const DEFAULT_NTFY_URL = "https://ntfy.sh"
const DEFAULT_TIMEOUT_MS = 10000

// Read ntfy config from env vars. Returns null if the topic is not set.
export function getNtfyConfig(): { url: string; topic: string; timeoutMs: number } | null {
  const topic = process.env.OCODE_VOICE_NTFY_TOPIC?.trim()
  if (!topic) return null

  return {
    url: process.env.OCODE_VOICE_NTFY_URL?.trim()?.replace(/\/$/, "") || DEFAULT_NTFY_URL,
    topic,
    timeoutMs: Number(process.env.OCODE_VOICE_NTFY_TIMEOUT) || DEFAULT_TIMEOUT_MS,
  }
}

// Quick check: is ntfy configured (topic set)?
export function isNtfyConfigured(): boolean {
  return getNtfyConfig() !== null
}

// Send a push notification via ntfy. The message body is the notification text.
// An optional title can be set via the Title header.
export async function sendNtfy(
  message: string,
  title?: string
): Promise<void> {
  const cfg = getNtfyConfig()
  if (!cfg) throw new Error("OCODE_VOICE_NTFY_TOPIC is not set — choose a topic name and install the ntfy app")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs)

  try {
    info("ntfy", `sending notification to topic "${cfg.topic}"`, { messageLength: message.length })

    // ntfy uses a simple POST to the topic URL with the message as the body.
    // Optional Title header sets the notification title.
    const headers: Record<string, string> = {}
    if (title) headers["Title"] = title

    const res = await fetch(`${cfg.url}/${cfg.topic}`, {
      method: "POST",
      headers,
      body: message,
      signal: controller.signal,
    })

    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`ntfy responded ${res.status}: ${errBody}`)
    }

    info("ntfy", `notification sent successfully`)
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logError("ntfy", `request timed out after ${cfg.timeoutMs}ms`)
      throw new Error(`ntfy request timed out after ${cfg.timeoutMs}ms`)
    }
    logError("ntfy", `send failed`, { error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    clearTimeout(timeout)
  }
}