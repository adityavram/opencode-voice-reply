import type { Plugin } from "@opencode-ai/plugin"

import { summarize } from "./summarize"
import { speak } from "./tts"

export const VoiceReplyPlugin: Plugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      if (process.env.OCODE_VOICE_DISABLED === "1") return

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

        const summary = summarize(fullText)
        const utterance = `I'm done. ${summary} Ready when you are.`

        await speak(utterance)

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