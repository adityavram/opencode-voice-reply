# opencode-voice-reply

An opencode plugin that speaks a summary back to the user when the agent finishes its turn, and can also place a phone call (with bidirectional voice) when the agent needs permission approval.

## Architecture

- **Plugin entry**: `src/plugin.ts` — subscribes to `session.idle` (speak), `tui.command.execute` (interrupt on Enter/interrupt), `permission.updated` / `permission.asked` / `permission.v2.asked` (announce permission prompts — tries phone ping first if enabled, falls back to local speech), watches the Willow Voice Recordings directory for new `.opus` files (interrupt on FN press), and handles the `/voice` and `/ping` slash commands via `command.execute.before`. Tracks `activeSessionId` and `pingInFlight` state for phone ping session injection.
- **Toggle state**: `src/state.ts` — persists enabled/disabled state in `~/.config/opencode/voice-reply/disabled` (voice) and `~/.config/opencode/voice-reply/ping-disabled` (phone ping). `isVoiceDisabled()` / `isPingDisabled()` check both env vars and state files. `toggleVoice()` / `togglePing()` write/remove the files.
- **Summarizer orchestrator**: `src/summarize.ts` — if text is short (≤ `OCODE_VOICE_VERBATIM_THRESHOLD`, default 220 chars), reads it verbatim via the deterministic cleaner (no LLM call). Otherwise picks between LLM and deterministic backends based on `OCODE_VOICE_SUMMARIZER`. LLM failures fall back to deterministic automatically.
- **Deterministic summarizer**: `src/summarize-deterministic.ts` — heuristic extraction: strips code blocks, markdown, file refs; takes first ~2 sentences up to 280 chars. Also used as the verbatim cleaner for short messages.
- **LLM summarizer**: `src/summarize-llm.ts` — calls Ollama's `/api/chat` endpoint with a system prompt tuned for voice-friendly summaries. Configurable via `OCODE_VOICE_OLLAMA_URL`, `OCODE_VOICE_OLLAMA_MODEL`, `OCODE_VOICE_OLLAMA_TOKEN`. 10s timeout. Handles reasoning models that return content in a `thinking` field instead of `content` (extracts the summary from the thinking text). `num_predict: 200` to give reasoning models room to produce output.
- **TTS**: `src/tts/` — pluggable backend selected by `OCODE_VOICE_TTS` env var. v1 implements `say` (macOS built-in) and `elevenlabs` (ElevenLabs HTTP API). Both backends track the active playback subprocess PID so it can be killed via `stop()`. ElevenLabs fetches audio to a temp file and plays via `afplay`. `elevenlabs.ts` also exports `synthesize()` which returns raw audio bytes without playing — used by the phone ping for call audio generation. Structure ready for OpenAI TTS, Piper.
- **Phone ping**: `src/ping/` — places a Twilio phone call that plays an ElevenLabs-generated audio message and captures the user's spoken response via Twilio `<Gather>`. The transcribed response is injected back into the opencode session as a synthetic user message via `client.session.promptAsync()`.
  - **Orchestrator**: `src/ping/index.ts` — `pingPhone()` synthesizes ElevenLabs audio → starts ephemeral HTTP server → places Twilio call → awaits Gather webhook response → injects transcription into session → cleans up. Prefixes message with "opencode needs your attention." unless already prefixed. Polls Twilio call status as a backup cleanup mechanism.
  - **Twilio client**: `src/ping/twilio.ts` — `placeCall()` POSTs to Twilio's Calls API with Basic auth. `getCallStatus()` polls call status for cleanup. `isTwilioConfigured()` checks all required env vars. `getTwilioConfig()` reads and validates config from env.
  - **Audio server**: `src/ping/audio-server.ts` — ephemeral HTTP server (default port 8088) that serves TwiML with `<Gather>` + `<Play>`, the audio file at `/audio.mp3`, and handles POST `/gather` webhook where Twilio sends the transcribed speech. Exposes `responsePromise` that resolves with the transcription (or null on timeout/no speech). Auto-shuts down after `OCODE_VOICE_PING_LIFETIME_MS` (default 120s). The TwiML uses `<Gather input="speech">` so the user's reply is captured and transcribed by Twilio.
- **Logger**: `src/log.ts` — unified structured logging that writes to both `~/.config/opencode/voice-reply/ping.log` (persistent file) and console (stderr for errors, stdout for debug). Levels: `debug`, `info`, `warn`, `error`, controlled by `OCODE_VOICE_LOG_LEVEL` (default `info`). Every ping flow step is logged: config validation, audio synthesis, server start/stop, TwiML/audio requests, Gather webhook contents, call placement, status polling, session injection. Use `tail -f ~/.config/opencode/voice-reply/ping.log` to debug.

## Key patterns

- The plugin is a single TypeScript file loaded by opencode's plugin system (globally via `~/.config/opencode/plugins/` or per-project via `opencode.json`).
- All I/O goes through the opencode SDK `client` (messages, toasts, logs) and Bun's `$` shell (for `say`).
- `tts/say.ts` and `tts/elevenlabs.ts` both track the active `Bun.spawn` process in a module-level variable. `stop()` sends `SIGTERM` and nulls the reference. `speak()` calls `stop()` first to kill any in-flight speech before starting new.
- ElevenLabs `synthesize()` returns raw `ArrayBuffer` audio bytes. `speak()` wraps it with file writing + `afplay` playback. The phone ping uses `synthesize()` directly for call audio.
- ElevenLabs backend fetches audio bytes to `/tmp/voice-reply-<ts>.mp3`, then plays via `afplay` (configurable via `ELEVENLABS_PLAYER`), and cleans up the temp file after playback.
- Willow Voice interrupt: `fs.watch()` on the Recordings directory fires on any event (macOS is inconsistent between `rename`/`change`). The plugin snapshots known recordings at startup and triggers when new `.opus` files appear.
- Permission announcement: when a `permission.updated`, `permission.asked`, or `permission.v2.asked` event fires, the plugin interrupts any in-flight speech. If phone ping is enabled and configured (Twilio + ngrok URL), it places a phone call with the permission description. The user can speak their decision and it's injected back into the session. Falls back to local speech on ping failure.
- Phone ping flow: ElevenLabs `synthesize()` → `startAudioServer()` (serves TwiML + audio through ngrok) → `placeCall()` → Twilio fetches TwiML → plays audio on the call → `<Gather>` captures user's spoken reply → Twilio POSTs transcription to `/gather` webhook → `responsePromise` resolves → transcription injected via `client.session.promptAsync()` → server shut down.
- The audio server is ephemeral: starts per-ping, auto-closes after lifetime (120s) or when call completes or when Gather response arrives. `scheduleCallStatusCleanup()` polls Twilio call status as a backup cleanup mechanism and is cleared when the response arrives.
- `pingInFlight` flag in `plugin.ts` prevents concurrent phone calls.
- `activeSessionId` in `plugin.ts` tracks the last session for permission events that don't include a session ID.
- Errors are caught and logged via `client.app.log()` so a TTS or phone ping failure never breaks the session.
- The `extractSessionId` helper checks multiple possible payload shapes for `session.idle` since the exact schema may vary.
- The `describePermissionEvent` helper handles all three permission event types and reads from both `properties` (v1) and `data` (v2) fields to be resilient to schema variations.

## Testing

- Run `say -v Samantha "test"` to confirm macOS TTS works.
- Start opencode, ask a question, and verify you hear the spoken reply when the turn ends.
- While speech is playing, hit Enter in the opencode prompt — speech should stop immediately.
- While speech is playing, press FN (Willow Voice) — speech should stop immediately.
- Trigger a permission prompt (e.g. ask the agent to run a bash command) — you should hear "I need permission. <description>".
- Set `OCODE_VOICE_DISABLED=1` to mute for debugging.
- Phone ping: start ngrok (`ngrok http 8088`), set `OCODE_VOICE_NGROK_URL`, Twilio env vars, and `/ping on`. Trigger a permission prompt — you should receive a phone call with the permission description spoken in your ElevenLabs voice. Speak your response and it should be injected back into the session.
- Unit tests: `npm run test:unit` (summarizers), `node --import ./test/register-hooks.mjs --test --experimental-strip-types test/twilio.test.ts test/audio-server.test.ts test/ping.test.ts` (phone ping).

## Config env vars

| Var | Default | Purpose |
|---|---|---|
| `OCODE_VOICE_TTS` | `elevenlabs` | TTS backend |
| `OCODE_VOICE_NAME` | `Samantha` | say voice |
| `OCODE_VOICE_RATE` | (default) | words/min |
| `OCODE_VOICE_DISABLED` | `0` | mute flag |
| `OCODE_VOICE_LOG_LEVEL` | `info` | log level: `debug`, `info`, `warn`, `error` |
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
| `OCODE_VOICE_PING_DISABLED` | `0` | Set to `1` to disable phone ping |
| `OCODE_VOICE_PING_ON_IDLE` | `0` | Set to `1` to also ping on session.idle (not just permission prompts) |
| `OCODE_VOICE_NGROK_URL` | (none) | ngrok forwarding URL (e.g. `https://abc.ngrok.app`) — required for phone ping |
| `OCODE_VOICE_PING_PORT` | `8088` | Local HTTP server port for phone ping (must match ngrok tunnel) |
| `OCODE_VOICE_PING_LIFETIME_MS` | `120000` | Max lifetime of ping HTTP server in ms |
| `OCODE_VOICE_GATHER_TIMEOUT` | `10` | Twilio Gather timeout in seconds |
| `OCODE_VOICE_GATHER_SILENCE` | `3` | Twilio Gather speech silence timeout in seconds |
| `TWILIO_ACCOUNT_SID` | (none) | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | (none) | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | (none) | Twilio phone number to call from |
| `TWILIO_TO_NUMBER` | (none) | Your phone number to call |
| `TWILIO_TIMEOUT` | `15000` | Twilio API request timeout in ms |

## Conventions

- No comments in source files unless explicitly requested.
- TypeScript, ESM modules.
- Peer dep on `@opencode-ai/plugin` (provided by opencode at runtime).