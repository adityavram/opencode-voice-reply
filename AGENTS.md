# opencode-voice-reply

An opencode plugin that speaks a summary back to the user when the agent finishes its turn.

## Architecture

- **Plugin entry**: `src/plugin.ts` — subscribes to opencode's `session.idle` event, fetches the last assistant message via the SDK client, extracts a summary, and speaks it via TTS.
- **Summarizer**: `src/summarize.ts` — heuristic extraction: strips code blocks, markdown, file refs; takes first ~2 sentences up to 280 chars.
- **TTS**: `src/tts/` — pluggable backend selected by `OCODE_VOICE_TTS` env var. v1 implements `say` (macOS built-in). Structure ready for ElevenLabs, OpenAI TTS, Piper.

## Key patterns

- The plugin is a single TypeScript file loaded by opencode's plugin system (globally via `~/.config/opencode/plugins/` or per-project via `opencode.json`).
- All I/O goes through the opencode SDK `client` (messages, toasts, logs) and Bun's `$` shell (for `say`).
- Errors are caught and logged via `client.app.log()` so a TTS failure never breaks the session.
- The `extractSessionId` helper checks multiple possible payload shapes for `session.idle` since the exact schema may vary.

## Testing

- Run `say -v Samantha "test"` to confirm macOS TTS works.
- Start opencode, ask a question, and verify you hear the spoken reply when the turn ends.
- Set `OCODE_VOICE_DISABLED=1` to mute for debugging.

## Config env vars

| Var | Default | Purpose |
|---|---|---|
| `OCODE_VOICE_TTS` | `say` | TTS backend |
| `OCODE_VOICE_NAME` | `Samantha` | say voice |
| `OCODE_VOICE_RATE` | (default) | words/min |
| `OCODE_VOICE_DISABLED` | `0` | mute flag |

## Conventions

- No comments in source files unless explicitly requested.
- TypeScript, ESM modules.
- Peer dep on `@opencode-ai/plugin` (provided by opencode at runtime).