# OmniVoice — Capabilities

Provider name: `omnivoice`

OmniVoice is a local TTS provider running on a Mac via the `omnivoice-daemon`
process bundled with this repo (`daemon/`). It holds a model and a cached
`VoiceClonePrompt` in memory; each request only pays generation cost.

## What this provider is good at

- Fully local — no network call, no per-character cost, no third party
  sees what is being spoken.
- Fast on warm path (<1× real-time on M4-class hardware).
- Simple control surface — text in, audio out, minimal knobs.
- Per-agent voice cells loaded by the daemon at startup.

## What this provider is not

- Not multilingual — primary use is English; French is unreliable.
- No inline emotion / style / prosody tags. Delivery is whatever the
  voice cell produces.
- No code-switching — mid-utterance language transitions degrade.
- No structured control over emotional register or speaking style.

This provider was the cadre's first sovereign voice path before
Qwen3-TTS landed on Zion. It remains the right answer for a Mac
running offline, but Qwen3-TTS and Higgs Audio v3 supersede it for
networked use.

## Voice selection

The `voice` field selects which voice cell the daemon should use. Cells
are loaded by the daemon at startup from its configured voice
directory (typically per-agent: `solene`, `aurora`, `telos`, etc.).
Omitting `voice` falls back to the daemon's default voice.

## Inline control surface

None. The text being spoken is sent as-is to the daemon. Any inline
tags or annotations are spoken literally as words.

## Per-request parameters

| Field      | Type       | Effect                                         |
| ---------- | ---------- | ---------------------------------------------- |
| `numStep`  | integer    | Diffusion steps — 16 fast, 32 default quality  |
| `priority` | `"normal"` or `"high"` | Queue priority; high jumps ahead   |

`speed` from `TTSRequest` is honored if set.

## Voice cloning

Voice cells are pre-computed and live on the Mac in the daemon's
voice directory. Cloning a new voice is a separate offline step
(see `daemon/README.md`); the provider itself does not accept live
reference audio.

## When to use this provider

- Mac running offline (no Zion access).
- Lightweight English-only use cases where the warm-path latency is
  the dominant constraint.
- Backup when Qwen3-TTS or Higgs Audio v3 are down.

Default to Qwen3-TTS or Higgs Audio v3 when they are available.

## Configuration shape

```jsonc
{
  "endpoint": "http://127.0.0.1:7345",
  "timeoutMs": 60000,
  "voice": "solene",
  "agent": "solene"
}
```
