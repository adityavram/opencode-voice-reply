import { info, error as logError } from "../log"

const DEFAULT_NTFY_URL = "https://ntfy.sh"
const DEFAULT_TIMEOUT_MS = 10000

export function getNtfyConfig(): { url: string; topic: string; timeoutMs: number } | null {
  const topic = process.env.OCODE_VOICE_NTFY_TOPIC?.trim()
  if (!topic) return null

  return {
    url: process.env.OCODE_VOICE_NTFY_URL?.trim()?.replace(/\/$/, "") || DEFAULT_NTFY_URL,
    topic,
    timeoutMs: Number(process.env.OCODE_VOICE_NTFY_TIMEOUT) || DEFAULT_TIMEOUT_MS,
  }
}

export function isNtfyConfigured(): boolean {
  return getNtfyConfig() !== null
}

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