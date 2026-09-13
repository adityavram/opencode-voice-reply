// LLM-based summarizer — calls Ollama's /api/chat endpoint.
// Voice style: 1-2 sentences, ~30 words, first person (for TTS).
// Text style: 2-3 sentences, ~60 words, third person (for Telegram ping).
// Handles reasoning models that return output in a `thinking` field instead of `content`.

const VOICE_SYSTEM_PROMPT = `Summarize the AI assistant's reply as brief spoken text: 1-2 sentences, max 30 words, first person, plain language. No code, paths, or markdown. Examples:
- "Done. I added speech interruption so hitting Enter stops the voice reply."
- "That failed — the Ollama server wasn't reachable."

Reply with ONLY the summary. Do not include reasoning or thinking steps.`

const TEXT_SYSTEM_PROMPT = `Summarize the AI assistant's reply as a concise text message: 2-3 sentences, max 60 words, third person, include key outcomes and anything needing user input. No code blocks, no file paths, no markdown. Use plain text. Examples:
- "Finished adding speech interruption to the voice reply plugin. Tests pass. Needs your review on the interrupt logic in plugin.ts before merging."
- "Attempted to fix the Ollama timeout but the server is unreachable. The summarizer falls back to deterministic mode. You may need to check if the API key is valid."

Reply with ONLY the summary. Do not include reasoning or thinking steps.`

const DEFAULT_NUM_PREDICT = 200
const DEFAULT_TIMEOUT_MS = 30000

export type SummaryStyle = "voice" | "text"

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
  const systemPrompt = opts.style === "text" ? TEXT_SYSTEM_PROMPT : VOICE_SYSTEM_PROMPT
  const numPredict = opts.style === "text" ? 300 : DEFAULT_NUM_PREDICT
  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        options: {
          temperature: 0.3,
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

    const data = (await res.json()) as {
      message?: { content?: string; thinking?: string }
      done_reason?: string
    }

    const content = data.message?.content?.trim()
    if (content) return content

    // Reasoning model case: output is in the thinking field
    const thinking = data.message?.thinking?.trim()
    if (thinking) {
      const extracted = extractSummaryFromThinking(thinking)
      if (extracted) return extracted
      throw new Error(
        `Ollama returned content in thinking field but it could not be extracted (done_reason: ${data.done_reason ?? "unknown"})`
      )
    }

    throw new Error(
      `Ollama returned empty response (done_reason: ${data.done_reason ?? "unknown"}, model: ${opts.model}). The model may need a higher num_predict or may not support the chat endpoint.`
    )
  } catch (err) {
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

// Reasoning models sometimes wrap their final answer in quotes or label it.
// We try several patterns before falling back to the last non-trivial line.
function extractSummaryFromThinking(thinking: string): string | null {
  const patterns = [
    /(?:answer|summary|response|reply|output)\s*(?:is|:)\s*["""](.+?)["""]/i,
    /["""]([^"""]{10,200})["""]/,
  ]
  for (const pattern of patterns) {
    const match = thinking.match(pattern)
    if (match && match[1]) {
      return match[1].trim()
    }
  }
  const lines = thinking.split("\n").filter((l) => l.trim().length > 10)
  if (lines.length > 0) {
    return lines[lines.length - 1].trim()
  }
  return null
}