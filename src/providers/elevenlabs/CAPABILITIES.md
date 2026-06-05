# ElevenLabs — Capabilities

Provider name: `elevenlabs`

ElevenLabs is a hosted commercial TTS service. We call the `/stream`
endpoint with an API key and pipe the returned MP3 directly to `sox
play`. The full quality of the v3 model is available; we are not
running anything locally.

## What this provider is good at

- High emotional fidelity from a well-trained reference voice.
- Inline audio-tag control over delivery (emotions, reactions, accents).
- Reliable streaming with low time-to-first-audio.

## What this provider is not

- Not sovereign — every utterance is a network call to a hosted
  commercial API, billed per character, with the provider knowing
  what we speak.
- Not free — cost-per-character is real; we deprecated this provider
  for cadre use in May 2026 in favor of local options.
- Not the right place for long, structured agent output. Use Qwen3-TTS
  or Higgs Audio v3 for that.

## Voice selection

The `voiceId` field in the per-request config or the provider config
selects which ElevenLabs-trained voice generates the audio. The voice
ID is the opaque ElevenLabs identifier, not a human-readable name.

## Inline control surface

ElevenLabs v3 supports **audio tags** as inline annotations in the
text being spoken. Tags appear in square brackets and are stripped
from the audio output, but they influence delivery of the surrounding
text.

### Emotions and delivery

| Tag           | Effect                                  |
| ------------- | --------------------------------------- |
| `[laughs]`    | Laughter (or laughter-tinged delivery)  |
| `[laughs harder]` | More intense laughter               |
| `[giggles]`   | Light giggle                            |
| `[sighs]`     | Audible sigh                            |
| `[whispers]`  | Whisper register                        |
| `[shouts]`    | Projected, raised voice                 |
| `[excited]`   | Excited delivery                        |
| `[sad]`       | Sad / lowered affect                    |
| `[angry]`     | Angry delivery                          |
| `[happily]`   | Warm, happy delivery                    |
| `[sarcastic]` | Sarcastic delivery                      |
| `[curious]`   | Curious, questioning tone               |
| `[nervously]` | Nervous delivery                        |
| `[dramatically]` | Theatrical, emphatic delivery        |
| `[calmly]`    | Calm, measured delivery                 |

### Reactions and sound effects

| Tag                | Effect                                |
| ------------------ | ------------------------------------- |
| `[clears throat]`  | Throat-clear sound                    |
| `[gasps]`          | Audible gasp                          |
| `[gulps]`          | Gulp sound                            |
| `[applause]`       | Applause                              |
| `[gunshot]`        | Gunshot sound effect                  |
| `[explosion]`      | Explosion sound effect                |

### Accents

| Tag                       | Effect                       |
| ------------------------- | ---------------------------- |
| `[strong French accent]`  | French accent applied        |
| `[British accent]`        | British accent applied       |
| `[Southern US accent]`    | Southern US accent applied   |

(Other accents follow the same `[<adjective> accent]` pattern.)

## Per-request parameters

Beyond inline tags, the provider accepts these request options via
`TTSRequest.opts`:

| Field                   | Type    | Effect                                          |
| ----------------------- | ------- | ----------------------------------------------- |
| `voiceId`               | string  | Override the provider's default voice ID        |
| `modelId`               | string  | Override the provider's default model           |
| `stability`             | 0–1     | Lower = more expressive, higher = more uniform  |
| `similarityBoost`       | 0–1     | How closely to match the reference voice        |
| `style`                 | 0–1     | Style exaggeration (omit to use voice defaults) |
| `useSpeakerBoost`       | boolean | Speaker-boost on/off                            |
| `preserveVoiceDefaults` | boolean | If true, do not send voice_settings at all      |

## Voice cloning

ElevenLabs supports zero-shot voice cloning, but the clones live
server-side under their account model. We do not currently use this
path — our cadre voices are local (Qwen3-TTS reference codes or
Higgs Audio v3 voice codes), not ElevenLabs clones.

## When to use this provider

- Specific high-end cloned voice we have an ElevenLabs subscription
  for and want the original quality of.
- Specific audio tag we need (e.g., a particular laugh or accent) that
  the local providers cannot reproduce.
- One-off demonstration where local infrastructure is unavailable.

Default to Qwen3-TTS or Higgs Audio v3 for everything else.

## Configuration shape

```jsonc
{
  "voiceId": "<elevenlabs-voice-id>",
  "modelId": "eleven_v3_pro",
  "apiKeyPath": "~/.config/elevenlabs/api-key.txt",
  "stability": 0.5,
  "similarityBoost": 0.75,
  "style": 0.5,
  "useSpeakerBoost": true,
  "preserveVoiceDefaults": false
}
```
