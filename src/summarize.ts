// Summarizer orchestrator — decides how to summarize a given text.
//
// Decision tree:
// 1. If the text is short (≤ threshold), run it through the deterministic cleaner
//    only (no LLM call needed — it's short enough to read verbatim).
// 2. If the text is long, pick a backend based on OCODE_VOICE_SUMMARIZER:
//    - "llm": call Ollama for a natural-language summary
//    - "deterministic": use heuristic extraction only
// 3. If the LLM fails for any reason, automatically fall back to deterministic.

import { summarizeDeterministic } from "./summarize-deterministic"
import { summarizeWithLLM, type SummaryStyle } from "./summarize-llm"
import { warn } from "./log"

// Messages at or below this char length are read verbatim (voice style).
// No LLM call — just clean up markdown/formatting.
const VERBATIM_THRESHOLD = Number(process.env.OCODE_VOICE_VERBATIM_THRESHOLD) || 220

// Same but for text style (Telegram messages) — higher threshold since text
// can comfortably carry more content than speech.
const TEXT_VERBATIM_THRESHOLD = Number(process.env.OCODE_VOICE_TEXT_VERBATIM_THRESHOLD) || 500

// Summarize text for the given style ("voice" or "text").
// Returns a clean, concise string suitable for TTS or text messaging.
export async function summarize(text: string, style: SummaryStyle = "voice"): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ""

  // Pick the appropriate verbatim threshold based on style
  const threshold = style === "text" ? TEXT_VERBATIM_THRESHOLD : VERBATIM_THRESHOLD

  // Short messages: just clean formatting, no LLM needed
  if (trimmed.length <= threshold) {
    return summarizeDeterministic(trimmed, threshold)
  }

  // Long messages: pick the configured backend
  const backend = process.env.OCODE_VOICE_SUMMARIZER?.trim() || "llm"

  // Deterministic-only mode: heuristic extraction, no LLM call
  if (backend === "deterministic") {
    return summarizeDeterministic(trimmed)
  }

  // LLM mode: call Ollama, fall back to deterministic on any failure
  if (backend === "llm") {
    const baseUrl = process.env.OCODE_VOICE_OLLAMA_URL?.trim() || "https://api.ollama.com"
    const model = process.env.OCODE_VOICE_OLLAMA_MODEL?.trim() || "mistral-large-3:675b"
    const token = process.env.OCODE_VOICE_OLLAMA_TOKEN?.trim() || undefined
    const timeoutMs = Number(process.env.OCODE_VOICE_OLLAMA_TIMEOUT) || 10000

    try {
      return await summarizeWithLLM(trimmed, { baseUrl, model, token, timeoutMs, style })
    } catch (err) {
      // LLM failed (timeout, server down, bad response, etc.) — fall back gracefully
      const msg = err instanceof Error ? err.message : String(err)
      warn("summarize", `LLM summarizer failed (${msg}), falling back to deterministic`)
      return summarizeDeterministic(trimmed)
    }
  }

  // Unknown backend: default to deterministic
  return summarizeDeterministic(trimmed)
}

// Convenience wrapper for text-style summarization (used by text ping / Telegram).
export async function summarizeForText(text: string): Promise<string> {
  return summarize(text, "text")
}