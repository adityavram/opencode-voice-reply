# opencode-voice-reply

An [opencode](https://opencode.ai) plugin that speaks a short summary back to you when the agent finishes its turn. Designed for voice-driven workflows (e.g. [Willow Voice](https://willowvoice.com)) where you talk to the agent but get no audio cue when it's done.

It can also **notify you when the agent needs your input** — via Telegram text, Twilio phone call, or escalation from text to call. You reply (by text or speech), and your response is injected back into the session. No need to be at your computer.

## How it works

1. The plugin hooks into opencode's `session.idle` event (fires when the agent finishes).
2. It fetches the last assistant message via the opencode SDK.
3. It summarizes the message — short messages are read verbatim, long ones go through an LLM summarizer (Ollama) with a deterministic fallback.
4. It speaks the summary via the configured TTS backend (ElevenLabs or macOS `say`).
5. It shows a toast in the TUI for a visual cue.

## Speech interruption

The plugin will immediately stop speaking when it detects that you want to take a turn:

- **Enter key / prompt submit** — Listening for `tui.command.execute` with `prompt.submit` or `session.interrupt`. If you hit Enter or interrupt while the agent is talking, speech stops.
- **Willow Voice FN key** — Watches the Willow Voice Recordings directory (`~/Library/Application Support/com.seewillow.WillowMac/Recordings/`). When a new `.opus` file appears (i.e. you pressed FN to start dictating), speech stops immediately — no need to wait until you release FN.

## Toggle audio with `/voice`

Use the `/voice` slash command to toggle audio on or off without restarting opencode:

- `/voice` — toggle on/off
- `/voice on` — enable
- `/voice off` — disable

The state persists in `~/.config/opencode/voice-reply/disabled`. The `OCODE_VOICE_DISABLED=1` env var still works and takes precedence.

## Phone ping (`/ping`)

When the agent needs your permission (or finishes a turn, if enabled), the plugin can notify you in three modes:

### SMS mode (Telegram text)

1. Sends a Telegram message with `force_reply` to your chat.
2. Long-polls Telegram for your reply.
3. Injects your reply back into the opencode session as a user message.

### Call mode (Twilio phone call)

1. ElevenLabs generates audio of the permission description in your voice.
2. A temporary HTTP server starts locally (served via ngrok).
3. Twilio places a call to your phone and plays the audio.
4. After the audio, Twilio listens for your spoken response (`<Gather input="speech">`).
5. Your response is transcribed and injected back into the opencode session.
6. The HTTP server shuts down automatically.

### Escalate mode (text first, call if high urgency)

1. Classifies the urgency of the prompt (heuristic first, LLM if ambiguous).
2. Sends a Telegram text message.
3. If you reply — done, no call needed.
4. If low urgency — done, text is sufficient.
5. If high urgency and no reply within `OCODE_VOICE_PING_ESCALATION_TIMEOUT` — escalates to a phone call.

### Setup

**SMS / escalate mode:**
1. Create a Telegram bot via [@BotFather](https://t.me/BotFather), get the bot token.
2. Get your chat ID (message [@userinfobot](https://t.me/userinfobot) or check `getUpdates`).
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` env vars.

**Call / escalate mode:**
1. Sign up at [twilio.com](https://twilio.com), get your Account SID, Auth Token, and a phone number.
2. Install and start ngrok to tunnel the local audio server:
   ```bash
   ngrok http 8088
   ```
3. Set `OCODE_VOICE_NGROK_URL` to the forwarding URL (e.g. `https://abc.ngrok.app`).
4. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_TO_NUMBER` env vars.

**Enable the ping:**
```
/ping sms      # text-only mode
/ping call     # phone call mode
/ping escalate # text first, call if high urgency
/ping on       # enable
```

Now when the agent hits a permission prompt, you'll be notified via the configured mode. Reply (by text or speech) and it goes back to the agent.

### Toggle phone ping with `/ping`

- `/ping` — toggle on/off
- `/ping on` — enable
- `/ping off` — disable
- `/ping sms` — set mode to Telegram text
- `/ping call` — set mode to Twilio phone call
- `/ping escalate` — set mode to text-first-then-call

The state persists in `~/.config/opencode/voice-reply/ping-disabled` and `~/.config/opencode/voice-reply/ping-mode`.

### Ping on session idle

By default, phone ping only fires on permission prompts. Set `OCODE_VOICE_PING_ON_IDLE=1` to also ping when the agent finishes a turn — useful if you're away from your desk and want the result spoken to you over the phone with the ability to reply.

### Fallback behavior

If the phone ping fails (Twilio not configured, ngrok down, etc.), the plugin falls back to local speech (`/voice`). If local speech is also disabled, nothing happens.

## Summarization

Short messages (≤ `OCODE_VOICE_VERBATIM_THRESHOLD` for voice, ≤ `OCODE_VOICE_TEXT_VERBATIM_THRESHOLD` for text) skip the LLM and are read directly after stripping code blocks and markdown. This avoids the LLM cold-start timeout for quick replies like "Done." or "Got it."

Longer messages use the configured backend (`OCODE_VOICE_SUMMARIZER`):
- **`llm`** (default): calls Ollama for a natural-language summary. Voice style: 1-2 sentences, first person, max 30 words. Text style: 2-3 sentences, third person, max 60 words. Falls back to deterministic on any failure.
- **`deterministic`**: heuristic extraction only (strips code blocks, markdown, takes first few sentences).

## Logging

All ping flow steps are logged to `~/.config/opencode/voice-reply/ping.log`. Control verbosity with `OCODE_VOICE_LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`).

```bash
tail -f ~/.config/opencode/voice-reply/ping.log
```

## Install

### Option A: Global plugin (recommended)

Copy `src/plugin.ts` (and the `src/summarize.ts`, `src/tts/` files) into your global plugins directory:

```bash
cp -r src ~/.config/opencode/plugins/voice-reply-src
# opencode loads .ts files in the plugins dir, but needs the imports to resolve
# Simplest: symlink the whole plugin
ln -s "$(pwd)/src/plugin.ts" ~/.config/opencode/plugins/voice-reply.ts
ln -s "$(pwd)/src/summarize.ts" ~/.config/opencode/plugins/summarize.ts
mkdir -p ~/.config/opencode/plugins/tts
ln -s "$(pwd)/src/tts/index.ts" ~/.config/opencode/plugins/tts/index.ts
ln -s "$(pwd)/src/tts/say.ts" ~/.config/opencode/plugins/tts/say.ts
```

### Option B: Project-level

Add to your project's `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/Users/you/projects/opencode-voice-reply/src/plugin.ts"]
}
```

### Option C: npm

```jsonc
{
  "plugin": ["opencode-voice-reply"]
}
```

Then restart opencode.

## Configuration

All config is via environment variables (set in your shell or `.env`):

### General

| Var | Default | Purpose |
|---|---|---|
| `OCODE_VOICE_TTS` | `elevenlabs` | TTS backend: `elevenlabs` or `say` |
| `OCODE_VOICE_NAME` | `Samantha` | macOS `say` voice name (only for `say` backend) |
| `OCODE_VOICE_RATE` | (system default) | Words per minute for `say` |
| `OCODE_VOICE_DISABLED` | `0` | Set to `1` to mute entirely (also toggleable via `/voice`) |
| `OCODE_VOICE_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `OCODE_VOICE_SUMMARIZER` | `llm` | Summarizer backend: `llm` (Ollama) or `deterministic` |
| `OCODE_VOICE_VERBATIM_THRESHOLD` | `220` | Messages at or below this char length are read verbatim (voice) |
| `OCODE_VOICE_TEXT_VERBATIM_THRESHOLD` | `500` | Messages at or below this char length are sent verbatim (text) |

### Ollama (LLM summarizer & urgency classifier)

| Var | Default | Purpose |
|---|---|---|
| `OCODE_VOICE_OLLAMA_URL` | `https://api.ollama.com` | Ollama API base URL (cloud or local) |
| `OCODE_VOICE_OLLAMA_MODEL` | `mistral-large-3:675b` | Ollama model for summarization and urgency classification |
| `OCODE_VOICE_OLLAMA_TOKEN` | (none) | Optional bearer token for Ollama Cloud |
| `OCODE_VOICE_OLLAMA_TIMEOUT` | `10000` | LLM request timeout in ms |

### ElevenLabs (TTS)

| Var | Default | Purpose |
|---|---|---|
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

### Phone ping

| Var | Default | Purpose |
|---|---|---|
| `OCODE_VOICE_PING_DISABLED` | `0` | Set to `1` to disable phone ping (also toggleable via `/ping`) |
| `OCODE_VOICE_PING_MODE` | `call` | Ping mode: `call`, `sms`, or `escalate` |
| `OCODE_VOICE_PING_ON_IDLE` | `0` | Set to `1` to also ping on session.idle |
| `OCODE_VOICE_PING_IDLE_DELAY` | `10000` | Delay in ms before sending an idle ping |
| `OCODE_VOICE_PING_ESCALATION_TIMEOUT` | `60000` | Time in ms to wait for text reply before escalating to call |
| `OCODE_VOICE_TEXT_REPLY_TIMEOUT` | `120000` | Time in ms to wait for Telegram reply (sms mode) |
| `OCODE_VOICE_NGROK_URL` | (none) | ngrok forwarding URL — required for call mode |
| `OCODE_VOICE_PING_PORT` | `8088` | Local HTTP server port (must match ngrok tunnel) |
| `OCODE_VOICE_PING_LIFETIME_MS` | `120000` | Max lifetime of ping HTTP server in ms (capped at 300000) |
| `OCODE_VOICE_GATHER_TIMEOUT` | `10` | Twilio Gather timeout in seconds |
| `OCODE_VOICE_GATHER_SILENCE` | `3` | Twilio Gather speech silence timeout in seconds |

### Telegram (sms & escalate modes)

| Var | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (none) | Telegram Bot API token — required for sms and escalate |
| `TELEGRAM_CHAT_ID` | (none) | Telegram chat ID to send messages to |
| `TELEGRAM_TIMEOUT` | `10000` | Telegram API request timeout in ms |

### Twilio (call & escalate modes)

| Var | Default | Purpose |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | (none) | Twilio Account SID — required for call and escalate |
| `TWILIO_AUTH_TOKEN` | (none) | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | (none) | Twilio phone number to call from |
| `TWILIO_TO_NUMBER` | (none) | Your phone number to call |
| `TWILIO_TIMEOUT` | `15000` | Twilio API request timeout in ms |

### ntfy (implemented but not wired into main flow)

| Var | Default | Purpose |
|---|---|---|
| `OCODE_VOICE_NTFY_TOPIC` | (none) | ntfy.sh topic name |
| `OCODE_VOICE_NTFY_URL` | `https://ntfy.sh` | ntfy server URL |
| `OCODE_VOICE_NTFY_TIMEOUT` | `10000` | ntfy request timeout in ms |

### Available `say` voices

Run `say -v ?` to list all installed voices. Common choices: `Samantha`, `Alex`, `Daniel`, `Karen`, `Moira`.

## Project structure

```
src/
├── plugin.ts                    # main: session.idle handler + /voice + /ping commands + interrupt listeners
├── state.ts                     # toggle state files + ping mode persistence
├── env.ts                       # .env loader (cwd, plugin dir, parent dir)
├── log.ts                       # structured logger (file + console)
├── summarize.ts                 # orchestrator: verbatim for short, LLM with deterministic fallback
├── summarize-deterministic.ts   # heuristic text extraction (fallback + verbatim cleaner)
├── summarize-llm.ts             # Ollama-powered LLM summarization (voice + text styles)
├── tts/
│   ├── index.ts                 # backend selector (env: OCODE_VOICE_TTS) + stop()
│   ├── say.ts                   # macOS say backend with PID tracking for kill
│   └── elevenlabs.ts            # ElevenLabs HTTP API + afplay playback + synthesize() for phone ping
└── ping/
    ├── index.ts                 # orchestrator: textPing / pingPhone / pingWithEscalation
    ├── twilio.ts                # Twilio Call API client (placeCall, getCallStatus, sendSMS)
    ├── audio-server.ts          # ephemeral HTTP server: TwiML + audio + Gather webhook
    ├── telegram.ts              # Telegram Bot API: sendMessage, getUpdates long-poll
    ├── urgency.ts               # urgency classifier (heuristic + LLM fallback)
    └── ntfy.ts                  # ntfy.sh client (not wired into main flow)
```

## Adding more TTS backends

The `src/tts/index.ts` selector is ready for more backends. To add one:

1. Create `src/tts/<name>.ts` exporting `speak(text: string): Promise<void>` and `stop(): void`.
2. Add a `case` in `src/tts/index.ts`.
3. Use the appropriate env var for API keys.

## Testing

- `npm run test:unit` — summarizer unit tests
- `npm test` — all tests (summarizers, twilio, audio-server, ping, urgency)
- `npm run test:timing` — LLM timing tests
- Run `say -v Samantha "test"` to confirm macOS TTS works.
- Start opencode, ask a question, and verify you hear the spoken reply when the turn ends.
- While speech is playing, hit Enter in the opencode prompt — speech should stop immediately.
- While speech is playing, press FN (Willow Voice) — speech should stop immediately.
- Trigger a permission prompt — you should hear "I need permission. <description>".
- Set `OCODE_VOICE_DISABLED=1` to mute for debugging.

## License

MIT