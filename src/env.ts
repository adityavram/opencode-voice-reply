import { existsSync, readFileSync } from "fs"
import path from "path"

const loaded = new Set<string>()

export function loadEnvFile(filePath: string): void {
  if (loaded.has(filePath)) return
  loaded.add(filePath)
  if (!existsSync(filePath)) return

  const content = readFileSync(filePath, "utf8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

export function loadPluginEnv(): void {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(new URL(import.meta.url).pathname), ".env"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env"),
  ]
  for (const c of candidates) loadEnvFile(c)
}