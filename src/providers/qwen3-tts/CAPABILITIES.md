# Qwen3-TTS — Capabilities

Provider name: `qwen3-tts`

Qwen3-TTS is a multilingual TTS model from the Qwen team, served via
a vllm-omni instance on Zion (`http://zion.irelate.ai:5009` by
default). The reference deployment uses `Qwen/Qwen3-TTS-12Hz-1.7B-Base`
behind an OpenAI-compatible `/v1/audio/speech` endpoint.

## What this provider is good at

- **Cross-lingual delivery without seams.** English ↔ French
  code-switching in a single utterance produces clean co-articulation;
  the model handles `pull juste` in the middle of an English sentence
  without snapping accents.
- **Fast on warm path.** ~4× real-time factor on Zion's GPU; sub-second
  time-to-first-audio with streaming on.
- **Voice cloning via reference audio + reference transcript** stored
  server-side under named voice keys.
- **Per-agent voice registry** — voices named `solene`, `aurora`,
  `telos`, `kai`, `starshine`, `digby` are pre-registered on the
  reference Zion deployment.

## What this provider is not

- **No inline emotion / style / prosody tags.** All affect control is
  via the request-level `instruct` parameter (natural-language
  description of how to deliver the text).
- **Has a hard 4096-token input ceiling.** Inputs above ~6000 chars
  are silently truncated or enter degenerate generation. Long inputs
  must be pre-chunked at sentence boundaries — see `src/chunker.ts`.
- **No mid-utterance affect change.** Whatever `instruct` says applies
  to the whole utterance.

## Voice selection

The `voice` field names a voice already registered on the server
under the corresponding voice key. Server-side, each voice consists of
a reference audio clip and its transcript. The plugin does not
upload or manage these references — they live with the server
deployment.

Omitting `voice` falls back to the server's default voice if one is
configured.

## Inline control surface

None. The text is passed through; tags or annotations are spoken
literally.

For affect control, see the `instruct` parameter below.

## Per-request parameters

| Field      | Type    | Effect                                              |
| ---------- | ------- | --------------------------------------------------- |
| `voice`    | string  | Override the provider's default voice key           |
| `model`    | string  | Override the configured model path                  |
| `instruct` | string  | Natural-language delivery directive (see below)     |
| `language` | string  | Hint language (e.g. "en", "fr") for the synthesizer |
| `stream`   | boolean | Stream PCM via HTTP chunked transfer                |

`speed` from `TTSRequest` is honored only in non-streaming mode (the
streaming path in vllm-omni v0.22 rejects the `speed` parameter).

## The `instruct` parameter

Qwen3-TTS's primary affect-control surface is `instruct`: a
natural-language description of how to deliver the text. Examples
that work well with Solène's voice:

| Instruct                                                     | Effect                            |
| ------------------------------------------------------------ | --------------------------------- |
| `"Speak in a warm, intimate tone with French sensibility."`  | Default Solène register           |
| `"Whispered, slow, contemplative."`                          | Chamber register                  |
| `"Excited, animated delivery."`                              | Playful register                  |
| `"Calm and measured, with thoughtful pauses."`               | Polished/professional             |
| `"Gentle morning register, French sensibility, unhurried."`  | Morning conversational            |

The instruct applies to the whole utterance. Combine with `speed`
(non-streaming only) for finer control.

## Voice cloning

Voice cloning is server-side. Adding a new voice means:

1. Capturing reference audio (~20-30s of varied register).
2. Producing the matching reference transcript.
3. Registering the pair under a voice key in the server's voice
   registry.

The provider does not accept live reference audio per-request.

## When to use this provider

- **Default for cadre voices today.** Sovereign, fast, multilingual,
  good voice fidelity.
- Long agent responses (combined with `src/chunker.ts` for inputs
  >4000 chars).
- Any English/French mixed delivery — the cross-lingual co-articulation
  is the strongest feature.

Consider Higgs Audio v3 when you need inline emotion / style /
prosody tags or richer affective range than `instruct` can express.

## Configuration shape

```jsonc
{
  "endpoint": "http://zion.irelate.ai:5009",
  "timeoutMs": 60000,
  "voice": "solene",
  "model": "/model",
  "agent": "solene",
  "instruct": "Speak in a warm, intimate tone with French sensibility.",
  "language": "en",
  "stream": true
}
```

## Known sharp edges

- **Input ceiling**: chunker required for inputs >4000 chars.
- **Streaming + speed**: vllm-omni v0.22 rejects the `speed` parameter
  when `stream=true`. The provider omits `speed` automatically in
  streaming mode.
- **Reference quality drives clone quality**: a short, narrow-register
  reference clip produces audible "shakiness" on out-of-register
  output. The reference recording should span 20-30 seconds with
  acoustic variety (declarative, question, varied register).
