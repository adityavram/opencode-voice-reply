# opencode-voice-reply

An opencode plugin that speaks a summary back to the user when the agent finishes its turn, and can also notify the user (via Telegram text, Twilio phone call, or escalation from text to call) when the agent needs permission approval.

## Architecture

- **Plugin entry**: `src/plugin.ts` — subscribes to `session.idle` (speak summary and/or ping on idle), `tui.command.execute` (interrupt on Enter/interrupt), `permission.updated` / `permission.asked` / `permission.v2.asked` (announce permission prompts — tries phone ping first if enabled, falls back to local speech), watches the Willow Voice Recordings directory for new `.opus` files (interrupt on FN press), and handles the `/voice` and `/ping` slash commands via `command.execute.before`. Tracks `activeSessionId`, `pingInFlight`, and `idlePingTimer` state for phone ping session injection and idle ping scheduling.
- **Toggle state**: `src/state.ts` — persists enabled/disabled state in `~/.config/opencode/voice-reply/disabled` (voice) and `~/.config/opencode/voice-reply/ping-disabled` (phone ping). `isVoiceDisabled()` / `isPingDisabled()` check both env vars and state files. `toggleVoice()` / `togglePing()` write/remove the files. Also persists ping mode (`call`, `sms`, `escalate`) in `~/.config/opencode/voice-reply/ping-mode` via `getPingMode()` / `setPingMode()`.
- **Env loader**: `src/env.ts` — loads `.env` files from cwd, the plugin's own directory, and its parent. Only sets env vars that aren't already in `process.env`.
- **Summarizer orchestrator**: `src/summarize.ts` — if text is short (≤ `OCODE_VOICE_VERBATIM_THRESHOLD` for voice, ≤ `OCODE_VOICE_TEXT_VERBATIM_THRESHOLD` for text), reads it verbatim via the deterministic cleaner (no LLM call). Otherwise picks between LLM and deterministic backends based on `OCODE_VOICE_SUMMARIZER`. LLM failures fall back to deterministic automatically. `summarize()` uses voice style; `summarizeForText()` uses text style (longer, third person).
- **Deterministic summarizer**: `src/summarize-deterministic.ts` — heuristic extraction: strips code blocks, inline code, markdown headings/lists, image/link syntax, @-mentions; takes first ~2 sentences up to max chars (default 280 for voice, configurable for text). Also used as the verbatim cleaner for short messages.
- **LLM summarizer**: `src/summarize-llm.ts` — calls Ollama's `/api/chat` endpoint with voice or text system prompts. Voice prompt: 1-2 sentences, first person, max 30 words. Text prompt: 2-3 sentences, third person, max 60 words. Configurable via `OCODE_VOICE_OLLAMA_URL`, `OCODE_VOICE_OLLAMA_MODEL`, `OCODE_VOICE_OLLAMA_TOKEN`. Handles reasoning models that return content in a `thinking` field instead of `content` (extracts the summary from the thinking text). `num_predict: 200` for voice, `300` for text.
- **TTS**: `src/tts/` — pluggable backend selected by `OCODE_VOICE_TTS` env var. Implements `say` (macOS built-in) and `elevenlabs` (ElevenLabs HTTP API). Both backends track the active playback subprocess PID so it can be killed via `stop()`. ElevenLabs fetches audio to a temp file and plays via `afplay`. `elevenlabs.ts` also exports `synthesize()` which returns raw audio bytes without playing — used by the phone ping for call audio generation. Structure ready for additional backends (OpenAI TTS, Piper).
- **Phone ping**: `src/ping/` — three ping modes selected by `getPingMode()`:
  - **SMS mode** (`sms`) — sends a Telegram message with `force_reply`, polls for the user's reply via long-poll `getUpdates`, and injects the reply back into the opencode session as a synthetic user message via `client.session.promptAsync()`.
  - **Call mode** (`call`) — places a Twilio phone call that plays an ElevenLabs-generated audio message and captures the user's spoken response via Twilio `<Gather>`. The transcribed response is injected back into the session.
  - **Escalate mode** (`escalate`) — sends a Telegram text first, waits for a reply; if urgency is high and no reply within `OCODE_VOICE_PING_ESCALATION_TIMEOUT`, escalates to a phone call.
  - **Orchestrator**: `src/ping/index.ts` — `textPing()` sends Telegram → polls for reply → injects into session. `pingPhone()` synthesizes ElevenLabs audio → starts ephemeral HTTP server → places Twilio call → awaits Gather webhook response → injects transcription into session → cleans up. `pingWithEscalation()` classifies urgency → sends text → optionally escalates to call. Prefixes messages with "OpenCode: " unless already prefixed.
  - **Twilio client**: `src/ping/twilio.ts` — `placeCall()` POSTs to Twilio's Calls API with Basic auth. `getCallStatus()` polls call status for cleanup. `sendSMS()` POSTs to Messages API (implemented but not used by main flow — Telegram is used for text mode). `isTwilioConfigured()` checks all required env vars. `getTwilioConfig()` reads and validates config from env.
  - **Audio server**: `src/ping/audio-server.ts` — ephemeral HTTP server (default port 8088) that serves TwiML with `<Gather>` + `<Play>`, the audio file at `/audio.mp3`, and handles POST `/gather` webhook where Twilio sends the transcribed speech. Exposes `responsePromise` that resolves with the transcription (or null on timeout/no speech). Auto-shuts down after `OCODE_VOICE_PING_LIFETIME_MS` (default 120s, max 300s). The TwiML uses `<Gather input="speech">` so the user's reply is captured and transcribed by Twilio.
  - **Telegram client**: `src/ping/telegram.ts` — `sendTelegram()` POSTs to Telegram Bot API `sendMessage` with `force_reply` so the user's chat prompts for a reply. `waitForTelegramReply()` long-polls `getUpdates` filtering for messages that reply to the sent message ID. `clearTelegramUpdates()` drains pending updates on startup and before polling to avoid stale messages.
  - **Urgency classifier**: `src/ping/urgency.ts` — `classifyUrgency()` first runs a heuristic (`classifyUrgencyHeuristic()`) matching destructive/irreversible/production/security patterns. If heuristic is definitive (high/low), returns immediately. If ambiguous (has shell/write ops but no explicit destructive keywords), falls back to LLM classification (`classifyUrgencyWithLLM()`) which asks Ollama to classify as "high" or "low". LLM failures default to low.
  - **ntfy notification**: `src/ping/ntfy.ts` — `sendNtfy()` POSTs to an ntfy.sh topic. Implemented and exported but not wired into the main ping flow.
- **Logger**: `src/log.ts` — unified structured logging that writes to both `~/.config/opencode/voice-reply/ping.log` (persistent file) and console (stderr for errors, stdout for debug). Levels: `debug`, `info`, `warn`, `error`, controlled by `OCODE_VOICE_LOG_LEVEL` (default `info`). Every ping flow step is logged: config validation, audio synthesis, server start/stop, TwiML/audio requests, Gather webhook contents, call placement, status polling, session injection, Telegram send/poll. Use `tail -f ~/.config/opencode/voice-reply/ping.log` to debug.

## Key patterns

- The plugin is a single TypeScript file loaded by opencode's plugin system (globally via `~/.config/opencode/plugins/` or per-project via `opencode.json`/`opencode.jsonc`).
- All I/O goes through the opencode SDK `client` (messages, toasts, logs) and Bun's `$` shell (for `say`).
- `tts/say.ts` and `tts/elevenlabs.ts` both track the active `Bun.spawn` process in a module-level variable. `stop()` sends `SIGTERM` and nulls the reference. `speak()` calls `stop()` first to kill any in-flight speech before starting new.
- ElevenLabs `synthesize()` returns raw `ArrayBuffer` audio bytes. `speak()` wraps it with file writing + `afplay` playback. The phone ping uses `synthesize()` directly for call audio.
- ElevenLabs backend fetches audio bytes to `/tmp/voice-reply-<ts>.mp3`, then plays via `afplay` (configurable via `ELEVENLABS_PLAYER`), and cleans up the temp file after playback.
- Willow Voice interrupt: `fs.watch()` on the Recordings directory fires on any event (macOS is inconsistent between `rename`/`change`). The plugin snapshots known recordings at startup and triggers when new `.opus` files appear.
- Permission announcement: when a `permission.updated`, `permission.asked`, or `permission.v2.asked` event fires, the plugin interrupts any in-flight speech. If phone ping is enabled and the mode's requirements are met (Telegram for sms, Twilio+ngrok for call, both for escalate), it pings via the configured mode. The user can reply (text or speech) and it's injected back into the session. Falls back to local speech on ping failure.
- Ping mode routing: `sms` → `textPing()` (Telegram only). `call` → `pingPhone()` (requires ngrok URL). `escalate` → `pingWithEscalation()` (Telegram first, call if high urgency and no reply within timeout).
- Text ping flow: `sendTelegram()` (with `force_reply`) → `waitForTelegramReply()` (long-polls `getUpdates`) → reply injected via `client.session.promptAsync()` (falls back to `client.session.prompt()` if `promptAsync` fails).
- Phone ping flow: ElevenLabs `synthesize()` → `startAudioServer()` (serves TwiML + audio through ngrok) → `placeCall()` → Twilio fetches TwiML → plays audio on the call → `<Gather>` captures user's spoken reply → Twilio POSTs transcription to `/gather` webhook → `responsePromise` resolves → transcription injected via `client.session.promptAsync()` → server shut down.
- Escalation flow: `classifyUrgency()` (heuristic first, LLM if ambiguous) → `textPing()` → if high urgency and no reply, wait `OCODE_VOICE_PING_ESCALATION_TIMEOUT` → `pingPhone()`.
- The audio server is ephemeral: starts per-ping, auto-closes after lifetime (120s default, max 300s) or when call completes or when Gather response arrives. `scheduleCallStatusCleanup()` polls Twilio call status as a backup cleanup mechanism and is cleared when the response arrives.
- `pingInFlight` flag in `plugin.ts` prevents concurrent phone calls/text pings.
- `idlePingTimer` in `plugin.ts` schedules a delayed idle ping (`OCODE_VOICE_PING_IDLE_DELAY`, default 10s). Cleared on user interrupt or when a new idle event arrives.
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
- Phone ping (call mode): start ngrok (`ngrok http 8088`), set `OCODE_VOICE_NGROK_URL`, Twilio env vars, and `/ping on`. Trigger a permission prompt — you should receive a phone call with the permission description spoken in your ElevenLabs voice. Speak your response and it should be injected back into the session.
- Phone ping (sms mode): set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, `/ping sms`, `/ping on`. Trigger a permission prompt — you should receive a Telegram message with `force_reply`. Reply with your instruction and it should be injected back into the session.
- Phone ping (escalate mode): set both Telegram and Twilio+ngrok env vars, `/ping escalate`, `/ping on`. Low-urgency prompts send text only; high-urgency prompts send text then escalate to a call if no reply within `OCODE_VOICE_PING_ESCALATION_TIMEOUT`.
- Unit tests: `npm run test:unit` (summarizers), `npm test` (all tests including twilio, audio-server, ping, urgency), `npm run test:timing` (LLM timing).

## Config env vars

| Var | Default | Purpose |
|---|---|---|
| `OCODE_VOICE_TTS` | `elevenlabs` | TTS backend: `elevenlabs` or `say` |
| `OCODE_VOICE_NAME` | `Samantha` | macOS `say` voice name (only for `say` backend) |
| `OCODE_VOICE_RATE` | (system default) | Words per minute for `say` |
| `OCODE_VOICE_DISABLED` | `0` | Set to `1` to mute entirely (also toggleable via `/voice`) |
| `OCODE_VOICE_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error`. Logs to `~/.config/opencode/voice-reply/ping.log` |
| `OCODE_VOICE_SUMMARIZER` | `llm` | Summarizer backend: `llm` (Ollama) or `deterministic` (heuristic) |
| `OCODE_VOICE_VERBATIM_THRESHOLD` | `220` | Messages at or below this char length are read verbatim (voice style, no LLM call) |
| `OCODE_VOICE_TEXT_VERBATIM_THRESHOLD` | `500` | Messages at or below this char length are sent verbatim (text style, no LLM call) |
| `OCODE_VOICE_OLLAMA_URL` | `https://api.ollama.com` | Ollama API base URL (cloud or local) |
| `OCODE_VOICE_OLLAMA_MODEL` | `mistral-large-3:675b` | Ollama model for summarization and urgency classification |
| `OCODE_VOICE_OLLAMA_TOKEN` | (none) | Optional bearer token for Ollama Cloud |
| `OCODE_VOICE_OLLAMA_TIMEOUT` | `10000` | LLM request timeout in ms |
| `ELEVENLABS_API_KEY` | (none) | ElevenLabs API key (required for `elevenlabs` backend) |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` | ElevenLabs voice ID (Rachel) |
| `ELEVENLABS_MODEL` | `eleven_turbo_v2_5` | ElevenLabs model |
| `ELEVENLABS_FORMAT` | `mp3_44100_128` | Output format |
| `ELEVENLABS_LATENCY_TIER` | (none) | Optimized latency tier if set |
| `ELEVENLABS_STABILITY` | (none) | Voice stability 0-1 |
| `ELEVENLABS_SIMILARITY_BOOST` | (none) | Similarity boost 0-1 |
| `ELEVENLABS_STYLE` | (none) | Style exaggeration 0-1 |
| `ELEVENLABS_SPEAKER_BOOST` | (none) | `1`/`true` to enable speaker boost |
| `ELEVENLABS_TIMEOUT` | `15000` | ElevenLabs request timeout in ms |
| `ELEVENLABS_PLAYER` | `afplay` | Audio player command (macOS default) |
| `OCODE_VOICE_PING_DISABLED` | `0` | Set to `1` to disable phone ping (also toggleable via `/ping`) |
| `OCODE_VOICE_PING_MODE` | `call` | Ping mode: `call`, `sms`, or `escalate` (also settable via `/ping sms`, `/ping call`, `/ping escalate`) |
| `OCODE_VOICE_PING_ON_IDLE` | `0` | Set to `1` to also ping on session.idle (not just permission prompts) |
| `OCODE_VOICE_PING_IDLE_DELAY` | `10000` | Delay in ms before sending an idle ping (gives user time to interrupt) |
| `OCODE_VOICE_PING_ESCALATION_TIMEOUT` | `60000` | Time in ms to wait for text reply before escalating to call (escalate mode) |
| `OCODE_VOICE_TEXT_REPLY_TIMEOUT` | `120000` | Time in ms to wait for Telegram reply before giving up (sms mode) |
| `OCODE_VOICE_NGROK_URL` | (none) | ngrok forwarding URL (e.g. `https://abc.ngrok.app`) — required for call mode |
| `OCODE_VOICE_PING_PORT` | `8088` | Local HTTP server port for phone ping (must match ngrok tunnel) |
| `OCODE_VOICE_PING_LIFETIME_MS` | `120000` | Max lifetime of ping HTTP server in ms (capped at 300000) |
| `OCODE_VOICE_GATHER_TIMEOUT` | `10` | Twilio Gather timeout in seconds |
| `OCODE_VOICE_GATHER_SILENCE` | `3` | Twilio Gather speech silence timeout in seconds |
| `TELEGRAM_BOT_TOKEN` | (none) | Telegram Bot API token — required for sms and escalate modes |
| `TELEGRAM_CHAT_ID` | (none) | Telegram chat ID to send messages to — required for sms and escalate modes |
| `TELEGRAM_TIMEOUT` | `10000` | Telegram API request timeout in ms |
| `TWILIO_ACCOUNT_SID` | (none) | Twilio Account SID — required for call and escalate modes |
| `TWILIO_AUTH_TOKEN` | (none) | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | (none) | Twilio phone number to call from |
| `TWILIO_TO_NUMBER` | (none) | Your phone number to call |
| `TWILIO_TIMEOUT` | `15000` | Twilio API request timeout in ms |
| `OCODE_VOICE_NTFY_TOPIC` | (none) | ntfy.sh topic name (ntfy backend is implemented but not wired into main flow) |
| `OCODE_VOICE_NTFY_URL` | `https://ntfy.sh` | ntfy server URL |
| `OCODE_VOICE_NTFY_TIMEOUT` | `10000` | ntfy request timeout in ms |

## Conventions

- No comments in source files unless explicitly requested.
- TypeScript, ESM modules.
- Peer dep on `@opencode-ai/plugin` (provided by opencode at runtime).