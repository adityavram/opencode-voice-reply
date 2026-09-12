import { summarizeDeterministic } from "./summarize-deterministic"
import { summarizeWithLLM, type SummaryStyle } from "./summarize-llm"
import { warn } from "./log"

const VERBATIM_THRESHOLD = Number(process.env.OCODE_VOICE_VERBATIM_THRESHOLD) || 220
const TEXT_VERBATIM_THRESHOLD = Number(process.env.OCODE_VOICE_TEXT_VERBATIM_THRESHOLD) || 500

export async function summarize(text: string, style: SummaryStyle = "voice"): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ""

  const threshold = style === "text" ? TEXT_VERBATIM_THRESHOLD : VERBATIM_THRESHOLD

  if (trimmed.length <= threshold) {
    return summarizeDeterministic(trimmed, threshold)
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
      return await summarizeWithLLM(trimmed, { baseUrl, model, token, timeoutMs, style })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warn("summarize", `LLM summarizer failed (${msg}), falling back to deterministic`)
      return summarizeDeterministic(trimmed)
    }
  }

  return summarizeDeterministic(trimmed)
}

export async function summarizeForText(text: string): Promise<string> {
  return summarize(text, "text")
}