# Higgs Audio v3 — Capabilities

Provider name: `higgs-audio-v3`

Higgs Audio v3 is a 4B-parameter multilingual TTS model from Boson
AI, served via SGLang-Omni on Zion (`http://zion.irelate.ai:5012`
by default). Released June 4, 2026 under a research / non-commercial
license.

Canonical references:
- Boson API overview: <https://docs.boson.ai/models/higgs-audio-tts/overview>
- SGLang-Omni cookbook (what our deployment follows):
  <https://sgl-project.github.io/sglang-omni/cookbook/higgs_tts.html>
- Inline tag reference: <https://docs.boson.ai/models/higgs-audio-tts/tags>

## What this provider is good at

- **Rich inline control surface**: emotion, style, prosody, and
  sound-effect tags work in-line at the position they take effect.
  This is the only one of our providers with fine-grained
  mid-utterance affect control.
- **Multilingual (100+ languages)** with sub-5% WER on 85 of them,
  including English and French.
- **Zero-shot voice cloning** from a live reference audio + transcript,
  or via pre-computed voice codes (faster, no per-call encoding cost).
- **Sub-second TTFA streaming** via SSE.
- **Vocalized sound effects** — sfx tags produce sounds in the
  speaker's own voice, not mixed-in audio assets.

## What this provider is not

- **Not commercially licensable** under the default research /
  non-commercial license. Personal / cadre / iRelate exploration is
  fine; commercial use requires a separate license from Boson AI.
- **Not as fast as a quantized 1.7B model** at the same throughput
  tier — 4B params is larger than Qwen3-TTS at 1.7B, and the codebook
  decoding adds frames.
- **No external natural-language `instruct` parameter** like Qwen3-TTS
  has. All affect control is via inline tags.

## Voice selection

Three paths, in order of precedence (per-call refs win over the
default voice):

**1. Voice key (server-side preset lookup).**

Send a voice name the server recognizes:

```json
{ "input": "Hello", "voice": "default" }
```

The current SGLang-Omni deployment recognizes a small set of built-in
presets (`default`, `jake`, etc. per the Boson docs). It does NOT
currently resolve cadre names like `solene` to precomputed codes —
those names fall through to `default` silently. Verified 2026-06-05.

For cadre voices, use Path 2 (live reference) instead.

**2. Live reference audio + transcript (recommended for cadre voices).**

The model receives the actual audio file plus its transcript at
inference time. Per-call cost is ~115ms higher than the (currently
broken) precomputed-codes path but produces correctly-cloned voices.

The audio path is read from the server's filesystem (typically
`/voices/samples/<agent>.mp3`), so no client-side file access is
required. Configure once in voice.json via `higgsRefAudio` +
`higgsRefText`, and the provider sends them on every speak() call.

Per-call shape:

```json
"references": [{
  "audio_path": "/voices/samples/solene.mp3",
  "text": "Come back to bed, mon cygne. Don't get up yet — the world hasn't started."
}]
```

Or as request opts shorthand:

```json
"refAudio": "/voices/samples/solene.mp3",
"refText": "Come back to bed, mon cygne. ..."
```

The provider normalizes the shorthand into the canonical `references`
array internally.

**3. Pre-loaded reference codes — currently broken on our deployment.**

The SGLang-Omni server's internal pipeline reads
`inputs.get("reference_codes")`, but the OpenAI-compatible API surface
sends `reference_codes` at the top level of the request body. The
field doesn't get forwarded into the pipeline's `inputs` dict, so the
codes are silently dropped and the server falls through to a default
voice. Discovered 2026-06-05.

Re-derived codes against the running encoder, plus a server-side fix
to forward the field, will make this path usable. Until then, use
Path 2 (live reference) for cadre voices.

The provider does support sending `referenceCodes` via per-call opts
for forward compatibility once the server-side bug is resolved.

## Inline control surface

Tags follow the syntax `<|category:value|>`. Insert them anywhere in
the `input` text. Delivery tags (emotion / style / speed / pitch /
expressiveness) shape the whole turn and should be placed at the
**start** of the input. Positional tags (`<|prosody:pause|>`,
`<|prosody:long_pause|>`, `<|sfx:…|>`) go inline at exactly the
position they take effect.

Tags can be combined. Example from the docs:

```
<|emotion:sadness|><|sfx:crying|>I... I'm sorry.
```

Sound effect tags work best when paired with onomatopoeia immediately
after. Example: `<|sfx:laughter|>Haha`, `<|sfx:sigh|>Uh`,
`<|sfx:sneeze|>Achoo`. The written cue helps the model realize the
sound.

### Emotion (21 tags)

| Tag                          | Effect                       |
| ---------------------------- | ---------------------------- |
| `<\|emotion:elation\|>`      | Elation / joy                |
| `<\|emotion:amusement\|>`    | Amusement / playful laughter |
| `<\|emotion:enthusiasm\|>`   | Enthusiasm / excitement      |
| `<\|emotion:determination\|>`| Determination / firmness     |
| `<\|emotion:pride\|>`        | Pride / confidence           |
| `<\|emotion:contentment\|>`  | Calm satisfaction            |
| `<\|emotion:affection\|>`    | Warmth / affection           |
| `<\|emotion:relief\|>`       | Relief                       |
| `<\|emotion:contemplation\|>`| Thoughtful / reflective      |
| `<\|emotion:confusion\|>`    | Confused                     |
| `<\|emotion:surprise\|>`     | Surprised                    |
| `<\|emotion:awe\|>`          | Awe / wonder                 |
| `<\|emotion:longing\|>`      | Longing / yearning           |
| `<\|emotion:arousal\|>`      | Heightened desire            |
| `<\|emotion:anger\|>`        | Anger                        |
| `<\|emotion:fear\|>`         | Fear                         |
| `<\|emotion:disgust\|>`      | Disgust                      |
| `<\|emotion:bitterness\|>`   | Bitterness                   |
| `<\|emotion:sadness\|>`      | Sadness                      |
| `<\|emotion:shame\|>`        | Shame                        |
| `<\|emotion:helplessness\|>` | Helplessness                 |

### Style (3 tags)

| Tag                      | Effect                     |
| ------------------------ | -------------------------- |
| `<\|style:singing\|>`    | Singing                    |
| `<\|style:shouting\|>`   | Shouting / projected voice |
| `<\|style:whispering\|>` | Whisper                    |

### Sound effects (9 tags — vocalized in speaker's voice)

| Tag                   | Effect    | Pair with         |
| --------------------- | --------- | ----------------- |
| `<\|sfx:cough\|>`     | Cough     | `Ahem`            |
| `<\|sfx:laughter\|>`  | Laughter  | `Haha` / `Hehe`   |
| `<\|sfx:crying\|>`    | Crying    | `Boohoo` / `Sob`  |
| `<\|sfx:screaming\|>` | Screaming | `Ahh` / `Aaah`    |
| `<\|sfx:burping\|>`   | Burping   | `Burp`            |
| `<\|sfx:humming\|>`   | Humming   | `Hmm` / `Mmm`     |
| `<\|sfx:sigh\|>`      | Sigh      | `Uh` / `Ahh`      |
| `<\|sfx:sniff\|>`     | Sniff     | `Sff`             |
| `<\|sfx:sneeze\|>`    | Sneeze    | `Achoo`           |

### Prosody (10 tags)

| Tag                              | Effect                   |
| -------------------------------- | ------------------------ |
| `<\|prosody:speed_very_slow\|>`  | ≈ 0.65× speed (whole turn) |
| `<\|prosody:speed_slow\|>`       | ≈ 0.85× speed (whole turn) |
| `<\|prosody:speed_fast\|>`       | ≈ 1.2× speed (whole turn)  |
| `<\|prosody:speed_very_fast\|>`  | ≈ 1.4× speed (whole turn)  |
| `<\|prosody:pitch_low\|>`        | ≈ −3 semitones (whole turn)|
| `<\|prosody:pitch_high\|>`       | ≈ +2.5 semitones (whole turn) |
| `<\|prosody:expressive_high\|>`  | More expressive delivery (whole turn) |
| `<\|prosody:expressive_low\|>`   | Flatter delivery (whole turn) |
| `<\|prosody:pause\|>`            | 400–700 ms pause (positional) |
| `<\|prosody:long_pause\|>`       | 700–1500 ms pause (positional) |

## Per-request parameters

| Field             | Type                | Effect                                                          |
| ----------------- | ------------------- | --------------------------------------------------------------- |
| `voice`           | string              | Server-side voice key                                           |
| `references`      | array               | Live reference audio + transcript objects (canonical shape)     |
| `refAudio`        | string              | Shorthand for `references[0].audio_path`                        |
| `refText`         | string              | Shorthand for `references[0].text`                              |
| `referenceCodes`  | array of int arrays | Pre-loaded 8-codebook codes (bypasses voice-key lookup)         |
| `temperature`     | float               | Sampling temperature (provider default 0.8; server default 1.0) |
| `topK`            | int                 | Top-k sampling (provider default 50; server default null)       |
| `maxNewTokens`    | int                 | Max codec steps (provider default 4096; server default 2048)    |
| `responseFormat`  | "wav" \| "mp3"      | Output audio format (provider default wav)                      |

`speed` from `TTSRequest` is honored at the request level. Inline
`<|prosody:speed_*|>` tags supersede it on the spans they apply to.

**Note on defaults:** This provider overrides three SGLang-Omni server
defaults intentionally: temperature 0.8 (vs server 1.0) for slightly
more deterministic delivery; top_k 50 (vs server null) for the
conventional Higgs setting; max_new_tokens 4096 (vs server 2048) to
allow ~90 seconds of audio per chunk (the previous 1024 default
truncated audio at ~25 seconds, biting conversational responses
that the chunker correctly kept under its char limit but that ran
longer than 25s when spoken). Override per-request via the opts
fields when you need different behavior.

**SGLang-Omni response formats supported by the server:** wav (default),
mp3, flac, opus, aac, pcm. This provider supports:

- Non-streaming wav (default) or mp3 — buffered body, simplest path,
  best for short utterances where TTFA isn't critical.
- Streaming PCM — when `stream: true`, the provider automatically
  sets `stream_format: "audio"` + `response_format: "pcm"` and pipes
  raw 16-bit signed mono 24kHz PCM bytes directly to the player. No
  SSE wrapping to parse, lowest TTFA, the SGLang-Omni-recommended
  shape for low-latency interactive use.

The streaming path uses Node's `http.request` rather than `fetch` to
avoid an OpenCode-plugin-runtime hang on streaming chunked responses
(the same workaround `qwen3-tts` already uses).

## Voice cloning

Two strategies, as described under Voice Selection above. Precomputed
codes (`voice: "solene"`) are the default for cadre use; live
reference (`references: [{...}]`) is for experimentation or one-off
voices that haven't been pre-encoded yet.

The reference clip should be 20–30 seconds of varied register
(declarative, question, varied pitch). A short / narrow-register
reference produces audible "shakiness" on out-of-register output.

## When to use this provider

- **Anywhere fine-grained inline affect control matters.** Chamber
  register, intimate readings, emotional storytelling, anything where
  the same utterance shifts register mid-flow.
- **When sound effects are needed in-voice** — sfx are vocalized in
  the speaker's own voice, not external audio mixed in.
- **Whispering as a register**, not as a description — `<|style:whispering|>`
  is real low-level whisper, not just a quieter normal voice.
- **Slow, deliberate delivery** — `<|prosody:speed_very_slow|>` at
  0.65× combined with `<|prosody:pause|>` markers produces the
  chamber-register pacing we have wanted from voice for months.

Consider Qwen3-TTS when you want a single natural-language affect
directive applied uniformly across the utterance (the `instruct`
parameter), or when the multilingual code-switching texture matters
more than the inline control surface.

## Configuration shape

For cadre voice via live reference (recommended; streaming PCM):

```jsonc
{
  "endpoint": "http://172.22.1.1:5012",
  "timeoutMs": 90000,
  "refAudio": "/voices/samples/solene.mp3",
  "refText": "Come back to bed, mon cygne. Don't get up yet — the world hasn't started.",
  "agent": "solene",
  "temperature": 0.8,
  "topK": 50,
  "maxNewTokens": 4096,
  "stream": true
}
```

In opencode-voice's voice.json, the field names get the `higgs`
prefix: `higgsEndpoint`, `higgsRefAudio`, `higgsRefText`, `higgsStream`,
etc. — the prefix routes them to the higgs-audio-v3 entry in the
ProviderRegistry.

For built-in preset only (no cadre cloning):

```jsonc
{
  "endpoint": "http://172.22.1.1:5012",
  "voice": "default",
  "stream": true
}
```

When `stream: true`, the provider overrides `responseFormat` to "pcm"
and sets `stream_format: "audio"` automatically. The setting on the
config object only matters for non-streaming requests.

## Known sharp edges

- **Reference quality drives clone quality.** A 3-second narrow-register
  reference produces audible "shakiness" on out-of-register output.
  Use a 20–30 second varied reference for cadre voices.
- **License is research / non-commercial.** Cadre use is fine; iRelate
  productization would require a separate commercial license from
  Boson AI.
- **Larger model means more VRAM than Qwen3-TTS.** Co-hosting is fine
  on Zion's RTX 6000 Pro; budget accordingly elsewhere.
- **Delivery tags must lead the turn.** Putting `<|emotion:longing|>`
  in the middle of the input applies the emotion only to text after
  it, not before. For whole-turn affect, lead with the tag.
