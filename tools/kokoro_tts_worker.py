#!/usr/bin/env python3
"""Persistent local Kokoro TTS worker that preserves the pf_dora voice."""

from __future__ import annotations

import base64
import json
import logging
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from kokoro_onnx import Kokoro

LOGGER = logging.getLogger("openclaw-kokoro-worker")
VOICE_DATA_DIRECTORY = Path(
    os.environ.get(
        "OPENCLAW_VOICE_DATA_DIR",
        Path.home() / ".local/share/openclaw-voice",
    )
)
MODEL_PATH = VOICE_DATA_DIRECTORY / "models/kokoro/kokoro-v1.0.onnx"
VOICES_PATH = VOICE_DATA_DIRECTORY / "models/kokoro/voices-v1.0.bin"
VOICE_NAME = "pf_dora"


def encode_audio(samples: np.ndarray, sample_rate: int) -> dict[str, str | int]:
    """Validate audio and encode it as base64 little-endian signed PCM16."""
    normalized = np.asarray(samples, dtype=np.float32)
    if normalized.ndim != 1 or normalized.size == 0:
        raise ValueError("Kokoro returned no mono audio")
    if not np.isfinite(normalized).all():
        raise ValueError("Kokoro returned non-finite audio samples")
    if not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError("Kokoro returned an invalid sample rate")

    clipped = np.clip(normalized, -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype(np.int16).tobytes()
    return {
        "sampleRate": sample_rate,
        "pcm16": base64.b64encode(pcm16).decode("ascii"),
    }


def synthesize_text(kokoro: Kokoro, text: str) -> dict[str, str | int]:
    """Synthesize one Portuguese reply with the existing Kokoro voice."""
    if not text.strip():
        raise ValueError("Kokoro received empty speech text")
    if len(text) > 1_400:
        raise ValueError("Kokoro speech text exceeds the supported limit")

    samples, sample_rate = kokoro.create(
        text.strip(),
        voice=VOICE_NAME,
        speed=0.95,
        lang="pt-br",
    )
    return encode_audio(samples, sample_rate)


def load_kokoro() -> Kokoro:
    """Load the installed local Kokoro model and require its CUDA provider."""
    if not MODEL_PATH.is_file() or not VOICES_PATH.is_file():
        raise FileNotFoundError("Local Kokoro model files are missing")

    import onnxruntime as ort
    from kokoro_onnx import Kokoro as KokoroRuntime

    ort.preload_dlls()
    kokoro = KokoroRuntime(str(MODEL_PATH), str(VOICES_PATH))
    if "CUDAExecutionProvider" not in kokoro.sess.get_providers():
        raise RuntimeError("Kokoro TTS did not initialize on the CUDA provider")
    LOGGER.info("Loaded local Kokoro TTS voice %s on CUDA", VOICE_NAME)
    return kokoro


def handle_request(request: Any, kokoro: Kokoro | None) -> tuple[dict[str, str | int], Kokoro]:
    """Validate one JSON request, initialize Kokoro lazily, and synthesize."""
    if not isinstance(request, dict) or not isinstance(request.get("text"), str):
        raise ValueError("Invalid Kokoro worker request")
    model = kokoro if kokoro is not None else load_kokoro()
    return synthesize_text(model, request["text"]), model


def main() -> int:
    """Serve newline-delimited requests until stdin closes."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    kokoro: Kokoro | None = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response, kokoro = handle_request(request, kokoro)
        except json.JSONDecodeError:
            response = {"error": "Invalid Kokoro worker request"}
        except Exception as error:
            LOGGER.error(
                "Local Kokoro TTS request failed: %s",
                type(error).__name__,
            )
            response = {"error": "Local Kokoro TTS synthesis failed"}
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
