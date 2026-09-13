// LLM-based summarizer — calls Ollama's /api/chat endpoint to produce
// natural-language summaries. Two styles:
//   - "voice": very short (1-2 sentences, ~30 words, first person) for TTS playback
//   - "text":  slightly longer (2-3 sentences, ~60 words, third person) for text ping
//
// Handles reasoning models that return their output in a `thinking` field
// instead of the standard `content` field. On failure, the caller falls back
// to the deterministic summarizer.

// System prompt for voice-style summaries (spoken aloud via TTS).
// Constraints: 1-2 sentences, max 30 words, first person, no code/markdown.
const VOICE_SYSTEM_PROMPT = `Summarize the AI assistant's reply as brief spoken text: 1-2 sentences, max 30 words, first person, plain language. No code, paths, or markdown. Examples:
- "Done. I added speech interruption so hitting Enter stops the voice reply."
- "That failed — the Ollama server wasn't reachable."

Reply with ONLY the summary. Do not include reasoning or thinking steps.`

// System prompt for text-style summaries (sent via Telegram).
// Constraints: 2-3 sentences, max 60 words, third person, no code/markdown.
const TEXT_SYSTEM_PROMPT = `Summarize the AI assistant's reply as a concise text message: 2-3 sentences, max 60 words, third person, include key outcomes and anything needing user input. No code blocks, no file paths, no markdown. Use plain text. Examples:
- "Finished adding speech interruption to the voice reply plugin. Tests pass. Needs your review on the interrupt logic in plugin.ts before merging."
- "Attempted to fix the Ollama timeout but the server is unreachable. The summarizer falls back to deterministic mode. You may need to check if the API key is valid."

Reply with ONLY the summary. Do not include reasoning or thinking steps.`

// Default token generation limit (voice style). Text style uses 300.
const DEFAULT_NUM_PREDICT = 200
// Default request timeout if not specified by the caller.
const DEFAULT_TIMEOUT_MS = 30000

export type SummaryStyle = "voice" | "text"

// Call Ollama to summarize `text` in the given style.
// Throws on HTTP errors, timeouts, and empty responses.
export async function summarizeWithLLM(
  text: string,
  opts: {
    baseUrl: string
    model: string
    token?: string
    timeoutMs?: number
    style?: SummaryStyle
  }
): Promise<string> {
  // Pick the system prompt and token limit based on the summary style
  const systemPrompt = opts.style === "text" ? TEXT_SYSTEM_PROMPT : VOICE_SYSTEM_PROMPT
  const numPredict = opts.style === "text" ? 300 : DEFAULT_NUM_PREDICT
  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // POST to Ollama's chat endpoint with a single user message + system prompt
    const res = await fetch(`${opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Optional bearer token for Ollama Cloud (or any auth-gated endpoint)
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        stream: false, // we want the full response in one shot, not streaming
        options: {
          temperature: 0.3, // low temperature for consistent, factual summaries
          num_predict: numPredict,
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`Ollama responded ${res.status}: ${await res.text()}`)
    }

    // Parse the response — note that some reasoning models put their output
    // in `thinking` instead of `content`.
    const data = (await res.json()) as {
      message?: { content?: string; thinking?: string }
      done_reason?: string
    }

    // Standard case: content field is present and non-empty
    const content = data.message?.content?.trim()
    if (content) return content

    // Reasoning model case: output is in the thinking field — try to extract
    // the actual summary from it using heuristics.
    const thinking = data.message?.thinking?.trim()
    if (thinking) {
      const extracted = extractSummaryFromThinking(thinking)
      if (extracted) return extracted
      throw new Error(
        `Ollama returned content in thinking field but it could not be extracted (done_reason: ${data.done_reason ?? "unknown"})`
      )
    }

    // Empty response — the model may need a higher num_predict or may not
    // support the chat endpoint properly.
    throw new Error(
      `Ollama returned empty response (done_reason: ${data.done_reason ?? "unknown"}, model: ${opts.model}). The model may need a higher num_predict or may not support the chat endpoint.`
    )
  } catch (err) {
    // Convert AbortError into a more helpful timeout message
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Ollama request timed out after ${timeoutMs}ms (model: ${opts.model}, url: ${opts.baseUrl}). Consider increasing OCODE_VOICE_OLLAMA_TIMEOUT or using a faster model.`
      )
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// Attempt to extract the actual summary from a reasoning model's "thinking" output.
// Reasoning models sometimes wrap their final answer in quotes or label it.
// We try several patterns before falling back to the last non-trivial line.
function extractSummaryFromThinking(thinking: string): string | null {
  // Pattern 1: Look for "answer is '...'", "summary: '...'", etc.
  const patterns = [
    /(?:answer|summary|response|reply|output)\s*(?:is|:)\s*["""](.+?)["""]/i,
    // Pattern 2: Any quoted string of reasonable length (10-200 chars)
    /["""]([^"""]{10,200})["""]/,
  ]
  for (const pattern of patterns) {
    const match = thinking.match(pattern)
    if (match && match[1]) {
      return match[1].trim()
    }
  }
  // Fallback: take the last line with substantial content (reasoning models
  // often end with their conclusion).
  const lines = thinking.split("\n").filter((l) => l.trim().length > 10)
  if (lines.length > 0) {
    return lines[lines.length - 1].trim()
  }
  return null
}