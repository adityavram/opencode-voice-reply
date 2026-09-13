// TTS backend dispatcher — selects the speech synthesis backend based on the
// OCODE_VOICE_TTS env var. Currently supports:
//   - "elevenlabs" (default): ElevenLabs HTTP API for high-quality neural voices
//   - "say": macOS built-in speech synthesizer
//
// Both backends export `speak(text)` and `stop()`. The `stop()` function kills
// any in-flight playback so the caller can interrupt speech immediately.

import { speak as speakSay, stop as stopSay } from "./say"
import { speak as speakEleven, stop as stopEleven } from "./elevenlabs"

export type SpeakFn = (text: string) => Promise<void>

// Speak the given text using the configured TTS backend.
export async function speak(text: string): Promise<void> {
  const backend = process.env.OCODE_VOICE_TTS?.trim() || "elevenlabs"

  switch (backend) {
    case "say":
      return speakSay(text)
    case "elevenlabs":
      return speakEleven(text)
    default:
      throw new Error(
        `Unknown TTS backend "${backend}". Supported: say, elevenlabs. Set OCODE_VOICE_TTS accordingly.`
      )
  }
}

// Stop any currently-playing speech immediately.
export function stop(): void {
  const backend = process.env.OCODE_VOICE_TTS?.trim() || "elevenlabs"

  switch (backend) {
    case "say":
      return stopSay()
    case "elevenlabs":
      return stopEleven()
    default:
      break
  }
}