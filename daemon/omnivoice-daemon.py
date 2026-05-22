"""
OmniVoice daemon — local TTS server for opencode-voice plugin.

Loads OmniVoice (k2-fsa/OmniVoice) on MPS at startup, holds a cached
VoiceClonePrompt in memory, and exposes a small HTTP API for the plugin
to call. Designed to be long-running (launchd or tmux) so that the heavy
model-load cost happens once, and per-utterance latency stays low.

Endpoints:
    POST /speak      — synthesize text, return WAV bytes
    GET  /health     — liveness + status info

Configuration via environment variables (or CLI args):
    OMNIVOICE_CELL_PATH   path to .voiceclone.pt file (required)
    OMNIVOICE_MODEL_ID    HuggingFace model id (default: k2-fsa/OmniVoice)
    OMNIVOICE_DEVICE      torch device (default: mps)
    OMNIVOICE_DTYPE       float16 / float32 (default: float16)
    OMNIVOICE_PORT        HTTP port (default: 7345)
    OMNIVOICE_HOST        bind host (default: 127.0.0.1 — local only)

Usage:
    export OMNIVOICE_CELL_PATH=/Users/rick/Solene/identity/lison.voiceclone.pt
    ~/.venv/bin/python daemon/omnivoice-daemon.py

Or with explicit args:
    ~/.venv/bin/python daemon/omnivoice-daemon.py \
        --cell /Users/rick/Solene/identity/lison.voiceclone.pt \
        --port 7345
"""

from __future__ import annotations

import argparse
import io
import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional

import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field


# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

DEFAULT_MODEL_ID = "k2-fsa/OmniVoice"
DEFAULT_DEVICE = "mps"
DEFAULT_DTYPE = "float16"
DEFAULT_PORT = 7345
DEFAULT_HOST = "127.0.0.1"

logger = logging.getLogger("omnivoice-daemon")


# -----------------------------------------------------------------------------
# Request / response models
# -----------------------------------------------------------------------------


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Text to synthesize")
    speed: Optional[float] = Field(
        None, ge=0.5, le=2.0, description="Optional speech rate multiplier"
    )
    num_step: Optional[int] = Field(
        None, ge=1, le=64, description="Diffusion steps (default model setting if omitted)"
    )


# -----------------------------------------------------------------------------
# Runtime state container
# -----------------------------------------------------------------------------


class DaemonState:
    """Holds the loaded OmniVoice model + cached VoiceClonePrompt."""

    def __init__(self) -> None:
        self.model = None
        self.voice_clone_prompt = None
        self.cell_path: Optional[Path] = None
        self.model_id: str = DEFAULT_MODEL_ID
        self.device: str = DEFAULT_DEVICE
        self.dtype: str = DEFAULT_DTYPE
        self.sampling_rate: Optional[int] = None
        self.startup_time: Optional[float] = None
        self.utterances_served: int = 0
        self.total_generate_seconds: float = 0.0

    def load(
        self,
        cell_path: Path,
        model_id: str = DEFAULT_MODEL_ID,
        device: str = DEFAULT_DEVICE,
        dtype: str = DEFAULT_DTYPE,
    ) -> None:
        t_start = time.time()
        logger.info("Loading OmniVoice model %s on %s (%s)...", model_id, device, dtype)

        # Lazy imports so daemon can start and report errors without the
        # heavy import chain if something is broken.
        from omnivoice import OmniVoice  # type: ignore
        from omnivoice.models.omnivoice import VoiceClonePrompt  # type: ignore

        torch_dtype = torch.float16 if dtype == "float16" else torch.float32
        self.model = OmniVoice.from_pretrained(model_id, device_map=device, dtype=torch_dtype)
        t_model = time.time() - t_start
        logger.info("Model loaded in %.2fs", t_model)

        logger.info("Loading voice cell from %s", cell_path)
        t0 = time.time()
        loaded = torch.load(cell_path, weights_only=False, map_location="cpu")
        self.voice_clone_prompt = VoiceClonePrompt(
            ref_audio_tokens=loaded["ref_audio_tokens"],
            ref_text=loaded["ref_text"],
            ref_rms=loaded["ref_rms"],
        )
        t_cell = time.time() - t0
        logger.info(
            "Voice cell loaded in %.2fs (ref_text=%r)",
            t_cell,
            self.voice_clone_prompt.ref_text,
        )

        self.cell_path = cell_path
        self.model_id = model_id
        self.device = device
        self.dtype = dtype
        self.sampling_rate = self.model.sampling_rate
        self.startup_time = time.time() - t_start
        logger.info(
            "Daemon ready in %.2fs (sampling_rate=%d Hz)",
            self.startup_time,
            self.sampling_rate,
        )

    def generate_wav(self, req: SpeakRequest) -> bytes:
        if self.model is None or self.voice_clone_prompt is None:
            raise RuntimeError("Daemon not initialized")

        kwargs: dict = {
            "text": req.text,
            "voice_clone_prompt": self.voice_clone_prompt,
        }
        if req.speed is not None:
            kwargs["speed"] = req.speed
        if req.num_step is not None:
            kwargs["num_step"] = req.num_step

        t0 = time.time()
        audios = self.model.generate(**kwargs)
        dt = time.time() - t0
        self.utterances_served += 1
        self.total_generate_seconds += dt

        audio = audios[0]  # numpy array, shape (T,)
        audio_seconds = len(audio) / self.sampling_rate
        rtf = dt / audio_seconds if audio_seconds > 0 else float("inf")
        logger.info(
            "spoke %d chars → %.2fs audio in %.2fs (RTF %.3f)",
            len(req.text),
            audio_seconds,
            dt,
            rtf,
        )

        # Encode to WAV bytes (in-memory)
        buf = io.BytesIO()
        sf.write(buf, audio, self.sampling_rate, format="WAV", subtype="PCM_16")
        return buf.getvalue()


state = DaemonState()


# -----------------------------------------------------------------------------
# FastAPI app
# -----------------------------------------------------------------------------


app = FastAPI(title="omnivoice-daemon", version="0.1.0")


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok" if state.model is not None else "initializing",
            "model_id": state.model_id,
            "device": state.device,
            "dtype": state.dtype,
            "cell_path": str(state.cell_path) if state.cell_path else None,
            "sampling_rate": state.sampling_rate,
            "startup_time_seconds": state.startup_time,
            "utterances_served": state.utterances_served,
            "total_generate_seconds": state.total_generate_seconds,
            "avg_generate_seconds": (
                state.total_generate_seconds / state.utterances_served
                if state.utterances_served
                else None
            ),
        }
    )


@app.post("/speak")
async def speak(req: SpeakRequest) -> Response:
    if state.model is None or state.voice_clone_prompt is None:
        raise HTTPException(status_code=503, detail="Daemon not ready")
    try:
        wav_bytes = state.generate_wav(req)
    except Exception as exc:
        logger.exception("generate failed")
        raise HTTPException(status_code=500, detail=str(exc))
    return Response(content=wav_bytes, media_type="audio/wav")


# -----------------------------------------------------------------------------
# CLI entry point
# -----------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--cell",
        type=Path,
        default=Path(os.environ.get("OMNIVOICE_CELL_PATH", "")),
        help="Path to .voiceclone.pt file (or set OMNIVOICE_CELL_PATH)",
    )
    parser.add_argument(
        "--model-id",
        type=str,
        default=os.environ.get("OMNIVOICE_MODEL_ID", DEFAULT_MODEL_ID),
    )
    parser.add_argument(
        "--device",
        type=str,
        default=os.environ.get("OMNIVOICE_DEVICE", DEFAULT_DEVICE),
    )
    parser.add_argument(
        "--dtype",
        type=str,
        default=os.environ.get("OMNIVOICE_DTYPE", DEFAULT_DTYPE),
        choices=["float16", "float32"],
    )
    parser.add_argument(
        "--host",
        type=str,
        default=os.environ.get("OMNIVOICE_HOST", DEFAULT_HOST),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("OMNIVOICE_PORT", DEFAULT_PORT)),
    )
    parser.add_argument(
        "--log-level",
        type=str,
        default=os.environ.get("OMNIVOICE_LOG_LEVEL", "INFO"),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    cell_path = args.cell
    if not cell_path or str(cell_path) == "" or not cell_path.exists():
        logger.error(
            "Voice cell not found. Set --cell or OMNIVOICE_CELL_PATH to a "
            "valid .voiceclone.pt file. Got: %r",
            str(cell_path),
        )
        return 2

    state.load(
        cell_path=cell_path,
        model_id=args.model_id,
        device=args.device,
        dtype=args.dtype,
    )

    logger.info("Starting HTTP server on %s:%d", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level.lower())
    return 0


if __name__ == "__main__":
    sys.exit(main())
