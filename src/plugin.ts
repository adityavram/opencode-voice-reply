import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { readdirSync, watch } from "fs"
import path from "path"
import os from "os"

import { loadPluginEnv } from "./env"
loadPluginEnv()

import { summarize } from "./summarize"
import { speak, stop } from "./tts"
import { isVoiceDisabled, toggleVoice, setVoiceDisabled, isPingDisabled, togglePing, setPingDisabled, getPingMode, setPingMode, type PingMode } from "./state"
import { pingPhone, textPing, pingWithEscalation, getNgrokUrl, isTwilioConfigured, isTelegramConfigured } from "./ping"
import { info, debug, warn, error as logError } from "./log"

const WILLOW_RECORDINGS_DIR = path.join(
  os.homedir(),
  "Library/Application Support/com.seewillow.WillowMac/Recordings"
)

const INTERRUPT_COMMANDS = new Set(["session.interrupt", "prompt.submit"])

export const VoiceReplyPlugin: Plugin = async ({ client }) => {
  const knownRecordings = new Set<string>(listRecordings())
  let activeSessionId: string | undefined
  let pingInFlight = false
  let idlePingTimer: ReturnType<typeof setTimeout> | null = null

  const watcher = tryWatchWillowRecordings(() => {
    const current = listRecordings()
    const newFiles = current.filter((f) => !knownRecordings.has(f))
    if (newFiles.length > 0) {
      for (const f of current) knownRecordings.add(f)
      interruptSpeech(client, "Willow Voice recording started")
    }
  })

  return {
    "command.execute.before": async (input, output) => {
      if (input.command === "voice") {
        const arg = input.arguments.trim().toLowerCase()
        let enabled: boolean
        let message: string

        if (arg === "on" || arg === "enable" || arg === "true") {
          setVoiceDisabled(false)
          enabled = true
          message = "Voice reply enabled."
        } else if (arg === "off" || arg === "disable" || arg === "false") {
          setVoiceDisabled(true)
          stop()
          enabled = false
          message = "Voice reply disabled."
        } else {
          enabled = toggleVoice()
          message = enabled ? "Voice reply enabled." : "Voice reply disabled."
          if (!enabled) stop()
        }

        output.parts.push({
          type: "text",
          text: message,
        } as any)

        await client.tui.showToast({
          body: {
            title: "Voice Reply",
            message,
            variant: enabled ? "success" : "info",
          },
        })
        return
      }

      if (input.command === "ping") {
        const arg = input.arguments.trim().toLowerCase()

        if (arg === "sms" || arg === "text") {
          setPingMode("sms")
          const message = `Ping mode set to text (Telegram).${isPingDisabled() ? " Ping is currently disabled — use /ping on to enable." : ""}${!isTelegramConfigured() ? " WARNING: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env" : ""}`
          output.parts.push({ type: "text", text: message } as any)
          await client.tui.showToast({ body: { title: "Phone Ping", message, variant: "info" } })
          return
        }

        if (arg === "call" || arg === "voice") {
          setPingMode("call")
          const message = `Ping mode set to call (voice).${isPingDisabled() ? " Ping is currently disabled — use /ping on to enable." : ""}`
          output.parts.push({ type: "text", text: message } as any)
          await client.tui.showToast({ body: { title: "Phone Ping", message, variant: "info" } })
          return
        }

        if (arg === "escalate" || arg === "auto") {
          setPingMode("escalate")
          let message = `Ping mode set to escalate (text first, call if high urgency).${isPingDisabled() ? " Ping is currently disabled — use /ping on to enable." : ""}`
          if (!getNgrokUrl()) {
            message += ` WARNING: missing OCODE_VOICE_NGROK_URL — escalation to call won't work. Text will still send.`
          }
          if (!isTelegramConfigured()) {
            message += ` WARNING: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env for text ping.`
          }
          output.parts.push({ type: "text", text: message } as any)
          await client.tui.showToast({ body: { title: "Phone Ping", message, variant: "info" } })
          return
        }

        let enabled: boolean
        let message: string

        if (arg === "on" || arg === "enable" || arg === "true") {
          setPingDisabled(false)
          enabled = true
          message = "Phone ping enabled."
        } else if (arg === "off" || arg === "disable" || arg === "false") {
          setPingDisabled(true)
          enabled = false
          message = "Phone ping disabled."
        } else {
          enabled = togglePing()
          message = enabled ? "Phone ping enabled." : "Phone ping disabled."
        }

        const mode = getPingMode()
        message += ` Mode: ${mode}.`

        if (enabled) {
          if (mode === "sms") {
            if (!isTelegramConfigured()) {
              message += ` WARNING: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env for text ping.`
            }
          } else if (mode === "call" || mode === "escalate") {
            const twilioOk = isTwilioConfigured()
            if (!twilioOk) {
              message += ` WARNING: missing TWILIO_* credentials — call${mode === "escalate" ? "/escalation" : ""} needs Twilio.`
            } else {
              const ngrokOk = getNgrokUrl() !== null
              if (!ngrokOk) {
                message += ` WARNING: missing OCODE_VOICE_NGROK_URL — call${mode === "escalate" ? "/escalation" : ""} needs ngrok.`
              }
            }
            if (mode === "escalate" && !isTelegramConfigured()) {
              message += ` WARNING: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for text ping (escalation sends text first).`
            }
          }
        }

        output.parts.push({
          type: "text",
          text: message,
        } as any)

        await client.tui.showToast({
          body: {
            title: "Phone Ping",
            message,
            variant: enabled ? "success" : "info",
          },
        })
        return
      }
    },

    event: async ({ event }) => {
      if (event.type === "tui.command.execute") {
        const command = (event.properties as { command?: string }).command
        if (command && INTERRUPT_COMMANDS.has(command)) {
          interruptSpeech(client, `${command} — user interrupted`)
          if (idlePingTimer) {
            clearTimeout(idlePingTimer)
            idlePingTimer = null
            debug("plugin", "idle ping cancelled — user interrupted")
          }
        }
        return
      }

      const permDesc = describePermissionEvent(event)
      if (permDesc) {
        const permSessionId = extractSessionId(event) ?? activeSessionId
        info("plugin", `permission event: ${event.type}`, { desc: permDesc, sessionId: permSessionId })
        interruptSpeech(client, "permission prompt")

        const mode = getPingMode()
        const twilioOk = isTwilioConfigured()
        const telegramOk = isTelegramConfigured()
        const canPingMode = mode === "sms" ? telegramOk : (mode === "call" || mode === "escalate") ? twilioOk : false

        if (!isPingDisabled() && canPingMode && !pingInFlight) {
          if (mode === "sms") {
            info("plugin", "permission prompt — attempting text ping (Telegram)")
            pingInFlight = true
            try {
              await textPing({
                text: `I need permission. ${permDesc}`,
                sessionId: permSessionId,
                client: client as any,
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              logError("plugin", `text ping failed, falling back to local speech: ${msg}`)
              await client.app.log({
                body: { service: "voice-reply", level: "error", message: `text ping failed, falling back to local speech: ${msg}` },
              })
              try { if (!isVoiceDisabled()) await speak(`I need permission. ${permDesc}`) } catch {}
            } finally {
              pingInFlight = false
            }
            return
          }

          if (mode === "escalate") {
            info("plugin", "permission prompt — attempting escalation ping (text + possible call)")
            pingInFlight = true
            try {
              await pingWithEscalation({
                text: `I need permission. ${permDesc}`,
                summarizeFirst: false,
                sessionId: permSessionId,
                client: client as any,
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              logError("plugin", `escalation ping failed, falling back to local speech: ${msg}`)
              await client.app.log({
                body: { service: "voice-reply", level: "error", message: `escalation ping failed, falling back to local speech: ${msg}` },
              })
              try { if (!isVoiceDisabled()) await speak(`I need permission. ${permDesc}`) } catch {}
            } finally {
              pingInFlight = false
            }
            return
          }

          if (mode === "call" && getNgrokUrl()) {
            info("plugin", "permission prompt — attempting phone ping")
            pingInFlight = true
            try {
              await pingPhone({
                text: `I need permission. ${permDesc}`,
                summarizeFirst: false,
                sessionId: permSessionId,
                client: client as any,
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              logError("plugin", `phone ping failed, falling back to local speech: ${msg}`)
              await client.app.log({
                body: { service: "voice-reply", level: "error", message: `phone ping failed, falling back to local speech: ${msg}` },
              })
              try {
                if (!isVoiceDisabled()) await speak(`I need permission. ${permDesc}`)
              } catch (err2) {
                logError("plugin", `local speech fallback also failed: ${err2 instanceof Error ? err2.message : String(err2)}`)
              }
            } finally {
              pingInFlight = false
            }
            return
          }
        }

        if (isPingDisabled()) {
          debug("plugin", "permission prompt — ping disabled, using local speech")
        } else if (mode === "sms" && !telegramOk) {
          debug("plugin", "permission prompt — Telegram not configured, using local speech")
        } else if ((mode === "call" || mode === "escalate") && !twilioOk) {
          debug("plugin", "permission prompt — Twilio not configured, using local speech")
        } else if ((mode === "call" || mode === "escalate") && !getNgrokUrl()) {
          debug("plugin", "permission prompt — ngrok URL not set, using local speech")
        } else if (pingInFlight) {
          warn("plugin", "permission prompt — ping already in flight, using local speech")
        }

        if (isVoiceDisabled()) return
        try {
          await speak(`I need permission. ${permDesc}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logError("plugin", `permission announcement failed: ${message}`)
          await client.app.log({
            body: {
              service: "voice-reply",
              level: "error",
              message: `permission announcement failed: ${message}`,
            },
          })
        }
        return
      }

      if (event.type !== "session.idle") return

      const sessionId = extractSessionId(event)
      if (sessionId) activeSessionId = sessionId

      if (!sessionId) {
        await client.app.log({
          body: {
            service: "voice-reply",
            level: "warn",
            message: "session.idle fired but no session ID found",
          },
        })
        return
      }

      const pingOnIdle = process.env.OCODE_VOICE_PING_ON_IDLE === "1"
      const mode = getPingMode()
      const twilioOk = isTwilioConfigured()
      const telegramOk = isTelegramConfigured()
      const idleDelayMs = Number(process.env.OCODE_VOICE_PING_IDLE_DELAY) || 10_000
      const modeConfigured = mode === "sms" ? telegramOk : (mode === "call" || mode === "escalate") ? twilioOk : false
      const canPing = pingOnIdle && !isPingDisabled() && modeConfigured && !pingInFlight && (mode === "sms" || mode === "escalate" || (mode === "call" && getNgrokUrl()))

      if (canPing) {
        if (idlePingTimer) {
          clearTimeout(idlePingTimer)
          idlePingTimer = null
        }

        info("plugin", `idle ping scheduled in ${idleDelayMs}ms`, { mode, sessionId })

        idlePingTimer = setTimeout(async () => {
          idlePingTimer = null
          if (pingInFlight) {
            debug("plugin", "idle ping fired but ping already in flight, skipping")
            return
          }

          try {
            const messagesRes = await client.session.messages({
              path: { id: sessionId },
            })

            const messages = messagesRes.data
            if (!messages || messages.length === 0) return

            const lastAssistant = [...messages].reverse().find(
              (m) => m.info?.role === "assistant"
            )
            if (!lastAssistant) return

            const textParts = (lastAssistant.parts ?? [])
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
            const fullText = textParts.join("\n").trim()
            if (!fullText) return

            pingInFlight = true
            try {
              if (mode === "sms") {
                const summary = await summarize(fullText)
                await textPing({
                  text: summary || fullText,
                  sessionId,
                  client: client as any,
                })
              } else if (mode === "escalate") {
                await pingWithEscalation({
                  text: fullText,
                  summarizeFirst: true,
                  sessionId,
                  client: client as any,
                })
              } else {
                await pingPhone({
                  text: fullText,
                  summarizeFirst: true,
                  sessionId,
                  client: client as any,
                })
              }
            } finally {
              pingInFlight = false
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            await client.app.log({
              body: {
                service: "voice-reply",
                level: "error",
                message: `idle ping failed: ${msg}`,
              },
            })
            pingInFlight = false
          }
        }, idleDelayMs)

        if (!isVoiceDisabled()) {
          try {
            const messagesRes = await client.session.messages({
              path: { id: sessionId },
            })

            const messages = messagesRes.data
            if (!messages || messages.length === 0) return

            const lastAssistant = [...messages].reverse().find(
              (m) => m.info?.role === "assistant"
            )
            if (!lastAssistant) return

            const textParts = (lastAssistant.parts ?? [])
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
            const fullText = textParts.join("\n").trim()
            if (!fullText) return

            const summary = await summarize(fullText)
            if (!summary) return

            await speak(summary)

            await client.tui.showToast({
              body: {
                title: "Voice Reply",
                message: "Spoke summary — turn complete",
                variant: "success",
              },
            })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            logError("plugin", `voice reply failed: ${message}`)
            await client.app.log({
              body: {
                service: "voice-reply",
                level: "error",
                message: `voice reply failed: ${message}`,
              },
            })
          }
        }
        return
      }

      if (isVoiceDisabled()) return

      try {
        const messagesRes = await client.session.messages({
          path: { id: sessionId },
        })

        const messages = messagesRes.data
        if (!messages || messages.length === 0) return

        const lastAssistant = [...messages].reverse().find(
          (m) => m.info?.role === "assistant"
        )
        if (!lastAssistant) return

        const textParts = (lastAssistant.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
        const fullText = textParts.join("\n").trim()
        if (!fullText) return

        const summary = await summarize(fullText)
        if (!summary) return

        await speak(summary)

        await client.tui.showToast({
          body: {
            title: "Voice Reply",
            message: "Spoke summary — turn complete",
            variant: "success",
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logError("plugin", `voice reply failed: ${message}`)
        await client.app.log({
          body: {
            service: "voice-reply",
            level: "error",
            message: `voice reply failed: ${message}`,
          },
        })
      }
    },

    dispose: async () => {
      stop()
      if (idlePingTimer) {
        clearTimeout(idlePingTimer)
        idlePingTimer = null
      }
      try {
        watcher?.close()
      } catch {}
    },
  }
}

function interruptSpeech(
  client: PluginInput["client"],
  reason: string
): void {
  stop()
  void client.app.log({
    body: {
      service: "voice-reply",
      level: "info",
      message: `Interrupted speech: ${reason}`,
    },
  })
}

function listRecordings(): string[] {
  try {
    return readdirSync(WILLOW_RECORDINGS_DIR).filter((f: string) => f.endsWith(".opus"))
  } catch {
    return []
  }
}

function tryWatchWillowRecordings(onNew: () => void): { close: () => void } | null {
  try {
    const w = watch(WILLOW_RECORDINGS_DIR, (eventType: string) => {
      onNew()
    })
    return w
  } catch {
    return null
  }
}

function extractSessionId(event: { properties?: Record<string, unknown> }): string | undefined {
  const props = event.properties
  if (!props) return undefined
  const id =
    (props.sessionID as string | undefined) ??
    (props.id as string | undefined) ??
    (props.sessionId as string | undefined)
  return id
}

function describePermissionEvent(event: { type: string; properties?: Record<string, unknown>; data?: Record<string, unknown> }): string | null {
  const type = event.type

  const props = (event.properties ?? event.data ?? {}) as Record<string, unknown>

  if (type === "permission.updated" || type === "permission.asked") {
    const title = (props.title as string | undefined)?.trim()
    if (title) return title

    const permission = (props.permission as string | undefined)?.trim()
    const patterns = props.patterns as Array<string> | undefined
    if (permission || (patterns && patterns.length > 0)) {
      const parts: string[] = []
      if (permission) parts.push(permission)
      if (patterns && patterns.length > 0) parts.push(patterns.join(", "))
      return parts.join(" — ")
    }
    return "a tool is requesting permission"
  }

  if (type === "permission.v2.asked") {
    const action = (props.action as string | undefined)?.trim()
    const resources = props.resources as Array<string> | undefined
    if (action || (resources && resources.length > 0)) {
      const parts: string[] = []
      if (action) parts.push(action)
      if (resources && resources.length > 0) parts.push(resources.join(", "))
      return parts.join(" — ")
    }
    return "a tool is requesting permission"
  }

  return null
}