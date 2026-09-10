import { summarizeDeterministic } from "./summarize-deterministic"
import { summarizeWithLLM } from "./summarize-llm"

const VERBATIM_THRESHOLD = Number(process.env.OCODE_VOICE_VERBATIM_THRESHOLD) || 220

export async function summarize(text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ""

  if (trimmed.length <= VERBATIM_THRESHOLD) {
    return summarizeDeterministic(trimmed, VERBATIM_THRESHOLD)
  }

  const backend = process.env.OCODE_VOICE_SUMMARIZER?.trim() || "llm"

  if (backend === "deterministic") {
    return summarizeDeterministic(trimmed)
  }

  if (backend === "llm") {
    const baseUrl = process.env.OCODE_VOICE_OLLAMA_URL?.trim() || "https://api.ollama.com"
    const model = process.env.OCODE_VOICE_OLLAMA_MODEL?.trim() || "mistral-large-3:675b"
    const token = process.env.OCODE_VOICE_OLLAMA_TOKEN?.trim() || undefined
    const timeoutMs = Number(process.env.OCODE_VOICE_OLLAMA_TIMEOUT) || 10000

    try {
      return await summarizeWithLLM(trimmed, { baseUrl, model, token, timeoutMs })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[voice-reply] LLM summarizer failed (${msg}), falling back to deterministic`)
      return summarizeDeterministic(trimmed)
    }
  }

  return summarizeDeterministic(trimmed)
}