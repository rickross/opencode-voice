"""
OmniVoice daemon — local TTS server for opencode-voice plugin.

Loads OmniVoice (k2-fsa/OmniVoice) on MPS at startup, holds cached
VoiceClonePrompt cells in memory, and exposes a small HTTP API for the
plugin to call. Designed to be long-running (launchd or tmux) so that the
heavy model-load cost happens once, and per-utterance latency stays low.

Endpoints:
    POST /speak      — synthesize text, return WAV bytes
    GET  /health     — liveness + status info

Configuration via environment variables (or CLI args):
    OMNIVOICE_CELL_PATH   legacy single-voice .voiceclone.pt path
    OMNIVOICE_CELLS       comma list of voice=/path/to/cell.pt entries
    OMNIVOICE_DEFAULT_VOICE default voice key for requests without voice
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
import asyncio
import io
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request
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
DEFAULT_VOICE = "default"

logger = logging.getLogger("omnivoice-daemon")


# -----------------------------------------------------------------------------
# Request / response models
# -----------------------------------------------------------------------------


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Text to synthesize")
    voice: Optional[str] = Field(
        None, min_length=1, description="Voice key loaded by the daemon"
    )
    priority: str = Field(
        "normal", pattern="^(normal|high)$", description="Queue priority hint"
    )
    agent: Optional[str] = Field(
        None, min_length=1, description="Optional caller id for diagnostics"
    )
    speed: Optional[float] = Field(
        None, ge=0.5, le=2.0, description="Optional speech rate multiplier"
    )
    num_step: Optional[int] = Field(
        None, ge=1, le=64, description="Diffusion steps (default model setting if omitted)"
    )


# -----------------------------------------------------------------------------
# Runtime state container
# -----------------------------------------------------------------------------


@dataclass(order=True)
class SpeakJob:
    priority_rank: int
    sequence: int
    request: SpeakRequest = field(compare=False)
    voice: str = field(compare=False)
    future: asyncio.Future[bytes] = field(compare=False)
    enqueued_at: float = field(default_factory=time.time, compare=False)
    started_at: Optional[float] = field(default=None, compare=False)


class DaemonState:
    """Holds the loaded OmniVoice model + cached VoiceClonePrompt cells."""

    def __init__(self) -> None:
        self.model = None
        self.voice_clone_prompts: dict[str, object] = {}
        self.cell_paths: dict[str, Path] = {}
        self.default_voice: str = DEFAULT_VOICE
        self.model_id: str = DEFAULT_MODEL_ID
        self.device: str = DEFAULT_DEVICE
        self.dtype: str = DEFAULT_DTYPE
        self.sampling_rate: Optional[int] = None
        self.startup_time: Optional[float] = None
        self.utterances_served: int = 0
        self.total_generate_seconds: float = 0.0
        self.queue: asyncio.PriorityQueue[SpeakJob] = asyncio.PriorityQueue()
        self.current_job: Optional[dict] = None
        self._sequence: int = 0
        self._worker_task: Optional[asyncio.Task] = None

    def load(
        self,
        cells: dict[str, Path],
        default_voice: str,
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

        if default_voice not in cells:
            raise ValueError(f"Default voice {default_voice!r} is not in loaded cells")

        for voice, cell_path in cells.items():
            logger.info("Loading voice cell %s from %s", voice, cell_path)
            t0 = time.time()
            loaded = torch.load(cell_path, weights_only=False, map_location="cpu")
            prompt = VoiceClonePrompt(
                ref_audio_tokens=loaded["ref_audio_tokens"],
                ref_text=loaded["ref_text"],
                ref_rms=loaded["ref_rms"],
            )
            self.voice_clone_prompts[voice] = prompt
            self.cell_paths[voice] = cell_path
            t_cell = time.time() - t0
            logger.info(
                "Voice cell %s loaded in %.2fs (ref_text=%r)",
                voice,
                t_cell,
                prompt.ref_text,
            )

        self.default_voice = default_voice
        self.model_id = model_id
        self.device = device
        self.dtype = dtype
        self.sampling_rate = self.model.sampling_rate
        self.startup_time = time.time() - t_start
        logger.info(
            "Daemon ready in %.2fs (voices=%s, default_voice=%s, sampling_rate=%d Hz)",
            self.startup_time,
            ",".join(sorted(self.voice_clone_prompts)),
            self.default_voice,
            self.sampling_rate,
        )

    def next_sequence(self) -> int:
        self._sequence += 1
        return self._sequence

    def generate_audio(self, req: SpeakRequest, voice: str):
        if self.model is None or not self.voice_clone_prompts:
            raise RuntimeError("Daemon not initialized")
        if voice not in self.voice_clone_prompts:
            raise KeyError(voice)

        kwargs: dict = {
            "text": req.text,
            "voice_clone_prompt": self.voice_clone_prompts[voice],
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
            "spoke voice=%s agent=%s priority=%s %d chars → %.2fs audio in %.2fs (RTF %.3f)",
            voice,
            req.agent,
            req.priority,
            len(req.text),
            audio_seconds,
            dt,
            rtf,
        )
        return audio

    def encode_wav(self, audio) -> bytes:
        buf = io.BytesIO()
        sf.write(buf, audio, self.sampling_rate, format="WAV", subtype="PCM_16")
        return buf.getvalue()

    async def worker_loop(self) -> None:
        while True:
            job = await self.queue.get()
            try:
                if job.future.cancelled():
                    continue

                job.started_at = time.time()
                self.current_job = {
                    "voice": job.voice,
                    "agent": job.request.agent,
                    "priority": job.request.priority,
                    "text_chars": len(job.request.text),
                    "enqueued_at": job.enqueued_at,
                    "started_at": job.started_at,
                    "wait_seconds": job.started_at - job.enqueued_at,
                }

                audio = await asyncio.to_thread(self.generate_audio, job.request, job.voice)
                if job.future.cancelled():
                    logger.info("client disconnected before encode; skipping wav encode")
                    continue
                wav_bytes = await asyncio.to_thread(self.encode_wav, audio)
                if not job.future.cancelled():
                    job.future.set_result(wav_bytes)
            except Exception as exc:
                logger.exception("queued generate failed")
                if not job.future.cancelled():
                    job.future.set_exception(exc)
            finally:
                self.current_job = None
                self.queue.task_done()

    def start_worker(self) -> None:
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self.worker_loop())

    def health_payload(self) -> dict:
        return {
            "status": "ok" if self.model is not None and self.voice_clone_prompts else "initializing",
            "model_id": self.model_id,
            "device": self.device,
            "dtype": self.dtype,
            "voices": sorted(self.voice_clone_prompts),
            "default_voice": self.default_voice,
            "cell_paths": {voice: str(path) for voice, path in sorted(self.cell_paths.items())},
            "sampling_rate": self.sampling_rate,
            "startup_time_seconds": self.startup_time,
            "utterances_served": self.utterances_served,
            "total_generate_seconds": self.total_generate_seconds,
            "avg_generate_seconds": (
                self.total_generate_seconds / self.utterances_served
                if self.utterances_served
                else None
            ),
            "queue_depth": self.queue.qsize(),
            "current_job": self.current_job,
            "waiters": self.queue.qsize() + (1 if self.current_job else 0),
        }


state = DaemonState()


# -----------------------------------------------------------------------------
# FastAPI app
# -----------------------------------------------------------------------------


app = FastAPI(title="omnivoice-daemon", version="0.1.0")


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(state.health_payload())


@app.post("/speak")
async def speak(req: SpeakRequest, request: Request) -> Response:
    if state.model is None or not state.voice_clone_prompts:
        raise HTTPException(status_code=503, detail="Daemon not ready")
    voice = req.voice or state.default_voice
    if voice not in state.voice_clone_prompts:
        raise HTTPException(status_code=404, detail=f"Unknown voice: {voice}")

    loop = asyncio.get_running_loop()
    future: asyncio.Future[bytes] = loop.create_future()
    priority_rank = 0 if req.priority == "high" else 1
    job = SpeakJob(
        priority_rank=priority_rank,
        sequence=state.next_sequence(),
        request=req,
        voice=voice,
        future=future,
    )
    await state.queue.put(job)

    try:
        while not future.done():
            if await request.is_disconnected():
                future.cancel()
                detail = (
                    "Client disconnected before synthesis"
                    if job.started_at is None
                    else "Client disconnected during synthesis"
                )
                raise HTTPException(status_code=499, detail=detail)
            try:
                wav_bytes = await asyncio.wait_for(asyncio.shield(future), timeout=0.1)
                return Response(content=wav_bytes, media_type="audio/wav")
            except asyncio.TimeoutError:
                continue
        wav_bytes = future.result()
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise exc
        logger.exception("generate failed")
        raise HTTPException(status_code=500, detail=str(exc))
    return Response(content=wav_bytes, media_type="audio/wav")


@app.on_event("startup")
async def startup() -> None:
    state.start_worker()


# -----------------------------------------------------------------------------
# CLI entry point
# -----------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--cell",
        type=Path,
        default=Path(os.environ.get("OMNIVOICE_CELL_PATH", "")),
        help="Legacy single-voice .voiceclone.pt file (or set OMNIVOICE_CELL_PATH)",
    )
    parser.add_argument(
        "--cells",
        type=str,
        default=os.environ.get("OMNIVOICE_CELLS", ""),
        help="Comma list of voice=/path/to/cell.pt entries",
    )
    parser.add_argument(
        "--default-voice",
        type=str,
        default=os.environ.get("OMNIVOICE_DEFAULT_VOICE", DEFAULT_VOICE),
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


def parse_cells(cells_arg: str, legacy_cell: Path, default_voice: str) -> dict[str, Path]:
    cells: dict[str, Path] = {}
    if cells_arg:
        for entry in cells_arg.split(","):
            entry = entry.strip()
            if not entry:
                continue
            if "=" not in entry:
                raise ValueError(f"Invalid --cells entry {entry!r}; expected voice=/path")
            voice, raw_path = entry.split("=", 1)
            voice = voice.strip()
            path = Path(raw_path.strip()).expanduser()
            if not voice:
                raise ValueError(f"Invalid --cells entry {entry!r}; voice key is empty")
            if voice in cells:
                raise ValueError(f"Duplicate voice key in --cells: {voice}")
            if not path.exists():
                raise FileNotFoundError(f"Voice cell for {voice!r} not found: {path}")
            cells[voice] = path

    if not cells and legacy_cell and str(legacy_cell) != "":
        path = legacy_cell.expanduser()
        if not path.exists():
            raise FileNotFoundError(f"Voice cell not found: {path}")
        cells[default_voice] = path

    if not cells:
        raise FileNotFoundError("No voice cells configured. Set --cells or --cell.")
    if default_voice not in cells:
        raise ValueError(f"Default voice {default_voice!r} is not in configured cells")
    return cells


def main() -> int:
    args = parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    try:
        cells = parse_cells(args.cells, args.cell, args.default_voice)
    except Exception as exc:
        logger.error(
            "Voice cell configuration invalid. Set --cells or --cell to valid "
            ".voiceclone.pt files: %s",
            exc,
        )
        return 2

    state.load(
        cells=cells,
        default_voice=args.default_voice,
        model_id=args.model_id,
        device=args.device,
        dtype=args.dtype,
    )

    logger.info("Starting HTTP server on %s:%d", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level.lower())
    return 0


if __name__ == "__main__":
    sys.exit(main())
