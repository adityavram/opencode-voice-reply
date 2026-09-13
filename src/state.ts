// Persists the plugin's on/off toggles and ping mode to disk so they survive
// across opencode restarts. State files live in ~/.config/opencode/voice-reply/.
// Env vars are checked first and take precedence over state files.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import path from "path"
import os from "os"

const STATE_DIR = path.join(os.homedir(), ".config", "opencode", "voice-reply")
const STATE_FILE = path.join(STATE_DIR, "disabled")
const PING_STATE_FILE = path.join(STATE_DIR, "ping-disabled")
const PING_MODE_FILE = path.join(STATE_DIR, "ping-mode")

export function isVoiceDisabled(): boolean {
  if (process.env.OCODE_VOICE_DISABLED === "1") return true
  return existsSync(STATE_FILE)
}

export function setVoiceDisabled(disabled: boolean): void {
  if (disabled) {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, new Date().toISOString())
  } else {
    try {
      unlinkSync(STATE_FILE)
    } catch {}
  }
}

export function toggleVoice(): boolean {
  const newState = !isVoiceDisabled()
  setVoiceDisabled(newState)
  return newState
}

export function readStateFile(): string | null {
  try {
    return readFileSync(STATE_FILE, "utf8").trim()
  } catch {
    return null
  }
}

export function isPingDisabled(): boolean {
  if (process.env.OCODE_VOICE_PING_DISABLED === "1") return true
  return existsSync(PING_STATE_FILE)
}

export function setPingDisabled(disabled: boolean): void {
  if (disabled) {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(PING_STATE_FILE, new Date().toISOString())
  } else {
    try {
      unlinkSync(PING_STATE_FILE)
    } catch {}
  }
}

export function togglePing(): boolean {
  const newState = !isPingDisabled()
  setPingDisabled(newState)
  return newState
}

export type PingMode = "call" | "sms" | "escalate"

export function getPingMode(): PingMode {
  const env = process.env.OCODE_VOICE_PING_MODE?.trim().toLowerCase()
  if (env === "sms") return "sms"
  if (env === "escalate") return "escalate"
  try {
    const file = readFileSync(PING_MODE_FILE, "utf8").trim().toLowerCase()
    if (file === "sms") return "sms"
    if (file === "escalate") return "escalate"
  } catch {}
  return "call"
}

export function setPingMode(mode: PingMode): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(PING_MODE_FILE, mode)
}