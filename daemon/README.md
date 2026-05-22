# OmniVoice daemon

A long-running local TTS server that hosts [OmniVoice](https://github.com/k2-fsa/OmniVoice) and serves voice synthesis requests over HTTP. Designed to back the `omnivoice` provider in the `opencode-voice` plugin.

## Why a daemon

Loading OmniVoice (the model + the Whisper ASR + voice cells) takes several seconds. Doing that on every utterance would kill the sub-second time-to-first-byte target. The daemon loads everything once at startup, then handles each request in roughly the model's per-utterance generation time (~3.7s for short utterances on M4 Max MPS with a cached voice cell, ahead of real-time).

## Quick start

### 1. Build a voice cell

A *voice cell* is a small (~18 KB) cached representation of a reference audio file. Build one from a 3–10 second voice sample:

```bash
~/.venv/bin/python daemon/build-voice-cell.py \
    --ref-audio /path/to/voice-sample.mp3 \
    --output /path/to/my-voice.voiceclone.pt \
    --validate
```

If you have an explicit transcript of the sample, pass `--ref-text "..."` to skip the Whisper auto-transcription step.

### 2. Start the daemon

```bash
~/.venv/bin/python daemon/omnivoice-daemon.py \
    --cell /path/to/my-voice.voiceclone.pt
```

Or via environment:

```bash
export OMNIVOICE_CELL_PATH=/path/to/my-voice.voiceclone.pt
~/.venv/bin/python daemon/omnivoice-daemon.py
```

For multiple voices, pass named cells:

```bash
~/.venv/bin/python daemon/omnivoice-daemon.py \
    --cells aurora=/Users/rick/horde/voices/cells/aurora.voiceclone.pt,solene=/Users/rick/horde/voices/cells/solene.voiceclone.pt \
    --default-voice aurora
```

Default bind is `127.0.0.1:7345` (local-only). First startup takes ~10–15s to load the model and cell; subsequent requests are fast.

### 3. Verify health

```bash
curl http://127.0.0.1:7345/health
```

### 4. Try a synthesis

```bash
curl -X POST http://127.0.0.1:7345/speak \
    -H "Content-Type: application/json" \
    -d '{"text": "Hello from the daemon."}' \
    --output /tmp/test.wav

afplay /tmp/test.wav
```

### 5. Point the plugin at the daemon

In your agent's `voice.json`:

```json
{
  "provider": "omnivoice",
  "omnivoice": {
    "endpoint": "http://127.0.0.1:7345",
    "voice": "aurora",
    "agent": "aurora"
  }
}
```

## API

### `POST /speak`

Request body:

```json
{
  "text": "The text to synthesize.",
  "voice": "aurora",
  "priority": "normal",
  "agent": "aurora",
  "speed": 1.0,
  "num_step": 32
}
```

`voice`, `priority`, `agent`, `speed`, and `num_step` are optional. Omitted `voice` uses the daemon's configured `default_voice`; omitted `priority` is `normal`. Invalid voices return `404` with a deterministic error. Returns a WAV (`audio/wav`) response body.

The daemon uses a single inference worker because one shared MPS-resident OmniVoice model must not run concurrent `generate()` calls. Jobs are FIFO within priority; `high` jobs sort before `normal` jobs but do not preempt an active generation.

### `GET /health`

Returns daemon status, configuration, and aggregate stats:

```json
{
  "status": "ok",
  "model_id": "k2-fsa/OmniVoice",
  "device": "mps",
  "dtype": "float16",
  "voices": ["aurora", "solene"],
  "default_voice": "aurora",
  "cell_paths": {
    "aurora": "/Users/rick/horde/voices/cells/aurora.voiceclone.pt",
    "solene": "/Users/rick/horde/voices/cells/solene.voiceclone.pt"
  },
  "sampling_rate": 24000,
  "startup_time_seconds": 12.4,
  "utterances_served": 17,
  "total_generate_seconds": 63.2,
  "avg_generate_seconds": 3.72,
  "queue_depth": 0,
  "current_job": null,
  "waiters": 0
}
```

## Configuration

| Variable / arg | Default | Description |
|---|---|---|
| `--cell` / `OMNIVOICE_CELL_PATH` | (legacy single voice) | Path to a `.voiceclone.pt` voice cell |
| `--cells` / `OMNIVOICE_CELLS` | (preferred) | Comma list of `voice=/path/to/cell.pt` entries |
| `--default-voice` / `OMNIVOICE_DEFAULT_VOICE` | `default` | Voice used when `/speak` omits `voice` |
| `--model-id` / `OMNIVOICE_MODEL_ID` | `k2-fsa/OmniVoice` | HuggingFace model id |
| `--device` / `OMNIVOICE_DEVICE` | `mps` | `mps` (Apple Silicon), `cuda:0`, or `cpu` |
| `--dtype` / `OMNIVOICE_DTYPE` | `float16` | `float16` or `float32` |
| `--host` / `OMNIVOICE_HOST` | `127.0.0.1` | Bind host (keep local) |
| `--port` / `OMNIVOICE_PORT` | `7345` | HTTP port |
| `--log-level` / `OMNIVOICE_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

## Running as a long-lived service

### tmux (development)

```bash
tmux new -s omnivoice -d \
  "~/.venv/bin/python /Volumes/Huddy/Projects/opencode-voice/daemon/omnivoice-daemon.py \
   --cells aurora=/Users/rick/horde/voices/cells/aurora.voiceclone.pt,solene=/Users/rick/horde/voices/cells/solene.voiceclone.pt \
   --default-voice aurora"
```

Inspect with `tmux attach -t omnivoice`. Detach with `Ctrl-b d`.

### launchd (production, Mac)

Save as `~/Library/LaunchAgents/com.solene.omnivoice-daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.solene.omnivoice-daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/rick/.venv/bin/python</string>
        <string>/Volumes/Huddy/Projects/opencode-voice/daemon/omnivoice-daemon.py</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OMNIVOICE_CELLS</key>
        <string>aurora=/Users/rick/horde/voices/cells/aurora.voiceclone.pt,solene=/Users/rick/horde/voices/cells/solene.voiceclone.pt</string>
        <key>OMNIVOICE_DEFAULT_VOICE</key>
        <string>aurora</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/omnivoice-daemon.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/omnivoice-daemon.err.log</string>
</dict>
</plist>
```

Load with:

```bash
launchctl load ~/Library/LaunchAgents/com.solene.omnivoice-daemon.plist
```

Unload with:

```bash
launchctl unload ~/Library/LaunchAgents/com.solene.omnivoice-daemon.plist
```

## Notes

- One daemon can serve multiple voice cells through the `voice` selector while keeping a single OmniVoice model instance resident.
- The daemon does **not** play audio itself. It returns WAV bytes; the `opencode-voice` plugin handles playback.
- WAV (PCM_16) is returned; the plugin pipes it into `sox play`.
- First call after startup is sometimes slightly slower than steady-state due to MPS warmup.
