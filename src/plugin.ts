import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { readdirSync, watch } from "fs"
import path from "path"
import os from "os"

import { loadPluginEnv } from "./env"
loadPluginEnv()

import { summarize } from "./summarize"
import { speak, stop } from "./tts"
import { isVoiceDisabled, toggleVoice, setVoiceDisabled } from "./state"

const WILLOW_RECORDINGS_DIR = path.join(
  os.homedir(),
  "Library/Application Support/com.seewillow.WillowMac/Recordings"
)

const INTERRUPT_COMMANDS = new Set(["session.interrupt", "prompt.submit"])

export const VoiceReplyPlugin: Plugin = async ({ client }) => {
  const knownRecordings = new Set<string>(listRecordings())

  const watcher = tryWatchWillowRecordings(() => {
    const current = listRecordings()
    if (current.length > knownRecordings.size) {
      const newest = current[current.length - 1]
      if (!knownRecordings.has(newest)) {
        knownRecordings.add(newest)
        interruptSpeech(client, "Willow Voice recording started")
      }
    }
  })

  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "voice") return

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
    },

    event: async ({ event }) => {
      if (event.type === "tui.command.execute") {
        const command = (event.properties as { command?: string }).command
        if (command && INTERRUPT_COMMANDS.has(command)) {
          interruptSpeech(client, `${command} — user interrupted`)
        }
        return
      }

      if (event.type !== "session.idle") return

      if (isVoiceDisabled()) return

      try {
        const sessionId = extractSessionId(event)
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
      if (eventType === "rename") onNew()
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