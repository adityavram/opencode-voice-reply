# opencode-voice-reply

An [opencode](https://opencode.ai) plugin that speaks a short summary back to you when the agent finishes its turn. Designed for voice-driven workflows (e.g. [Willow Voice](https://willowvoice.com)) where you talk to the agent but get no audio cue when it's done.

## How it works

1. The plugin hooks into opencode's `session.idle` event (fires when the agent finishes).
2. It fetches the last assistant message via the opencode SDK.
3. It extracts a heuristic summary (strips code blocks, takes first ~2 sentences).
4. It speaks the summary via macOS `say`.
5. It also shows a toast in the TUI for a visual cue.

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

## Short messages read verbatim

Messages at or below `OCODE_VOICE_VERBATIM_THRESHOLD` (default 220 chars) skip the LLM summarizer and are read directly (after stripping code blocks and markdown). This avoids the LLM cold-start timeout for quick replies like "Done." or "Got it." and ensures you always hear something useful.

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

All config is via environment variables (set in your shell or `~/.config/opencode/plugins/` env):

| Var | Default | Purpose |
|---|---|---|
| `OCODE_VOICE_TTS` | `elevenlabs` | TTS backend: `elevenlabs` or `say` |
| `OCODE_VOICE_NAME` | `Samantha` | macOS `say` voice name (only for `say` backend) |
| `OCODE_VOICE_RATE` | (system default) | Words per minute for `say` |
| `OCODE_VOICE_DISABLED` | `0` | Set to `1` to mute entirely (also toggleable via `/voice`) |
| `OCODE_VOICE_SUMMARIZER` | `llm` | Summarizer backend: `llm` (Ollama) or `deterministic` (heuristic) |
| `OCODE_VOICE_VERBATIM_THRESHOLD` | `220` | Messages at or below this char length are read verbatim (no LLM call) |
| `OCODE_VOICE_OLLAMA_URL` | `https://api.ollama.com` | Ollama API base URL (cloud or local) |
| `OCODE_VOICE_OLLAMA_MODEL` | `mistral-large-3:675b` | Ollama model for summarization |
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

### Available `say` voices

Run `say -v ?` to list all installed voices. Common choices: `Samantha`, `Alex`, `Daniel`, `Karen`, `Moira`.

## Project structure

```
src/
├── plugin.ts                    # main: session.idle handler + /voice command + interrupt listeners
├── summarize.ts                 # orchestrator: verbatim for short, LLM with deterministic fallback
├── summarize-deterministic.ts   # heuristic text extraction (fallback + verbatim cleaner)
├── summarize-llm.ts             # Ollama-powered LLM summarization
├── state.ts                     # toggle state file (~/.config/opencode/voice-reply/disabled)
└── tts/
    ├── index.ts                 # backend selector (env: OCODE_VOICE_TTS) + stop()
    ├── say.ts                   # macOS say backend with PID tracking for kill
    └── elevenlabs.ts            # ElevenLabs HTTP API + afplay playback
```

## Adding more TTS backends

The `src/tts/index.ts` selector is ready for more backends. To add one:

1. Create `src/tts/<name>.ts` exporting `speak(text: string): Promise<void>` and `stop(): void`.
2. Add a `case` in `src/tts/index.ts`.
3. Use the appropriate env var for API keys.

## License

MIT