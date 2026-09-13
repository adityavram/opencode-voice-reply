// Env loader — reads .env files from multiple locations and populates process.env.
// Only sets variables that aren't already defined in the environment, so explicit
// environment variables always take precedence over .env file values.

import { existsSync, readFileSync } from "fs"
import path from "path"

// Track which files we've already loaded so we don't parse the same .env twice.
const loaded = new Set<string>()

// Parse a single .env file and set any new env vars into process.env.
// Skips blank lines and comments (lines starting with #). Strips surrounding
// quotes from values. Does NOT override vars that are already set in process.env.
export function loadEnvFile(filePath: string): void {
  if (loaded.has(filePath)) return
  loaded.add(filePath)
  if (!existsSync(filePath)) return

  const content = readFileSync(filePath, "utf8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    // Strip surrounding single or double quotes from the value
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    // Only set if not already present in the environment — explicit env vars win
    if (!(key in process.env)) process.env[key] = value
  }
}

// Load .env from three candidate locations, in order of priority:
// 1. The current working directory (project-level .env)
// 2. The plugin's own directory (plugin-bundled .env)
// 3. The plugin's parent directory (monorepo-style .env)
export function loadPluginEnv(): void {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(new URL(import.meta.url).pathname), ".env"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env"),
  ]
  for (const c of candidates) loadEnvFile(c)
}