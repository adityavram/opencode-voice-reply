# opencode-voice-reply

An opencode plugin that speaks a summary back to the user when the agent finishes its turn.

## Architecture

- **Plugin entry**: `src/plugin.ts` — subscribes to `session.idle` (speak), `tui.command.execute` (interrupt on Enter/interrupt), watches the Willow Voice Recordings directory for new `.opus` files (interrupt on FN press), and handles the `/voice` slash command via `command.execute.before` to toggle audio on/off.
- **Toggle state**: `src/state.ts` — persists enabled/disabled state in `~/.config/opencode/voice-reply/disabled`. `isVoiceDisabled()` checks both the env var and the state file. `toggleVoice()` / `setVoiceDisabled()` write/remove the file.
- **Summarizer orchestrator**: `src/summarize.ts` — if text is short (≤ `OCODE_VOICE_VERBATIM_THRESHOLD`, default 220 chars), reads it verbatim via the deterministic cleaner (no LLM call). Otherwise picks between LLM and deterministic backends based on `OCODE_VOICE_SUMMARIZER`. LLM failures fall back to deterministic automatically.
- **Deterministic summarizer**: `src/summarize-deterministic.ts` — heuristic extraction: strips code blocks, markdown, file refs; takes first ~2 sentences up to 280 chars. Also used as the verbatim cleaner for short messages.
- **LLM summarizer**: `src/summarize-llm.ts` — calls Ollama's `/api/chat` endpoint with a system prompt tuned for voice-friendly summaries. Configurable via `OCODE_VOICE_OLLAMA_URL`, `OCODE_VOICE_OLLAMA_MODEL`, `OCODE_VOICE_OLLAMA_TOKEN`. 10s timeout. Handles reasoning models that return content in a `thinking` field instead of `content` (extracts the summary from the thinking text). `num_predict: 200` to give reasoning models room to produce output.
- **TTS**: `src/tts/` — pluggable backend selected by `OCODE_VOICE_TTS` env var. v1 implements `say` (macOS built-in) and `elevenlabs` (ElevenLabs HTTP API). Both backends track the active playback subprocess PID so it can be killed via `stop()`. ElevenLabs fetches audio to a temp file and plays via `afplay`. Structure ready for OpenAI TTS, Piper.

## Key patterns

- The plugin is a single TypeScript file loaded by opencode's plugin system (globally via `~/.config/opencode/plugins/` or per-project via `opencode.json`).
- All I/O goes through the opencode SDK `client` (messages, toasts, logs) and Bun's `$` shell (for `say`).
- `tts/say.ts` and `tts/elevenlabs.ts` both track the active `Bun.spawn` process in a module-level variable. `stop()` sends `SIGTERM` and nulls the reference. `speak()` calls `stop()` first to kill any in-flight speech before starting new.
- ElevenLabs backend fetches audio bytes to `/tmp/voice-reply-<ts>.mp3`, then plays via `afplay` (configurable via `ELEVENLABS_PLAYER`), and cleans up the temp file after playback.
- Willow Voice interrupt: `fs.watch()` on the Recordings directory fires on `rename` events (new file creation). The plugin snapshots known recordings at startup and triggers on new files only.
- Errors are caught and logged via `client.app.log()` so a TTS failure never breaks the session.
- The `extractSessionId` helper checks multiple possible payload shapes for `session.idle` since the exact schema may vary.

## Testing

- Run `say -v Samantha "test"` to confirm macOS TTS works.
- Start opencode, ask a question, and verify you hear the spoken reply when the turn ends.
- While speech is playing, hit Enter in the opencode prompt — speech should stop immediately.
- While speech is playing, press FN (Willow Voice) — speech should stop immediately.
- Set `OCODE_VOICE_DISABLED=1` to mute for debugging.

## Config env vars

| Var | Default | Purpose |
|---|---|---|
| `OCODE_VOICE_TTS` | `elevenlabs` | TTS backend |
| `OCODE_VOICE_NAME` | `Samantha` | say voice |
| `OCODE_VOICE_RATE` | (default) | words/min |
| `OCODE_VOICE_DISABLED` | `0` | mute flag |
| `OCODE_VOICE_SUMMARIZER` | `llm` | `llm` or `deterministic` |
| `OCODE_VOICE_VERBATIM_THRESHOLD` | `220` | char limit for verbatim reading |
| `OCODE_VOICE_OLLAMA_URL` | `https://api.ollama.com` | Ollama base URL (cloud or local) |
| `OCODE_VOICE_OLLAMA_MODEL` | `mistral-large-3:675b` | Ollama model |
| `OCODE_VOICE_OLLAMA_TOKEN` | (none) | Bearer token for Ollama Cloud |
| `OCODE_VOICE_OLLAMA_TIMEOUT` | `10000` | LLM request timeout in ms |
| `ELEVENLABS_API_KEY` | (none) | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` | ElevenLabs voice ID |
| `ELEVENLABS_MODEL` | `eleven_turbo_v2_5` | ElevenLabs model |
| `ELEVENLABS_FORMAT` | `mp3_44100_128` | Output format |
| `ELEVENLABS_TIMEOUT` | `15000` | ElevenLabs request timeout in ms |
| `ELEVENLABS_PLAYER` | `afplay` | Audio player command |

## Conventions

- No comments in source files unless explicitly requested.
- TypeScript, ESM modules.
- Peer dep on `@opencode-ai/plugin` (provided by opencode at runtime).