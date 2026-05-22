# opencode-voice

An [OpenCode](https://opencode.ai) plugin that adds text-to-speech capabilities using ElevenLabs voices with configurable model selection.

## Features

- **Configurable ElevenLabs models** - Defaults to `eleven_multilingual_v2`, with per-call overrides available
- **Audio Tags** - Control emotions, delivery, reactions, accents, and sound effects inline
- **Non-blocking** - Audio plays in background, control returns immediately
- **Per-agent voices** - Each agent can have its own voice via a local config file
- **Tagged auto-speak** - Speak only text wrapped in `<speak>...</speak>`
- **Runtime voice mode** - Turn tagged speech on/off without editing config
- **macOS Native** - Uses `afplay` for reliable audio playback

## Installation

1. Clone the plugin:
```bash
git clone https://github.com/rickross/opencode-voice.git ~/Projects/opencode-voice
cd ~/Projects/opencode-voice
bun install
```

2. Add your ElevenLabs API key:
```bash
mkdir -p ~/.config/opencode/secrets
echo "YOUR_API_KEY" > ~/.config/opencode/secrets/elevenlabs-key
```

3. Register the plugin in `~/.config/opencode/opencode.json`:
```json
{
  "plugin": [
    "file:///Users/YOUR_USERNAME/Projects/opencode-voice"
  ]
}
```

4. Restart OpenCode.

## Voice Configuration

Config is resolved in this order (later overrides earlier):

1. Built-in defaults
2. `voice.json` in the agent's working directory
3. Plugin options in `opencode.json`

### Per-agent voice (recommended for multi-agent setups)

Create a `voice.json` in each agent's project directory:

```json
{
  "voiceId": "your-voice-id-here",
  "modelId": "eleven_multilingual_v2",
  "enabled": "on"
}
```

For example, if your agents live in `~/horde/agents/`:
```
~/horde/agents/telos/voice.json
~/horde/agents/aurora/voice.json
~/horde/agents/kai/voice.json
```

Each agent loads its own voice on startup. No restart needed when switching between agents — each picks up its own config independently.

### Inline options in opencode.json

```json
{
  "plugin": [
    ["file:///Users/YOUR_USERNAME/Projects/opencode-voice", { "voiceId": "your-voice-id" }]
  ]
}
```

### All config options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `voiceId` | string | `YOq2y2Up4RgXP2HyXjE5` | ElevenLabs voice ID |
| `modelId` | string | `eleven_multilingual_v2` | ElevenLabs model ID |
| `apiKeyPath` | string | `~/.config/opencode/secrets/elevenlabs-key` | Path to API key file |
| `enabled` | `on \| off \| default` (or boolean) | `default` | Startup voice mode (`default` uses plugin default) |
| `stability` | 0-1 | 0.5 | Lower = more expressive |
| `similarityBoost` | 0-1 | 0.75 | Voice similarity |
| `style` | 0-1 | unset | Optional style exaggeration |
| `useSpeakerBoost` | boolean | unset | Optional speaker boost override |
| `preserveVoiceDefaults` | boolean | `false` | Omit request-level voice settings when true |
| `speed` | 0.5-2.0 | 1.0 | Speech speed |
| `volume` | 0-2 | 1.0 | Playback volume |

To find voice IDs, browse the [ElevenLabs Voice Library](https://elevenlabs.io/voice-library).

## Usage

The plugin provides a `speak` tool:

```
speak("[excited] Hello! [laughs] This is amazing!")
speak("[whispers] Something's coming... [sighs] I can feel it.")
speak("[dramatically] The code is complete.")
```

It also provides a `voice` tool for runtime control:

```
voice({ action: "status" })
voice({ action: "off" })
voice({ action: "on" })
```

## Tagged Auto-Speak

When a completed assistant message contains `<speak>...</speak>`, only the tagged portion is spoken.
The tags are stripped from visible output.

Example:

```xml
<speak>Say this part aloud.</speak> But keep this part text-only.
```

Visible output becomes:

```text
Say this part aloud. But keep this part text-only.
```

Only `Say this part aloud.` is spoken.

### Audio Tags

| Category | Examples |
|----------|----------|
| **Emotions** | `[laughs]`, `[sighs]`, `[excited]`, `[sad]`, `[angry]`, `[happily]`, `[sarcastic]`, `[curious]` |
| **Delivery** | `[whispers]`, `[shouts]`, `[dramatically]`, `[calmly]`, `[nervously]` |
| **Reactions** | `[laughs harder]`, `[giggles]`, `[clears throat]`, `[gasps]`, `[gulps]` |
| **Accents** | `[strong French accent]`, `[British accent]`, `[Southern US accent]` |
| **Sound FX** | `[applause]`, `[gunshot]`, `[explosion]` |

### Tool parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | string | required | Text with optional audio tags |
| `voiceId` | string | from config | Optional per-call ElevenLabs voice ID override |
| `modelId` | string | from config | Optional per-call ElevenLabs model ID override |
| `stability` | 0-1 | from config | Lower = more expressive |
| `similarity_boost` | 0-1 | from config | Voice similarity |
| `style` | 0-1 | from config | Optional style exaggeration override |
| `use_speaker_boost` | boolean | from config | Optional speaker boost override |
| `preserveVoiceDefaults` | boolean | from config | If true, omit request-level voice_settings |
| `speed` | 0.5-2.0 | from config | Speech speed |
| `volume` | 0-2 | from config | Playback volume |

### Best practices

- Short bursts only — task completion, errors, questions needing input
- 1-2 sentences max; don't read entire responses aloud

## Requirements

- macOS (uses `afplay` for audio playback)
- [Bun](https://bun.sh) runtime
- ElevenLabs API key with v3 access

## License

MIT
