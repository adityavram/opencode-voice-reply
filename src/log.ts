// Unified structured logger — writes to both a persistent log file
// (~/.config/opencode/voice-reply/ping.log) and the console.
// Use `tail -f ~/.config/opencode/voice-reply/ping.log` to debug ping flows.
// Levels: debug < info < warn < error, controlled by OCODE_VOICE_LOG_LEVEL.

import { mkdirSync, appendFileSync, existsSync } from "fs"
import path from "path"
import os from "os"

const LOG_DIR = path.join(os.homedir(), ".config", "opencode", "voice-reply")
const LOG_FILE = path.join(LOG_DIR, "ping.log")

let fileLoggingEnabled = true

try {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
} catch {
  fileLoggingEnabled = false
}

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getCurrentLevel(): LogLevel {
  const env = process.env.OCODE_VOICE_LOG_LEVEL?.trim().toLowerCase()
  if (env === "debug") return "debug"
  if (env === "warn") return "warn"
  if (env === "error") return "error"
  return "info"
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getCurrentLevel()]
}

function timestamp(): string {
  return new Date().toISOString()
}

function formatLine(level: LogLevel, scope: string, message: string, extra?: Record<string, unknown>): string {
  const base = `[${timestamp()}] [${level.toUpperCase()}] [${scope}] ${message}`
  if (extra && Object.keys(extra).length > 0) {
    try {
      return `${base} ${JSON.stringify(extra)}`
    } catch {
      return `${base} {unserializable extra}`
    }
  }
  return base
}

function writeToFile(line: string): void {
  if (!fileLoggingEnabled) return
  try {
    appendFileSync(LOG_FILE, line + "\n")
  } catch {}
}

export function log(level: LogLevel, scope: string, message: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return
  const line = formatLine(level, scope, message, extra)
  writeToFile(line)
  if (level === "error") {
    console.error(line)
  } else if (level === "warn") {
    console.warn(line)
  } else if (shouldLog("debug")) {
    console.log(line)
  }
}

export function debug(scope: string, message: string, extra?: Record<string, unknown>): void {
  log("debug", scope, message, extra)
}

export function info(scope: string, message: string, extra?: Record<string, unknown>): void {
  log("info", scope, message, extra)
}

export function warn(scope: string, message: string, extra?: Record<string, unknown>): void {
  log("warn", scope, message, extra)
}

export function error(scope: string, message: string, extra?: Record<string, unknown>): void {
  log("error", scope, message, extra)
}

export function getLogPath(): string {
  return LOG_FILE
}