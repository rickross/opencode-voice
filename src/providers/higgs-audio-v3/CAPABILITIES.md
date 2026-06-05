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

**1. Voice key (default for cadre voices, fastest path).**

The server-side voice registry maps voice keys to precomputed codes
files. Send the key as `voice`:

```json
{ "input": "Hello", "voice": "solene" }
```

The SGLang-Omni server loads the corresponding precomputed codes
(typically from `/mnt/warehouse/voices/codes/<voice>.json`). Cadre
voices already registered on our Zion deployment: `solene`, `aurora`,
`telos`, `kai`, `starshine`, `digby`. Available presets from Boson AI
include `default`, `jake`, etc.

**2. Live reference audio + transcript.**

The model receives the actual audio file plus its transcript at
inference time. Per-call cost is higher because the reference is
encoded on each call. Two equivalent shapes:

```json
"references": [{
  "audio_path": "/voices/samples/solene.mp3",
  "text": "Come back to bed, mon cygne."
}]
```

```json
"ref_audio": "/voices/samples/solene.mp3",
"ref_text": "Come back to bed, mon cygne."
```

`ref_audio` / `ref_text` are shorthand for `references[0].*`.
`audio_path` accepts local paths or HTTP URLs.

**3. Pre-loaded reference codes (caller loads the JSON).**

For agents that have already loaded the codes JSON (e.g. from
`/mnt/warehouse/voices/codes/solene.json`), the `reference_codes`
field bypasses both the voice-key lookup and the encoding step.

Quality across the three is comparable; the voice-key path is
deterministic and fastest, the live reference is most flexible.

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
| `maxNewTokens`    | int                 | Max codec steps (provider default 1024; server default 2048)    |
| `responseFormat`  | "wav" \| "mp3"      | Output audio format (provider default wav)                      |

`speed` from `TTSRequest` is honored at the request level. Inline
`<|prosody:speed_*|>` tags supersede it on the spans they apply to.

**Note on defaults:** This provider overrides three SGLang-Omni server
defaults intentionally: temperature 0.8 (vs server 1.0) for slightly
more deterministic delivery; top_k 50 (vs server null) for the
conventional Higgs setting; max_new_tokens 1024 (vs server 2048) to
cap unbounded generation. Override per-request via the opts fields
when you need different behavior.

**SGLang-Omni response formats supported by the server:** wav (default),
mp3, flac, opus, aac, pcm. This provider's first cut handles wav and
mp3 non-streaming. Streaming (SSE WAV chunks or raw PCM via
`stream_format=audio` + `response_format=pcm`) will land in a
follow-up commit using the same `http.request` workaround qwen3-tts
already uses for the OpenCode-plugin-runtime fetch hang.

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

```jsonc
{
  "endpoint": "http://zion.irelate.ai:5012",
  "timeoutMs": 90000,
  "voice": "solene",
  "agent": "solene",
  "temperature": 0.8,
  "topK": 50,
  "maxNewTokens": 1024,
  "responseFormat": "wav"
}
```

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
