import { speak as speakSay, stop as stopSay } from "./say"
import { speak as speakEleven, stop as stopEleven } from "./elevenlabs"

export type SpeakFn = (text: string) => Promise<void>

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