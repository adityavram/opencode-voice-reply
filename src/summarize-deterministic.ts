// Deterministic (heuristic) summarizer — regex-based text cleaning and sentence
// extraction. No LLM calls, so it's fast and always available as a fallback.
// Used as the verbatim cleaner for short messages and as a full summarizer backend.

export function summarizeDeterministic(text: string, maxChars = 280): string {
  let clean = text

  clean = clean.replace(/```[\s\S]*?```/g, " ")
  clean = clean.replace(/`[^`]*`/g, " ")

  clean = clean.replace(/^#{1,6}\s+/gm, "")
  clean = clean.replace(/^\s*[-*+]\s+/gm, "")
  clean = clean.replace(/^\s*\d+\.\s+/gm, "")

  clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
  clean = clean.replace(/\[[^\]]*\]\([^)]*\)/g, " ")

  clean = clean.replace(/@\S+/g, " ")

  clean = clean.replace(/\n{2,}/g, "\n")
  clean = clean.replace(/\s+/g, " ").trim()

  const sentences = clean.match(/[^.!?]+[.!?]+/g)
  if (sentences) {
    let result = ""
    for (const s of sentences) {
      if ((result + s).length > maxChars) break
      result += s
    }
    result = result.trim()
    if (result) return result
  }

  if (clean.length <= maxChars) return clean
  const cut = clean.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(" ")
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
}