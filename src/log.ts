// Unified structured logger — writes to both a persistent log file and the console.
// Log file: ~/.config/opencode/voice-reply/ping.log
// Use `tail -f ~/.config/opencode/voice-reply/ping.log` to debug ping flows.
//
// Levels (lowest to highest priority): debug < info < warn < error
// Controlled by OCODE_VOICE_LOG_LEVEL env var (default: "info").

import { mkdirSync, appendFileSync, existsSync } from "fs"
import path from "path"
import os from "os"

const LOG_DIR = path.join(os.homedir(), ".config", "opencode", "voice-reply")
const LOG_FILE = path.join(LOG_DIR, "ping.log")

// If we can't create the log directory, we disable file logging but keep console output.
let fileLoggingEnabled = true

try {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
} catch {
  fileLoggingEnabled = false
}

export type LogLevel = "debug" | "info" | "warn" | "error"

// Numeric priority for each level — higher = more important.
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

// Read the configured log level from the env var, defaulting to "info".
function getCurrentLevel(): LogLevel {
  const env = process.env.OCODE_VOICE_LOG_LEVEL?.trim().toLowerCase()
  if (env === "debug") return "debug"
  if (env === "warn") return "warn"
  if (env === "error") return "error"
  return "info"
}

// A message should be logged only if its level is >= the configured level.
function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getCurrentLevel()]
}

// ISO timestamp for log lines.
function timestamp(): string {
  return new Date().toISOString()
}

// Format a structured log line: [timestamp] [LEVEL] [scope] message {extra JSON}
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

// Append a line to the log file (best-effort, swallows errors).
function writeToFile(line: string): void {
  if (!fileLoggingEnabled) return
  try {
    appendFileSync(LOG_FILE, line + "\n")
  } catch {}
}

// Core log function — writes to file always (if level passes), and to console
// based on level: errors go to stderr, warnings to stderr, debug to stdout,
// info is console-only when debug-level logging is enabled.
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

// Convenience wrappers for each log level.
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

// Returns the absolute path to the log file (useful for display/debugging).
export function getLogPath(): string {
  return LOG_FILE
}