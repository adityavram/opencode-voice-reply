// Deterministic (heuristic) summarizer — extracts a concise summary from text
// using simple regex-based cleaning and sentence extraction. No LLM calls,
// so it's fast, predictable, and always available as a fallback.
//
// Used in two ways:
// 1. As the "verbatim cleaner" for short messages (just strips markdown/formatting)
// 2. As a full summarizer backend when OCODE_VOICE_SUMMARIZER=deterministic
// 3. As the automatic fallback when the LLM summarizer fails

// Clean and summarize text to at most `maxChars` characters.
// Strategy: strip code blocks, inline code, markdown formatting, images, links,
// and @-mentions, then take the first few sentences that fit within the limit.
export function summarizeDeterministic(text: string, maxChars = 280): string {
  let clean = text

  // Remove fenced code blocks (```...```) — replace with space to avoid word merging
  clean = clean.replace(/```[\s\S]*?```/g, " ")
  // Remove inline code (`...`)
  clean = clean.replace(/`[^`]*`/g, " ")

  // Remove markdown headings (#, ##, ###, etc.)
  clean = clean.replace(/^#{1,6}\s+/gm, "")
  // Remove unordered list markers (-, *, +)
  clean = clean.replace(/^\s*[-*+]\s+/gm, "")
  // Remove ordered list markers (1., 2., etc.)
  clean = clean.replace(/^\s*\d+\.\s+/gm, "")

  // Remove image syntax ![alt](url)
  clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
  // Remove link syntax [text](url) — keeps the text but drops the URL
  clean = clean.replace(/\[[^\]]*\]\([^)]*\)/g, " ")

  // Remove @-mentions (e.g. @username)
  clean = clean.replace(/@\S+/g, " ")

  // Collapse multiple blank lines into single newlines, then collapse all whitespace
  clean = clean.replace(/\n{2,}/g, "\n")
  clean = clean.replace(/\s+/g, " ").trim()

  // Try to extract whole sentences that fit within maxChars.
  // Matches sequences ending with ., !, or ? followed by the punctuation.
  const sentences = clean.match(/[^.!?]+[.!?]+/g)
  if (sentences) {
    let result = ""
    for (const s of sentences) {
      // Stop adding sentences if we'd exceed the char limit
      if ((result + s).length > maxChars) break
      result += s
    }
    result = result.trim()
    if (result) return result
  }

  // If no sentence boundaries were found or the first sentence is too long,
  // just truncate to maxChars at the last word boundary.
  if (clean.length <= maxChars) return clean
  const cut = clean.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(" ")
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
}