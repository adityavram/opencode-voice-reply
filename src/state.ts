import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import path from "path"
import os from "os"

const STATE_DIR = path.join(os.homedir(), ".config", "opencode", "voice-reply")
const STATE_FILE = path.join(STATE_DIR, "disabled")
const PING_STATE_FILE = path.join(STATE_DIR, "ping-disabled")

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