import { speak as speakSay } from "./say"

export type SpeakFn = (text: string) => Promise<void>

export async function speak(text: string): Promise<void> {
  const backend = process.env.OCODE_VOICE_TTS ?? "say"

  switch (backend) {
    case "say":
      return speakSay(text)
    default:
      throw new Error(
        `Unknown TTS backend "${backend}". Supported: say. Set OCODE_VOICE_TTS accordingly.`
      )
  }
}