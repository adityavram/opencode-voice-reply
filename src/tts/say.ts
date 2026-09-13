// macOS "say" TTS backend — uses the built-in `say` command line tool.
// This is the simplest backend: no API key needed, works offline, but voice
// quality is limited to macOS system voices.
//
// Configuration env vars:
//   OCODE_VOICE_NAME — voice name (default: "Samantha")
//   OCODE_VOICE_RATE — words per minute (default: system rate)

// Track the currently-running `say` subprocess so we can kill it on interrupt.
let currentProc: ReturnType<typeof Bun.spawn> | null = null

// Speak the given text using the macOS `say` command.
// Always calls stop() first to kill any previously-playing speech.
export async function speak(text: string): Promise<void> {
  stop()

  const voice = process.env.OCODE_VOICE_NAME?.trim() || "Samantha"
  const rate = process.env.OCODE_VOICE_RATE?.trim() || undefined

  // Escape double quotes in the text so it's safe to pass inside a quoted string
  const safe = text.replace(/"/g, '\\"')

  // Build the say command: say -v <voice> [-r <rate>] "<text>"
  let cmd = `say -v ${voice}`
  if (rate) cmd += ` -r ${rate}`
  cmd += ` "${safe}"`

  // Spawn the say process and track it so stop() can kill it
  const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "ignore", stderr: "ignore" })
  currentProc = proc

  try {
    await proc.exited
  } finally {
    // Clear the reference if this is still the active process
    if (currentProc === proc) currentProc = null
  }
}

// Kill the currently-playing `say` process (if any).
export function stop(): void {
  if (currentProc) {
    try {
      currentProc.kill("SIGTERM")
    } catch {}
    currentProc = null
  }
}