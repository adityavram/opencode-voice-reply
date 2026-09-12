import { info, debug, warn, error as logError } from "../log"

const DEFAULT_TIMEOUT_MS = 10000

export interface TelegramConfig {
  botToken: string
  chatId: string
  timeoutMs: number
}

export function getTelegramConfig(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  if (!botToken || !chatId) return null

  return {
    botToken,
    chatId,
    timeoutMs: Number(process.env.TELEGRAM_TIMEOUT) || DEFAULT_TIMEOUT_MS,
  }
}

export function isTelegramConfigured(): boolean {
  return getTelegramConfig() !== null
}

export async function sendTelegram(
  message: string,
  cfg?: TelegramConfig
): Promise<void> {
  const c = cfg ?? getTelegramConfig()
  if (!c) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), c.timeoutMs)

  try {
    info("telegram", `sending message to chat ${c.chatId}`, { messageLength: message.length })

    const res = await fetch(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: c.chatId,
        text: message,
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "Reply with your instruction to opencode...",
        },
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`Telegram responded ${res.status}: ${errBody}`)
    }

    const data = await res.json() as { ok: boolean; result?: { message_id: number } }
    if (!data.ok) {
      throw new Error(`Telegram returned ok=false: ${JSON.stringify(data)}`)
    }

    info("telegram", `message sent`, { messageId: data.result?.message_id })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logError("telegram", `request timed out after ${c.timeoutMs}ms`)
      throw new Error(`Telegram request timed out after ${c.timeoutMs}ms`)
    }
    logError("telegram", `send failed`, { error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export async function waitForTelegramReply(
  timeoutMs: number,
  cfg?: TelegramConfig
): Promise<string | null> {
  const c = cfg ?? getTelegramConfig()
  if (!c) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set")

  const pollInterval = 3_000
  const startTime = Date.now()
  let offset: number | undefined

  info("telegram", `polling for reply (timeout ${timeoutMs}ms)`)

  while (Date.now() - startTime < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - startTime)
    const longPollTimeout = Math.min(remaining, pollInterval + 5_000)

    try {
      const res = await fetch(`https://api.telegram.org/bot${c.botToken}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: Math.floor(longPollTimeout / 1000),
          allowed_updates: ["message"],
        }),
        signal: AbortSignal.timeout(longPollTimeout + 2_000),
      })

      if (!res.ok) {
        debug("telegram", `getUpdates returned ${res.status}`)
        continue
      }

      const data = await res.json() as {
        ok: boolean
        result?: Array<{
          update_id: number
          message?: {
            chat: { id: number }
            text?: string
            reply_to_message?: { message_id: number }
          }
        }>
      }

      if (!data.ok || !data.result || data.result.length === 0) continue

      for (const update of data.result) {
        offset = update.update_id + 1

        if (update.message?.chat?.id !== Number(c.chatId)) continue
        if (!update.message.text) continue

        const text = update.message.text.trim()
        if (!text) continue

        info("telegram", `reply received: "${text.slice(0, 100)}"`)
        return text
      }
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        debug("telegram", "getUpdates long poll timed out, continuing")
        continue
      }
      debug("telegram", `polling error`, { error: err instanceof Error ? err.message : String(err) })
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }

  warn("telegram", `no reply received within ${timeoutMs}ms`)
  return null
}