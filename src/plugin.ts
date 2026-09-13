// Plugin entry point — the main opencode plugin that ties everything together.
//
// This plugin does four things:
// 1. **Voice reply**: When the agent finishes its turn (session.idle), it
//    summarizes the agent's last message and speaks it aloud via TTS.
// 2. **Permission notification**: When the agent needs permission, it
//    interrupts any playing speech and either pings the user (via Telegram
//    text, Twilio phone call, or escalation) or speaks locally.
// 3. **Speech interruption**: When the user presses Enter or submits a prompt,
//    or presses FN on a Willow Voice device, any in-flight speech is stopped.
// 4. **Slash commands**: /voice [on|off] toggles voice reply, /ping [on|off|sms|call|escalate]
//    controls the phone ping feature.
//
// All errors are caught and logged so a TTS or ping failure never breaks the session.

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { readdirSync, watch } from "fs"
import path from "path"
import os from "os"

import { loadPluginEnv } from "./env"
// Load .env files as early as possible so all subsequent imports see the env vars
loadPluginEnv()

import { summarize, summarizeForText } from "./summarize"
import { speak, stop } from "./tts"
import { isVoiceDisabled, toggleVoice, setVoiceDisabled, isPingDisabled, togglePing, setPingDisabled, getPingMode, setPingMode, type PingMode } from "./state"
import { pingPhone, textPing, pingWithEscalation, getNgrokUrl, isTwilioConfigured, isTelegramConfigured, clearTelegramUpdates } from "./ping"
import { info, debug, warn, error as logError } from "./log"

// Willow Voice (seewillow.WillowMac) stores recordings here. When a new .opus
// file appears, it means the user pressed FN to dictate — we use this as an
// interrupt signal to stop any playing speech.
const WILLOW_RECORDINGS_DIR = path.join(
  os.homedir(),
  "Library/Application Support/com.seewillow.WillowMac/Recordings"
)

// These TUI commands indicate the user is actively interacting, so we should
// stop any in-flight speech.
const INTERRUPT_COMMANDS = new Set(["session.interrupt", "prompt.submit"])

// The main plugin export — opencode calls this async function on startup.
export const VoiceReplyPlugin: Plugin = async ({ client }) => {
  // === PLUGIN STATE ===
  // Snapshot of known Willow recordings at startup — used to detect new files
  const knownRecordings = new Set<string>(listRecordings())
  // The last session ID we've seen — used for permission events that don't include one
  let activeSessionId: string | undefined
  // Prevents concurrent phone calls/text pings from stacking up
  let pingInFlight = false
  // Timer for delayed idle pings — cleared if the user interrupts before it fires
  let idlePingTimer: ReturnType<typeof setTimeout> | null = null

  // On startup, if Telegram is configured, drain stale updates so old messages
  // don't get injected as replies
  if (isTelegramConfigured()) {
    clearTelegramUpdates().catch(() => {})
    info("plugin", "Telegram updates cleared on startup")
  }

  // Watch the Willow Voice Recordings directory for new .opus files.
  // When a new file appears, the user pressed FN to dictate — stop speech.
  const watcher = tryWatchWillowRecordings(() => {
    const current = listRecordings()
    const newFiles = current.filter((f) => !knownRecordings.has(f))
    if (newFiles.length > 0) {
      // Update the known set so we don't re-trigger for the same files
      for (const f of current) knownRecordings.add(f)
      interruptSpeech(client, "Willow Voice recording started")
    }
  })

  // === RETURNED PLUGIN HANDLERS ===
  return {
    // --- Slash command handler (runs before the command executes) ---
    // Handles /voice and /ping commands
    "command.execute.before": async (input, output) => {
      // === /voice [on|off] — toggle voice reply on/off ===
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
          stop() // kill any in-flight speech
          enabled = false
          message = "Voice reply disabled."
        } else {
          // No argument — toggle current state
          enabled = toggleVoice()
          message = enabled ? "Voice reply enabled." : "Voice reply disabled."
          if (!enabled) stop()
        }

        // Output the result as text + toast notification
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

      // === /ping [on|off|sms|call|escalate] — control phone ping ===
      if (input.command === "ping") {
        const arg = input.arguments.trim().toLowerCase()

        // --- Ping mode subcommands ---
        // /ping sms (or /ping text) — Telegram text-only mode
        if (arg === "sms" || arg === "text") {
          setPingMode("sms")
          const message = `Ping mode set to text (Telegram).${isPingDisabled() ? " Ping is currently disabled — use /ping on to enable." : ""}${!isTelegramConfigured() ? " WARNING: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env" : ""}`
          output.parts.push({ type: "text", text: message } as any)
          await client.tui.showToast({ body: { title: "Phone Ping", message, variant: "info" } })
          return
        }

        // /ping call (or /ping voice) — Twilio phone call mode
        if (arg === "call" || arg === "voice") {
          setPingMode("call")
          const message = `Ping mode set to call (voice).${isPingDisabled() ? " Ping is currently disabled — use /ping on to enable." : ""}`
          output.parts.push({ type: "text", text: message } as any)
          await client.tui.showToast({ body: { title: "Phone Ping", message, variant: "info" } })
          return
        }

        // /ping escalate (or /ping auto) — text first, call if high urgency
        if (arg === "escalate" || arg === "auto") {
          setPingMode("escalate")
          let message = `Ping mode set to escalate (text first, call if high urgency).${isPingDisabled() ? " Ping is currently disabled — use /ping on to enable." : ""}`
          // Warn about missing config that would prevent escalation
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

        // --- Enable/disable subcommands ---
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
          // No argument — toggle current state
          enabled = togglePing()
          message = enabled ? "Phone ping enabled." : "Phone ping disabled."
        }

        // Append current mode to the message
        const mode = getPingMode()
        message += ` Mode: ${mode}.`

        // If enabling, check for missing config and add warnings
        if (enabled) {
          if (mode === "sms") {
            if (!isTelegramConfigured()) {
              message += ` WARNING: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env for text ping.`
            }
          } else if (mode === "call" || mode === "escalate") {
            // Check Twilio credentials
            const twilioOk = isTwilioConfigured()
            if (!twilioOk) {
              message += ` WARNING: missing TWILIO_* credentials — call${mode === "escalate" ? "/escalation" : ""} needs Twilio.`
            } else {
              // Check ngrok URL
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

    // --- Event handler — processes all opencode events ---
    event: async ({ event }) => {
      // === USER INTERRUPT: stop speech on Enter/prompt submit ===
      if (event.type === "tui.command.execute") {
        const command = (event.properties as { command?: string }).command
        if (command && INTERRUPT_COMMANDS.has(command)) {
          interruptSpeech(client, `${command} — user interrupted`)
          // Also cancel any pending idle ping — the user is back at the keyboard
          if (idlePingTimer) {
            clearTimeout(idlePingTimer)
            idlePingTimer = null
            debug("plugin", "idle ping cancelled — user interrupted")
          }
        }
        return
      }

      // === PERMISSION PROMPT: interrupt speech and ping the user ===
      const permDesc = describePermissionEvent(event)
      if (permDesc) {
        const permSessionId = extractSessionId(event) ?? activeSessionId
        info("plugin", `permission event: ${event.type}`, { desc: permDesc, sessionId: permSessionId })

        // Always interrupt any in-flight speech — the permission prompt takes priority
        interruptSpeech(client, "permission prompt")

        // Determine which ping mode is configured and whether its requirements are met
        const mode = getPingMode()
        const twilioOk = isTwilioConfigured()
        const telegramOk = isTelegramConfigured()
        // Can we use the configured ping mode? (each mode has different requirements)
        const canPingMode = mode === "sms" ? telegramOk : (mode === "call" || mode === "escalate") ? twilioOk : false

        // If ping is enabled, the mode is configured, and no ping is already running — ping!
        if (!isPingDisabled() && canPingMode && !pingInFlight) {

          // --- SMS mode: send Telegram text, wait for reply, inject ---
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
              // Fallback: speak locally if voice isn't disabled
              try { if (!isVoiceDisabled()) await speak(`I need permission. ${permDesc}`) } catch {}
            } finally {
              pingInFlight = false
            }
            return
          }

          // --- Escalate mode: text first, call if high urgency & no reply ---
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

          // --- Call mode: place Twilio phone call (requires ngrok URL) ---
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
              // Fallback: speak locally
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

        // === If we get here, ping didn't happen — explain why (for debugging) ===
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

        // Fallback: speak the permission prompt locally via TTS
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

      // === SESSION IDLE: the agent finished its turn — speak summary & maybe ping ===
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

      // Check if we should also ping on idle (not just on permission prompts)
      const pingOnIdle = process.env.OCODE_VOICE_PING_ON_IDLE === "1"
      const mode = getPingMode()
      const twilioOk = isTwilioConfigured()
      const telegramOk = isTelegramConfigured()
      const idleDelayMs = Number(process.env.OCODE_VOICE_PING_IDLE_DELAY) || 10_000
      // Can we ping in the configured mode?
      const modeConfigured = mode === "sms" ? telegramOk : (mode === "call" || mode === "escalate") ? twilioOk : false
      const canPing = pingOnIdle && !isPingDisabled() && modeConfigured && !pingInFlight && (mode === "sms" || mode === "escalate" || (mode === "call" && getNgrokUrl()))

      // --- If idle ping is enabled, schedule a delayed ping ---
      // The delay gives the user time to interrupt (e.g., they're at the keyboard
      // and don't want to be pinged).
      if (canPing) {
        if (idlePingTimer) {
          clearTimeout(idlePingTimer)
          idlePingTimer = null
        }

        info("plugin", `idle ping scheduled in ${idleDelayMs}ms`, { mode, sessionId })

        idlePingTimer = setTimeout(async () => {
          idlePingTimer = null
          // Check again — a ping may have started from a permission event
          if (pingInFlight) {
            debug("plugin", "idle ping fired but ping already in flight, skipping")
            return
          }

          try {
            // Fetch the last assistant message from the session
            const messagesRes = await client.session.messages({
              path: { id: sessionId },
            })

            const messages = messagesRes.data
            if (!messages || messages.length === 0) return

            // Find the most recent assistant message
            const lastAssistant = [...messages].reverse().find(
              (m) => m.info?.role === "assistant"
            )
            if (!lastAssistant) return

            // Extract all text parts from the assistant message
            const textParts = (lastAssistant.parts ?? [])
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
            const fullText = textParts.join("\n").trim()
            if (!fullText) return

            // Ping the user via the configured mode
            pingInFlight = true
            try {
              if (mode === "sms") {
                // Text mode: summarize for text style, send via Telegram
                const summary = await summarizeForText(fullText)
                await textPing({
                  text: summary || fullText,
                  sessionId,
                  client: client as any,
                })
              } else if (mode === "escalate") {
                // Escalate mode: summarize, classify urgency, text then maybe call
                await pingWithEscalation({
                  text: fullText,
                  summarizeFirst: true,
                  sessionId,
                  client: client as any,
                })
              } else {
                // Call mode: summarize for voice, synthesize, call
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

        // While waiting for the idle ping, also speak the summary locally
        // (unless voice is disabled)
        if (!isVoiceDisabled()) {
          try {
            // Fetch the last assistant message
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

            // Summarize for voice and speak
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

      // --- No idle ping — just speak the summary (the common case) ---
      if (isVoiceDisabled()) return

      try {
        // Fetch the last assistant message from the session
        const messagesRes = await client.session.messages({
          path: { id: sessionId },
        })

        const messages = messagesRes.data
        if (!messages || messages.length === 0) return

        // Find the most recent assistant message
        const lastAssistant = [...messages].reverse().find(
          (m) => m.info?.role === "assistant"
        )
        if (!lastAssistant) return

        // Extract all text parts and join them
        const textParts = (lastAssistant.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
        const fullText = textParts.join("\n").trim()
        if (!fullText) return

        // Summarize the text (short messages read verbatim, long ones via LLM)
        const summary = await summarize(fullText)
        if (!summary) return

        // Speak the summary aloud
        await speak(summary)

        // Show a toast confirming the summary was spoken
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

    // --- Cleanup on plugin unload / shutdown ---
    dispose: async () => {
      // Stop any in-flight speech
      stop()
      // Cancel any pending idle ping timer
      if (idlePingTimer) {
        clearTimeout(idlePingTimer)
        idlePingTimer = null
      }
      // Close the Willow Recordings file watcher
      try {
        watcher?.close()
      } catch {}
    },
  }
}

// === HELPER FUNCTIONS ===

// Stop speech and log the interrupt reason to the opencode app log.
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

// List all .opus recording files in the Willow Recordings directory.
// Returns an empty array if the directory doesn't exist (e.g., Willow not installed).
function listRecordings(): string[] {
  try {
    return readdirSync(WILLOW_RECORDINGS_DIR).filter((f: string) => f.endsWith(".opus"))
  } catch {
    return []
  }
}

// Attempt to start a file watcher on the Willow Recordings directory.
// Returns the watcher object (with a close() method) or null if the directory
// doesn't exist. On macOS, both 'rename' and 'change' events fire inconsistently,
// so we trigger on any event and compare the file list.
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

// Extract the session ID from an event's properties.
// Checks multiple possible field names (sessionID, id, sessionId) since the
// exact schema may vary between opencode versions.
function extractSessionId(event: { properties?: Record<string, unknown> }): string | undefined {
  const props = event.properties
  if (!props) return undefined
  const id =
    (props.sessionID as string | undefined) ??
    (props.id as string | undefined) ??
    (props.sessionId as string | undefined)
  return id
}

// Extract a human-readable description from a permission event.
// Handles all three permission event types:
//   - permission.updated (v1)
//   - permission.asked (v1)
//   - permission.v2.asked (v2)
// Reads from both `properties` (v1) and `data` (v2) fields for resilience.
function describePermissionEvent(event: { type: string; properties?: Record<string, unknown>; data?: Record<string, unknown> }): string | null {
  const type = event.type

  // Try properties (v1) first, then data (v2)
  const props = (event.properties ?? event.data ?? {}) as Record<string, unknown>

  // V1 permission events: look for title, or permission + patterns
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
    // Fallback if no useful fields are found
    return "a tool is requesting permission"
  }

  // V2 permission events: look for action + resources
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

  // Not a permission event
  return null
}