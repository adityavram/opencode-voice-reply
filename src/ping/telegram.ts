// Telegram Bot API client — sends messages with force_reply and polls for
// the user's reply. Used by the "sms" ping mode and by the "escalate" mode
// (for the initial text before potential call escalation).
//
// Flow: send message → user replies in Telegram → long-poll getUpdates →
// find the reply matching our message ID → return the reply text.
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN — Bot API token from @BotFather
//   TELEGRAM_CHAT_ID   — The chat ID to send messages to
// Optional:
//   TELEGRAM_TIMEOUT   — API request timeout in ms (default: 10000)

import { info, debug, warn, error as logError } from "../log"

const DEFAULT_TIMEOUT_MS = 10000

// Validated Telegram configuration loaded from env vars.
export interface TelegramConfig {
  botToken: string
  chatId: string
  timeoutMs: number
}

// Read and validate Telegram config from env vars.
// Returns null if either required var is missing.
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

// Quick check: are both required Telegram env vars set?
export function isTelegramConfigured(): boolean {
  return getTelegramConfig() !== null
}

// Send a message to the configured Telegram chat with force_reply enabled.
// force_reply makes Telegram prompt the user to reply to this specific message,
// so we can later identify which reply corresponds to our ping.
// Returns the sent message's ID (needed to match the reply later).
export async function sendTelegram(
  message: string,
  cfg?: TelegramConfig
): Promise<number> {
  const c = cfg ?? getTelegramConfig()
  if (!c) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), c.timeoutMs)

  try {
    info("telegram", `sending message to chat ${c.chatId}`, { messageLength: message.length })

    // POST to Telegram Bot API sendMessage endpoint
    const res = await fetch(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: c.chatId,
        text: message,
        // force_reply makes the Telegram client prompt the user to reply
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: "Reply with your instruction to opencode...",
        },
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`Telegram responded ${res.status}: ${errBody}`)
    }

    // Extract the message_id from the response — we need this to match replies
    const data = await res.json() as { ok: boolean; result?: { message_id: number } }
    if (!data.ok || !data.result?.message_id) {
      throw new Error(`Telegram returned ok=false: ${JSON.stringify(data)}`)
    }

    info("telegram", `message sent`, { messageId: data.result.message_id })
    return data.result.message_id
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

// Drain pending Telegram updates so old/stale messages don't interfere with
// the reply polling. Called on plugin startup and before waitForTelegramReply.
// Uses offset=-1 to get only the latest update, then acknowledges it.
export async function clearTelegramUpdates(cfg?: TelegramConfig): Promise<void> {
  const c = cfg ?? getTelegramConfig()
  if (!c) return

  try {
    // Get only the most recent update
    const res = await fetch(`https://api.telegram.org/bot${c.botToken}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset: -1 }),
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) {
      const data = await res.json() as { ok: boolean; result?: Array<{ update_id: number }> }
      if (data.ok && data.result && data.result.length > 0) {
        // Acknowledge the last update by setting offset past it
        const lastUpdate = data.result[data.result.length - 1].update_id
        await fetch(`https://api.telegram.org/bot${c.botToken}/getUpdates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offset: lastUpdate + 1 }),
          signal: AbortSignal.timeout(5_000),
        })
      }
      debug("telegram", "pending updates cleared")
    }
  } catch (err) {
    // Non-fatal — we just might get stale updates, which we filter by message ID
    debug("telegram", `clearUpdates failed (non-fatal)`, { error: err instanceof Error ? err.message : String(err) })
  }
}

// Long-poll Telegram's getUpdates for a reply to a specific message.
// Polls every ~8 seconds (with long-poll timeout) until a reply matching
// `sentMessageId` is found or the overall timeout expires.
// Returns the reply text, or null if no reply within the timeout.
export async function waitForTelegramReply(
  timeoutMs: number,
  sentMessageId: number,
  cfg?: TelegramConfig
): Promise<string | null> {
  const c = cfg ?? getTelegramConfig()
  if (!c) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set")

  // Clear stale updates before we start polling
  await clearTelegramUpdates(c)

  const pollInterval = 3_000 // base long-poll timeout
  const startTime = Date.now()
  let offset: number | undefined // Telegram offset for acknowledging updates

  info("telegram", `polling for reply to message ${sentMessageId} (timeout ${timeoutMs}ms)`)

  // Poll loop: keep calling getUpdates until we find our reply or time out
  while (Date.now() - startTime < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - startTime)
    // Long-poll: ask Telegram to hold the connection for up to pollInterval+5s
    const longPollTimeout = Math.min(remaining, pollInterval + 5_000)

    try {
      const res = await fetch(`https://api.telegram.org/bot${c.botToken}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: Math.floor(longPollTimeout / 1000),
          allowed_updates: ["message"], // only care about messages, not other update types
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

      // Process each update — look for a reply to our specific message
      for (const update of data.result) {
        // Advance the offset so Telegram knows we've seen this update
        offset = update.update_id + 1

        // Filter: must be from our chat
        if (update.message?.chat?.id !== Number(c.chatId)) continue
        // Filter: must have text content
        if (!update.message.text) continue

        // Filter: must be a reply to our sent message (not some other message)
        const replyTo = update.message.reply_to_message?.message_id
        if (replyTo !== sentMessageId) {
          debug("telegram", `ignoring message not replying to our ping`, { replyTo, expected: sentMessageId })
          continue
        }

        // Found our reply!
        const text = update.message.text.trim()
        if (!text) continue

        info("telegram", `reply received: "${text.slice(0, 100)}"`)
        return text
      }
    } catch (err) {
      // Long-poll timeouts are expected — just continue polling
      if (err instanceof Error && err.name === "TimeoutError") {
        debug("telegram", "getUpdates long poll timed out, continuing")
        continue
      }
      // Other errors: brief pause before retrying
      debug("telegram", `polling error`, { error: err instanceof Error ? err.message : String(err) })
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }

  warn("telegram", `no reply received within ${timeoutMs}ms`)
  return null
}