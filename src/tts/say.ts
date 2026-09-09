export async function speak(text: string): Promise<void> {
  const voice = process.env.OCODE_VOICE_NAME ?? "Samantha"
  const rate = process.env.OCODE_VOICE_RATE

  const safe = text.replace(/"/g, '\\"')

  let cmd = `say -v ${voice}`
  if (rate) cmd += ` -r ${rate}`
  cmd += ` "${safe}"`

  await Bun.$`${{ raw: cmd }}`
}