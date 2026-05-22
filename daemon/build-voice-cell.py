"""
Build a voice cell — a persistent, reusable VoiceClonePrompt — from a
reference audio file.

The output .voiceclone.pt artifact is tiny (~18 KB) and contains the
encoded reference audio tokens. Used with the omnivoice-daemon to skip
the ~1.7s ref_audio encoding step on every utterance.

Usage:
    ~/.venv/bin/python daemon/build-voice-cell.py \
        --ref-audio /path/to/voice-sample.mp3 \
        --output /path/to/voice-name.voiceclone.pt

    # With explicit transcript (skip Whisper auto-transcription):
    ~/.venv/bin/python daemon/build-voice-cell.py \
        --ref-audio sample.wav \
        --ref-text "Transcript of the sample audio." \
        --output my-voice.voiceclone.pt

Notes:
    - A 3–10 second reference clip works best.
    - Same language as the target speech for cleanest cloning.
    - Auto-transcription uses Whisper large-v3-turbo by default; pass
      --ref-text to skip Whisper and provide a transcript yourself.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import torch


DEFAULT_MODEL_ID = "k2-fsa/OmniVoice"
DEFAULT_ASR_MODEL_ID = "openai/whisper-large-v3-turbo"
DEFAULT_DEVICE = "mps"


def fmt_time(s: float) -> str:
    return f"{s:.2f}s"


def fmt_size(b: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--ref-audio",
        type=Path,
        required=True,
        help="Path to reference audio file (mp3, wav, etc.)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output path for the .voiceclone.pt file",
    )
    parser.add_argument(
        "--ref-text",
        type=str,
        default=None,
        help="Optional transcript of the reference audio. If omitted, "
             "Whisper auto-transcribes (slower; loads ASR model).",
    )
    parser.add_argument(
        "--model-id",
        type=str,
        default=DEFAULT_MODEL_ID,
    )
    parser.add_argument(
        "--asr-model-id",
        type=str,
        default=DEFAULT_ASR_MODEL_ID,
    )
    parser.add_argument(
        "--device",
        type=str,
        default=DEFAULT_DEVICE,
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Round-trip load the saved cell and verify it deserializes.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.ref_audio.exists():
        print(f"ERROR: reference audio not found at {args.ref_audio}")
        return 1

    print("=" * 64)
    print("Building voice cell")
    print("=" * 64)
    print(f"  ref_audio:   {args.ref_audio}")
    print(f"  output:      {args.output}")
    print(f"  ref_text:    {'(auto via Whisper)' if args.ref_text is None else repr(args.ref_text)}")
    print(f"  model_id:    {args.model_id}")
    print(f"  device:      {args.device}")
    print()

    from omnivoice import OmniVoice
    from omnivoice.models.omnivoice import VoiceClonePrompt

    # --- Phase 1: load OmniVoice ---
    print("[phase 1] Loading OmniVoice model...")
    t0 = time.time()
    model = OmniVoice.from_pretrained(args.model_id, device_map=args.device, dtype=torch.float16)
    t_model_load = time.time() - t0
    print(f"          done in {fmt_time(t_model_load)}")
    print()

    # --- Phase 2: load ASR (only if needed) ---
    t_asr_load = 0.0
    if args.ref_text is None:
        print("[phase 2] Loading Whisper ASR (for auto-transcription)...")
        t0 = time.time()
        model.load_asr_model(model_name=args.asr_model_id)
        t_asr_load = time.time() - t0
        print(f"          done in {fmt_time(t_asr_load)}")
        print()

    # --- Phase 3: encode the voice clone prompt ---
    print("[phase 3] Encoding reference audio into voice clone prompt...")
    t0 = time.time()
    prompt = model.create_voice_clone_prompt(
        ref_audio=str(args.ref_audio),
        ref_text=args.ref_text,
        preprocess_prompt=True,
    )
    t_encode = time.time() - t0
    print(f"          done in {fmt_time(t_encode)}")
    print(f"          ref_text: {prompt.ref_text!r}")
    print(f"          ref_audio_tokens shape: {tuple(prompt.ref_audio_tokens.shape)}")
    print(f"          ref_rms: {prompt.ref_rms:.6f}")
    print()

    # --- Phase 4: save ---
    print(f"[phase 4] Saving voice cell to {args.output}...")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    torch.save(
        {
            "ref_audio_tokens": prompt.ref_audio_tokens.cpu(),
            "ref_text": prompt.ref_text,
            "ref_rms": prompt.ref_rms,
            "_source_audio": str(args.ref_audio),
            "_created_at": time.time(),
            "_omnivoice_model_id": args.model_id,
        },
        args.output,
    )
    t_save = time.time() - t0
    cell_size = args.output.stat().st_size
    print(f"          done in {fmt_time(t_save)}")
    print(f"          cell size on disk: {fmt_size(cell_size)}")
    print()

    # --- Phase 5: optional validation ---
    if args.validate:
        print("[phase 5] Validating round-trip load...")
        t0 = time.time()
        loaded = torch.load(args.output, weights_only=False, map_location="cpu")
        reconstructed = VoiceClonePrompt(
            ref_audio_tokens=loaded["ref_audio_tokens"],
            ref_text=loaded["ref_text"],
            ref_rms=loaded["ref_rms"],
        )
        t_load = time.time() - t0
        ok = (
            reconstructed.ref_text == prompt.ref_text
            and reconstructed.ref_audio_tokens.shape == prompt.ref_audio_tokens.shape
            and reconstructed.ref_rms == prompt.ref_rms
        )
        print(f"          done in {fmt_time(t_load)} — match: {ok}")
        print()
        if not ok:
            print("WARNING: round-trip mismatch")
            return 2

    # --- Summary ---
    print("=" * 64)
    print("SUMMARY")
    print("=" * 64)
    print(f"  Model load:    {fmt_time(t_model_load)}")
    if args.ref_text is None:
        print(f"  ASR load:      {fmt_time(t_asr_load)}")
    print(f"  Cell encode:   {fmt_time(t_encode)}")
    print(f"  Cell save:     {fmt_time(t_save)}")
    print(f"  Cell size:     {fmt_size(cell_size)}")
    print()
    print(f"  Saved to:      {args.output}")
    print(f"  Transcript:    {prompt.ref_text!r}")
    print()
    print("Next step: point a daemon at this cell via OMNIVOICE_CELL_PATH or --cell.")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
