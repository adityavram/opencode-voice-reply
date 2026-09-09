# opencode-voice-reply

An [opencode](https://opencode.ai) plugin that speaks a short summary back to you when the agent finishes its turn. Designed for voice-driven workflows (e.g. [Willow Voice](https://willowvoice.com)) where you talk to the agent but get no audio cue when it's done.

## How it works

1. The plugin hooks into opencode's `session.idle` event (fires when the agent finishes).
2. It fetches the last assistant message via the opencode SDK.
3. It extracts a heuristic summary (strips code blocks, takes first ~2 sentences).
4. It speaks the summary via macOS `say`.
5. It also shows a toast in the TUI for a visual cue.

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
| `OCODE_VOICE_TTS` | `say` | TTS backend (`say` for v1; `elevenlabs`/`openai`/`piper` planned) |
| `OCODE_VOICE_NAME` | `Samantha` | macOS `say` voice name |
| `OCODE_VOICE_RATE` | (system default) | Words per minute for `say` |
| `OCODE_VOICE_DISABLED` | `0` | Set to `1` to mute entirely |

### Available `say` voices

Run `say -v ?` to list all installed voices. Common choices: `Samantha`, `Alex`, `Daniel`, `Karen`, `Moira`.

## Project structure

```
src/
├── plugin.ts        # main: session.idle handler
├── summarize.ts     # heuristic text extraction
└── tts/
    ├── index.ts     # backend selector (env: OCODE_VOICE_TTS)
    └── say.ts       # macOS say backend
```

## Adding more TTS backends

The `src/tts/index.ts` selector is ready for more backends. To add one:

1. Create `src/tts/<name>.ts` exporting `speak(text: string): Promise<void>`.
2. Add a `case` in `src/tts/index.ts`.
3. Use the appropriate env var for API keys (e.g. `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`).

## License

MIT