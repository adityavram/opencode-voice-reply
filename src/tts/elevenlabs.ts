// ElevenLabs TTS backend — calls the ElevenLabs HTTP API for high-quality
// neural voice synthesis. Requires ELEVENLABS_API_KEY.
//
// Two exports:
//   - speak(text): synthesize + play audio via afplay (for local voice reply)
//   - synthesize(text): return raw audio bytes (used by phone ping for call audio)
//
// Configuration env vars (all optional except ELEVENLABS_API_KEY):
//   ELEVENLABS_VOICE_ID       — voice ID (default: Rachel "21m00Tcm4TlvDq8ikWAM")
//   ELEVENLABS_MODEL          — model name (default: "eleven_turbo_v2_5")
//   ELEVENLABS_FORMAT         — output format (default: "mp3_44100_128")
//   ELEVENLABS_LATENCY_TIER   — optimized latency tier
//   ELEVENLABS_STABILITY      — voice stability 0-1
//   ELEVENLABS_SIMILARITY_BOOST — similarity boost 0-1
//   ELEVENLABS_STYLE          — style exaggeration 0-1
//   ELEVENLABS_SPEAKER_BOOST  — "1"/"true" to enable speaker boost
//   ELEVENLABS_TIMEOUT        — request timeout in ms (default: 15000)
//   ELEVENLABS_PLAYER         — audio player command (default: "afplay")

// Track the currently-playing audio subprocess so we can kill it on interrupt.
let currentProc: ReturnType<typeof Bun.spawn> | null = null

const DEFAULT_MODEL = "eleven_turbo_v2_5"
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"
const DEFAULT_FORMAT = "mp3_44100_128"
const DEFAULT_TIMEOUT_MS = 15000

// Read all ElevenLabs config from env vars, applying defaults.
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

// Synthesize text to audio bytes via the ElevenLabs API.
// Returns an ArrayBuffer of MP3 audio data.
// Used by the phone ping to generate audio for Twilio calls (without playing locally).
export async function synthesize(text: string): Promise<ArrayBuffer> {
  const cfg = getElevenLabsConfig()
  if (!cfg.apiKey) throw new Error("ELEVENLABS_API_KEY is not set")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs)

  try {
    // Build voice settings from env vars — only include the ones that are set
    const voiceSettings: Record<string, unknown> = {}
    if (cfg.stability) voiceSettings["stability"] = Number(cfg.stability)
    if (cfg.similarityBoost) voiceSettings["similarity_boost"] = Number(cfg.similarityBoost)
    if (cfg.style) voiceSettings["style"] = Number(cfg.style)
    if (cfg.speakerBoost) voiceSettings["use_speaker_boost"] = cfg.speakerBoost === "1" || cfg.speakerBoost === "true"

    // Construct the ElevenLabs TTS URL with query params for model and format
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

    // Return the raw audio bytes — caller decides whether to play or send
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

// Synthesize text and play it locally using the configured audio player.
// Always calls stop() first to kill any previously-playing audio.
// The audio is written to a temp file, played, then cleaned up.
export async function speak(text: string): Promise<void> {
  stop()

  // Step 1: synthesize the text to MP3 audio bytes
  const audioBuffer = await synthesize(text)

  // Step 2: write the audio to a temp file for the player to read
  const tmpPath = `/tmp/voice-reply-${Date.now()}.mp3`
  await Bun.write(tmpPath, audioBuffer)

  // Step 3: play the audio file using the configured player (default: afplay)
  const player = process.env.ELEVENLABS_PLAYER ?? "afplay"
  const proc = Bun.spawn([player, tmpPath], {
    stdout: "ignore",
    stderr: "ignore",
  })
  currentProc = proc

  try {
    await proc.exited
  } finally {
    // Clear the process reference and clean up the temp file
    if (currentProc === proc) currentProc = null
    try {
      await Bun.file(tmpPath).unlink()
    } catch {}
  }
}

// Kill the currently-playing audio process (if any).
export function stop(): void {
  if (currentProc) {
    try {
      currentProc.kill("SIGTERM")
    } catch {}
    currentProc = null
  }
}