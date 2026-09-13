// State management — persists the plugin's on/off toggles and ping mode to disk
// so they survive across opencode restarts. State files live in
// ~/.config/opencode/voice-reply/. Env vars can also override state (checked first).

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import path from "path"
import os from "os"

// Directory where all state files are stored
const STATE_DIR = path.join(os.homedir(), ".config", "opencode", "voice-reply")
// Presence of this file means voice reply is disabled
const STATE_FILE = path.join(STATE_DIR, "disabled")
// Presence of this file means phone ping is disabled
const PING_STATE_FILE = path.join(STATE_DIR, "ping-disabled")
// Contains the current ping mode: "call", "sms", or "escalate"
const PING_MODE_FILE = path.join(STATE_DIR, "ping-mode")

// Voice is disabled if either the env var is set to "1" or the state file exists.
export function isVoiceDisabled(): boolean {
  if (process.env.OCODE_VOICE_DISABLED === "1") return true
  return existsSync(STATE_FILE)
}

// Enable or disable voice reply by creating/removing the state file.
// The file content is just a timestamp for debugging purposes.
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

// Toggle voice on/off and return the new state (true = enabled).
export function toggleVoice(): boolean {
  const newState = !isVoiceDisabled()
  setVoiceDisabled(newState)
  return newState
}

// Read the raw contents of the voice state file (used for debugging/display).
export function readStateFile(): string | null {
  try {
    return readFileSync(STATE_FILE, "utf8").trim()
  } catch {
    return null
  }
}

// Phone ping is disabled if either the env var is set to "1" or the state file exists.
export function isPingDisabled(): boolean {
  if (process.env.OCODE_VOICE_PING_DISABLED === "1") return true
  return existsSync(PING_STATE_FILE)
}

// Enable or disable phone ping by creating/removing the state file.
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

// Toggle phone ping on/off and return the new state (true = enabled).
export function togglePing(): boolean {
  const newState = !isPingDisabled()
  setPingDisabled(newState)
  return newState
}

// The three available ping modes:
// - "call": Twilio phone call with synthesized audio
// - "sms": Telegram text message with force_reply
// - "escalate": Telegram text first, then phone call if high urgency & no reply
export type PingMode = "call" | "sms" | "escalate"

// Read the current ping mode. Env var takes precedence, then the state file,
// then defaults to "call".
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

// Persist the ping mode to the state file.
export function setPingMode(mode: PingMode): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(PING_MODE_FILE, mode)
}