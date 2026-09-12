import { summarizeWithLLM } from "../summarize-llm"
import { info, debug } from "../log"

export type Urgency = "high" | "low"

const HIGH_URGENCY_PATTERNS: RegExp[] = [
  /\b(rm|remove|delete|del|unlink|destroy|wipe|purge)\b/i,
  /\b(force|forced|forcing)\b/i,
  /\b(overwrite|overwrit|clobber|replace)\b/i,
  /\b(drop|truncate|reset|clear|empty|flush)\b/i,
  /\b(deploy|publish|release|ship)\b/i,
  /\b(git\s+push|git\s+reset|git\s+rebase|git\s+force|git\s+clean)\b/i,
  /\b(production|prod|staging)\b/i,
  /\b(migrate|migration)\b/i,
  /\b(chmod|chown)\b/i,
  /\b(sudo|root|admin)\b/i,
  /\b(exec|eval|system|shell)\b/i,
  /\b(kill|killall|pkill|terminate|shutdown|reboot)\b/i,
  /\b(format|mkfs|fdisk)\b/i,
  /\b(apt|brew|pip|npm|yarn)\s+(install|uninstall|remove|purge)\b/i,
  /\b(docker\s+rm|docker\s+rmi|docker\s+prune)\b/i,
  /\b(terraform\s+(destroy|apply)|kubectl\s+delete)\b/i,
  /\b(database|db|sql|query)\b/i,
  /\b(secret|key|token|password|credential)\b/i,
  /\b(nuke|obliterate|dismantle)\b/i,
  /\b(curl|wget)\s+.*\|\s*(sh|bash|zsh)\b/i,
]

const HIGH_URGENCY_KEYWORDS = [
  "destructive", "irreversible", "permanent", "unrecoverable",
  "dangerous", "critical", "severe", "fatal",
]

export function classifyUrgencyHeuristic(text: string): Urgency | "ambiguous" {
  const lower = text.toLowerCase()

  for (const pattern of HIGH_URGENCY_PATTERNS) {
    if (pattern.test(lower)) {
      debug("urgency", `heuristic matched high urgency pattern`, { pattern: pattern.source, text: text.slice(0, 100) })
      return "high"
    }
  }

  for (const keyword of HIGH_URGENCY_KEYWORDS) {
    if (lower.includes(keyword)) {
      debug("urgency", `heuristic matched high urgency keyword`, { keyword, text: text.slice(0, 100) })
      return "high"
    }
  }

  const hasShellOrExec = /\b(bash|sh|exec|run|execute|command|script)\b/i.test(text)
  const hasFileWrite = /\b(write|create|update|modify|edit|add|insert|save|patch)\b/i.test(text)
  const hasRead = /\b(read|list|show|cat|grep|find|search|get)\b/i.test(text)

  if (hasRead && !hasShellOrExec && !hasFileWrite) {
    debug("urgency", `heuristic classified low urgency (read-only)`, { text: text.slice(0, 100) })
    return "low"
  }

  if (hasShellOrExec || hasFileWrite) {
    debug("urgency", `heuristic returned ambiguous (has shell/write ops)`, { text: text.slice(0, 100) })
    return "ambiguous"
  }

  debug("urgency", `heuristic classified low urgency (default)`, { text: text.slice(0, 100) })
  return "low"
}

export async function classifyUrgencyWithLLM(text: string): Promise<Urgency> {
  const baseUrl = process.env.OCODE_VOICE_OLLAMA_URL?.trim() || "https://api.ollama.com"
  const model = process.env.OCODE_VOICE_OLLAMA_MODEL?.trim() || "mistral-large-3:675b"
  const token = process.env.OCODE_VOICE_OLLAMA_TOKEN?.trim() || undefined
  const timeoutMs = Number(process.env.OCODE_VOICE_OLLAMA_TIMEOUT) || 10000

  const prompt = `Classify this AI agent action as "high" or "low" urgency.
High = destructive, irreversible, production-impacting, security-sensitive, or requires immediate human judgment.
Low = safe, reversible, read-only, or routine.

Action: ${text.slice(0, 500)}

Reply with ONLY "high" or "low". No other text.`

  try {
    const response = await summarizeWithLLM(prompt, { baseUrl, model, token, timeoutMs })
    const cleaned = response.trim().toLowerCase()
    if (cleaned.includes("high")) {
      info("urgency", `LLM classified high urgency`, { text: text.slice(0, 100), response: cleaned })
      return "high"
    }
    debug("urgency", `LLM classified low urgency`, { text: text.slice(0, 100), response: cleaned })
    return "low"
  } catch (err) {
    debug("urgency", `LLM classification failed, defaulting to low`, { error: err instanceof Error ? err.message : String(err) })
    return "low"
  }
}

export async function classifyUrgency(text: string): Promise<Urgency> {
  const heuristic = classifyUrgencyHeuristic(text)

  if (heuristic === "high") return "high"
  if (heuristic === "low") return "low"

  info("urgency", `heuristic was ambiguous, asking LLM`, { text: text.slice(0, 100) })
  return classifyUrgencyWithLLM(text)
}