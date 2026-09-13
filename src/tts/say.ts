// macOS "say" TTS backend — uses the built-in command line tool.
// No API key needed, works offline, but voice quality is limited to system voices.
// Config: OCODE_VOICE_NAME (default "Samantha"), OCODE_VOICE_RATE (words/min).

let currentProc: ReturnType<typeof Bun.spawn> | null = null

export async function speak(text: string): Promise<void> {
  stop()

  const voice = process.env.OCODE_VOICE_NAME?.trim() || "Samantha"
  const rate = process.env.OCODE_VOICE_RATE?.trim() || undefined

  const safe = text.replace(/"/g, '\\"')

  let cmd = `say -v ${voice}`
  if (rate) cmd += ` -r ${rate}`
  cmd += ` "${safe}"`

  const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "ignore", stderr: "ignore" })
  currentProc = proc

  try {
    await proc.exited
  } finally {
    if (currentProc === proc) currentProc = null
  }
}

export function stop(): void {
  if (currentProc) {
    try {
      currentProc.kill("SIGTERM")
    } catch {}
    currentProc = null
  }
}