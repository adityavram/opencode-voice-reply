let currentProc: ReturnType<typeof Bun.spawn> | null = null

const DEFAULT_MODEL = "eleven_turbo_v2_5"
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"
const DEFAULT_FORMAT = "mp3_44100_128"
const DEFAULT_TIMEOUT_MS = 15000

export async function speak(text: string): Promise<void> {
  stop()

  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set")

  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE
  const model = process.env.ELEVENLABS_MODEL ?? DEFAULT_MODEL
  const format = process.env.ELEVENLABS_FORMAT ?? DEFAULT_FORMAT
  const latencyTier = process.env.ELEVENLABS_LATENCY_TIER
  const stability = process.env.ELEVENLABS_STABILITY
  const similarityBoost = process.env.ELEVENLABS_SIMILARITY_BOOST
  const style = process.env.ELEVENLABS_STYLE
  const speakerBoost = process.env.ELEVENLABS_SPEAKER_BOOST

  const controller = new AbortController()
  const timeoutMs = Number(process.env.ELEVENLABS_TIMEOUT) || DEFAULT_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let audioBuffer: ArrayBuffer
  try {
    const voiceSettings: Record<string, unknown> = {}
    if (stability) voiceSettings["stability"] = Number(stability)
    if (similarityBoost) voiceSettings["similarity_boost"] = Number(similarityBoost)
    if (style) voiceSettings["style"] = Number(style)
    if (speakerBoost) voiceSettings["use_speaker_boost"] = speakerBoost === "1" || speakerBoost === "true"

    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`)
    url.searchParams.set("model_id", model)
    url.searchParams.set("output_format", format)
    if (latencyTier) url.searchParams.set("optimized_latency", latencyTier)

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        voice_settings: Object.keys(voiceSettings).length > 0 ? voiceSettings : undefined,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`ElevenLabs responded ${res.status}: ${errBody}`)
    }

    audioBuffer = await res.arrayBuffer()
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`ElevenLabs request timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

  const tmpPath = `/tmp/voice-reply-${Date.now()}.mp3`
  await Bun.write(tmpPath, audioBuffer)

  const player = process.env.ELEVENLABS_PLAYER ?? "afplay"
  const proc = Bun.spawn([player, tmpPath], {
    stdout: "ignore",
    stderr: "ignore",
  })
  currentProc = proc

  try {
    await proc.exited
  } finally {
    if (currentProc === proc) currentProc = null
    try {
      await Bun.file(tmpPath).unlink()
    } catch {}
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