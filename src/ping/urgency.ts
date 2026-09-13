// Urgency classifier — determines whether a permission prompt or agent action
// is "high" or "low" urgency. Used by the escalation ping mode to decide
// whether to escalate from a Telegram text to a phone call.
//
// Two-stage approach:
// 1. Heuristic: regex pattern matching for clearly destructive/irreversible
//    operations. If it matches, returns immediately (fast, no LLM needed).
// 2. LLM fallback: if the heuristic is "ambiguous" (has shell/write ops but
//    no explicit destructive keywords), asks the LLM to classify.
//
// The heuristic is intentionally conservative — it's better to over-classify
// as "high" than to miss a destructive operation.

import { summarizeWithLLM } from "../summarize-llm"
import { info, debug } from "../log"

export type Urgency = "high" | "low"

// Regex patterns that indicate high urgency — destructive, irreversible,
// production-impacting, or security-sensitive operations.
const HIGH_URGENCY_PATTERNS: RegExp[] = [
  // File/directory deletion or destruction
  /\b(rm|remove|delete|del|unlink|destroy|wipe|purge)\b/i,
  // Force operations
  /\b(force|forced|forcing)\b/i,
  // Overwriting or replacing files
  /\b(overwrite|overwrit|clobber|replace)\b/i,
  // Database/table destructive operations
  /\b(drop|truncate|reset|clear|empty|flush)\b/i,
  // Deployment/publishing actions
  /\b(deploy|publish|release|ship)\b/i,
  // Dangerous git operations
  /\b(git\s+push|git\s+reset|git\s+rebase|git\s+force|git\s+clean)\b/i,
  // Production/staging environment changes
  /\b(production|prod|staging)\b/i,
  // Database migrations (can be destructive)
  /\b(migrate|migration)\b/i,
  // Permission changes
  /\b(chmod|chown)\b/i,
  // Privileged execution
  /\b(sudo|root|admin)\b/i,
  // Code execution / shell injection risk
  /\b(exec|eval|system|shell)\b/i,
  // Process termination / system shutdown
  /\b(kill|killall|pkill|terminate|shutdown|reboot)\b/i,
  // Disk formatting
  /\b(format|mkfs|fdisk)\b/i,
  // Package installation/removal (can modify system state)
  /\b(apt|brew|pip|npm|yarn)\s+(install|uninstall|remove|purge)\b/i,
  // Docker destructive operations
  /\b(docker\s+rm|docker\s+rmi|docker\s+prune)\b/i,
  // Infrastructure destructive operations
  /\b(terraform\s+(destroy|apply)|kubectl\s+delete)\b/i,
  // Database/SQL operations
  /\b(database|db|sql|query)\b/i,
  // Security-sensitive operations
  /\b(secret|key|token|password|credential)\b/i,
  // Extreme destruction language
  /\b(nuke|obliterate|dismantle)\b/i,
  // Piping remote content to shell (curl/wget | sh) — security risk
  /\b(curl|wget)\s+.*\|\s*(sh|bash|zsh)\b/i,
]

// Keywords (not regex) that indicate high urgency — checked via substring match.
const HIGH_URGENCY_KEYWORDS = [
  "destructive", "irreversible", "permanent", "unrecoverable",
  "dangerous", "critical", "severe", "fatal",
]

// Heuristic urgency classification — fast, no LLM call.
// Returns "high", "low", or "ambiguous" (meaning the LLM should decide).
export function classifyUrgencyHeuristic(text: string): Urgency | "ambiguous" {
  const lower = text.toLowerCase()

  // Check regex patterns first — a match means high urgency, no ambiguity
  for (const pattern of HIGH_URGENCY_PATTERNS) {
    if (pattern.test(lower)) {
      debug("urgency", `heuristic matched high urgency pattern`, { pattern: pattern.source, text: text.slice(0, 100) })
      return "high"
    }
  }

  // Check high-urgency keywords via substring match
  for (const keyword of HIGH_URGENCY_KEYWORDS) {
    if (lower.includes(keyword)) {
      debug("urgency", `heuristic matched high urgency keyword`, { keyword, text: text.slice(0, 100) })
      return "high"
    }
  }

  // No explicit destructive patterns — check if this is a read-only or
  // write/exec operation to determine if we need LLM classification.
  const hasShellOrExec = /\b(bash|sh|exec|run|execute|command|script)\b/i.test(text)
  const hasFileWrite = /\b(write|create|update|modify|edit|add|insert|save|patch)\b/i.test(text)
  const hasRead = /\b(read|list|show|cat|grep|find|search|get)\b/i.test(text)

  // Clearly read-only → low urgency, no need for LLM
  if (hasRead && !hasShellOrExec && !hasFileWrite) {
    debug("urgency", `heuristic classified low urgency (read-only)`, { text: text.slice(0, 100) })
    return "low"
  }

  // Has shell/exec or file write ops but no explicit destructive keywords —
  // ambiguous, let the LLM decide.
  if (hasShellOrExec || hasFileWrite) {
    debug("urgency", `heuristic returned ambiguous (has shell/write ops)`, { text: text.slice(0, 100) })
    return "ambiguous"
  }

  // No read, no write, no shell — probably benign, default to low
  debug("urgency", `heuristic classified low urgency (default)`, { text: text.slice(0, 100) })
  return "low"
}

// LLM-based urgency classification — used when the heuristic is ambiguous.
// Asks Ollama to classify the action as "high" or "low" urgency.
// Defaults to "low" on any error (fail-safe but not fail-deadly).
export async function classifyUrgencyWithLLM(text: string): Promise<Urgency> {
  const baseUrl = process.env.OCODE_VOICE_OLLAMA_URL?.trim() || "https://api.ollama.com"
  const model = process.env.OCODE_VOICE_OLLAMA_MODEL?.trim() || "mistral-large-3:675b"
  const token = process.env.OCODE_VOICE_OLLAMA_TOKEN?.trim() || undefined
  const timeoutMs = Number(process.env.OCODE_VOICE_OLLAMA_TIMEOUT) || 10000

  // Simple classification prompt — the model just needs to return "high" or "low"
  const prompt = `Classify this AI agent action as "high" or "low" urgency.
High = destructive, irreversible, production-impacting, security-sensitive, or requires immediate human judgment.
Low = safe, reversible, read-only, or routine.

Action: ${text.slice(0, 500)}

Reply with ONLY "high" or "low". No other text.`

  try {
    // Reuse the LLM summarizer's fetch logic (it's just a chat completion)
    const response = await summarizeWithLLM(prompt, { baseUrl, model, token, timeoutMs })
    const cleaned = response.trim().toLowerCase()
    if (cleaned.includes("high")) {
      info("urgency", `LLM classified high urgency`, { text: text.slice(0, 100), response: cleaned })
      return "high"
    }
    debug("urgency", `LLM classified low urgency`, { text: text.slice(0, 100), response: cleaned })
    return "low"
  } catch (err) {
    // LLM failed — default to low urgency (we already sent the text, so the
    // user is aware; we just won't escalate to a call).
    debug("urgency", `LLM classification failed, defaulting to low`, { error: err instanceof Error ? err.message : String(err) })
    return "low"
  }
}

// Main urgency classification entry point.
// Runs the heuristic first; if it's definitive (high or low), returns immediately.
// If ambiguous, falls back to LLM classification.
export async function classifyUrgency(text: string): Promise<Urgency> {
  const heuristic = classifyUrgencyHeuristic(text)

  // Definitive heuristic results — return without LLM call
  if (heuristic === "high") return "high"
  if (heuristic === "low") return "low"

  // Ambiguous — ask the LLM to decide
  info("urgency", `heuristic was ambiguous, asking LLM`, { text: text.slice(0, 100) })
  return classifyUrgencyWithLLM(text)
}