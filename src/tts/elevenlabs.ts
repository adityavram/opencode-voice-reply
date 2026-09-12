let currentProc: ReturnType<typeof Bun.spawn> | null = null

const DEFAULT_MODEL = "eleven_turbo_v2_5"
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"
const DEFAULT_FORMAT = "mp3_44100_128"
const DEFAULT_TIMEOUT_MS = 15000

export function getElevenLabsConfig() {
  return {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE,
    model: process.env.ELEVENLABS_MODEL?.trim() || DEFAULT_MODEL,
    format: process.env.ELEVENLABS_FORMAT?.trim() || DEFAULT_FORMAT,
    latencyTier: process.env.ELEVENLABS_LATENCY_TIER?.trim() || undefined,
    stability: process.env.ELEVENLABS_STABILITY?.trim() || undefined,
    similarityBoost: process.env.ELEVENLABS_SIMILARITY_BOOST?.trim() || undefined,
    style: process.env.ELEVENLABS_STYLE?.trim() || undefined,
    speakerBoost: process.env.ELEVENLABS_SPEAKER_BOOST?.trim() || undefined,
    timeoutMs: Number(process.env.ELEVENLABS_TIMEOUT) || DEFAULT_TIMEOUT_MS,
  }
}

export async function synthesize(text: string): Promise<ArrayBuffer> {
  const cfg = getElevenLabsConfig()
  if (!cfg.apiKey) throw new Error("ELEVENLABS_API_KEY is not set")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs)

  try {
    const voiceSettings: Record<string, unknown> = {}
    if (cfg.stability) voiceSettings["stability"] = Number(cfg.stability)
    if (cfg.similarityBoost) voiceSettings["similarity_boost"] = Number(cfg.similarityBoost)
    if (cfg.style) voiceSettings["style"] = Number(cfg.style)
    if (cfg.speakerBoost) voiceSettings["use_speaker_boost"] = cfg.speakerBoost === "1" || cfg.speakerBoost === "true"

    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}`)
    url.searchParams.set("model_id", cfg.model)
    url.searchParams.set("output_format", cfg.format)
    if (cfg.latencyTier) url.searchParams.set("optimized_latency", cfg.latencyTier)

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": cfg.apiKey,
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

    return await res.arrayBuffer()
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`ElevenLabs request timed out after ${cfg.timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export async function speak(text: string): Promise<void> {
  stop()

  const audioBuffer = await synthesize(text)

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