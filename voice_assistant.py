#!/usr/bin/env python3
"""Local wake phrase listener that sends only transcribed commands to OpenClaw."""
from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import sys
import time
import unicodedata
import uuid
import wave
from pathlib import Path
from typing import Optional

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import numpy as np
import onnxruntime as ort
from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro

from audio_capture import Microphone, capture_utterance

ROOT = Path.home() / ".local/share/openclaw-voice"
WHISPER_CACHE = ROOT / "models/whisper"
KOKORO_MODEL = ROOT / "models/kokoro/kokoro-v1.0.onnx"
KOKORO_VOICES = ROOT / "models/kokoro/voices-v1.0.bin"
KOKORO_VOICE = "pf_dora"
WAKE_BELL_SOUND = Path("/usr/share/sounds/freedesktop/stereo/bell.oga")
WAKE_MODEL = os.environ.get("VOICE_WAKE_MODEL", "small")
LANGUAGE = "pt"
INPUT_GAIN = float(os.environ.get("VOICE_INPUT_GAIN", "6.0"))
COMMAND_WAIT_SECONDS = 8
FOLLOW_UP_WAIT_SECONDS = 15
AGENT_ID = "voice"
OPENCLAW_COMMAND = shlex.split(os.environ.get("OPENCLAW_COMMAND", "openclaw"))
if not OPENCLAW_COMMAND:
    raise RuntimeError("OPENCLAW_COMMAND must not be empty")
SESSION_KEY = os.environ.get(
    "OPENCLAW_SESSION_KEY",
    f"agent:{AGENT_ID}:explicit:openclaw-local-voice",
)
CHAT_TIMEOUT_SECONDS = 90
CHAT_POLL_INTERVAL_SECONDS = 0.25

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("faster_whisper").setLevel(logging.WARNING)
logging.getLogger("ctranslate2").setLevel(logging.WARNING)
LOGGER = logging.getLogger("openclaw-voice")
_KOKORO: Optional[Kokoro] = None


def normalize_tokens(text: str) -> tuple[str, ...]:
    normalized = unicodedata.normalize("NFKD", text.lower())
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    return tuple(re.findall(r"[a-z0-9]+", ascii_text))


def is_direct_english_wake(text: str) -> bool:
    tokens = normalize_tokens(text)
    return tokens[:1] == ("openclaw",) or tokens[:2] == ("open", "claw")


def is_english_wake_candidate(text: str) -> bool:
    tokens = normalize_tokens(text)
    return is_direct_english_wake(text) or tokens[:2] == ("open", "cloud")


def is_portuguese_wake_confirmation(text: str) -> bool:
    tokens = normalize_tokens(text)
    prefixes = (
        ("openclaw",),
        ("open", "claw"),
        ("oping", "clau"),
        ("oping", "cloud"),
    )
    return any(tokens[: len(prefix)] == prefix for prefix in prefixes)


def strip_wake_prefix(text: str) -> str:
    spans = list(re.finditer(r"[^\W_]+", text, flags=re.UNICODE))
    tokens = [normalize_tokens(match.group()) for match in spans]
    flattened = [item[0] if item else "" for item in tokens]
    prefixes = (
        ("openclaw",),
        ("open", "claw"),
        ("open", "clau"),
        ("open", "cloud"),
        ("oping", "clau"),
        ("oping", "cloud"),
    )
    for prefix in prefixes:
        if tuple(flattened[: len(prefix)]) == prefix:
            return text[spans[len(prefix) - 1].end() :].lstrip(" \t\r\n,.;:!?—-").strip()
    return text.strip()


def prepare_audio(pcm: bytes, gain: float = INPUT_GAIN) -> np.ndarray:
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return np.clip(samples * gain, -1.0, 1.0)


def transcribe(model: WhisperModel, pcm: bytes, language: str) -> str:
    samples = prepare_audio(pcm)
    segments, _ = model.transcribe(
        samples,
        language=language,
        beam_size=3,
        vad_filter=True,
        vad_parameters={"threshold": 0.7, "min_speech_duration_ms": 500},
        condition_on_previous_text=False,
        temperature=0.0,
    )
    return " ".join(segment.text.strip() for segment in segments).strip()


def detect_wake(model: WhisperModel, pcm: bytes) -> tuple[bool, Optional[str]]:
    english_text = transcribe(model, pcm, "en")
    if is_direct_english_wake(english_text):
        LOGGER.info("Wake detector: direct English phrase match")
        return True, None
    if is_english_wake_candidate(english_text):
        LOGGER.info("Wake detector: accepting English wake candidate, including Open Cloud")
        return True, None
    else:
        LOGGER.info("Wake detector: English transcription did not match a candidate")
    return False, None


def spoken_text(text: str) -> str:
    text = re.sub(r"```.*?```", " bloco de código omitido ", text, flags=re.DOTALL)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"https?://\S+", "link", text)
    text = re.sub(r"[`*_#>]", "", text)
    return re.sub(r"\s+", " ", text).strip()[:1400]


def audio_to_pcm16(samples: np.ndarray) -> bytes:
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype(np.int16).tobytes()


def synthesize_pcm16(text: str) -> tuple[bytes, int]:
    global _KOKORO
    text = spoken_text(text)
    if not text:
        return b"", 0
    if not KOKORO_MODEL.is_file() or not KOKORO_VOICES.is_file():
        raise RuntimeError("local Kokoro TTS model files are missing")
    if _KOKORO is None:
        ort.preload_dlls()
        _KOKORO = Kokoro(str(KOKORO_MODEL), str(KOKORO_VOICES))
        if "CUDAExecutionProvider" not in _KOKORO.sess.get_providers():
            _KOKORO = None
            raise RuntimeError("Kokoro TTS did not initialize on the CUDA provider")
        LOGGER.info("Loaded local Kokoro TTS voice %s on CUDA", KOKORO_VOICE)
    samples, sample_rate = _KOKORO.create(
        text,
        voice=KOKORO_VOICE,
        speed=0.95,
        lang="pt-br",
    )
    if samples.size == 0:
        raise RuntimeError("local Kokoro TTS returned no audio")
    return audio_to_pcm16(samples), sample_rate


def speak(text: str) -> None:
    pcm, sample_rate = synthesize_pcm16(text)
    if not pcm:
        return
    result = subprocess.run(
        ["paplay", "--raw", "--format=s16le", f"--rate={sample_rate}", "--channels=1"],
        input=pcm,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=90,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("local Kokoro TTS playback failed")


def play_local_bell() -> None:
    if not WAKE_BELL_SOUND.is_file():
        raise RuntimeError("wake bell sound file is missing")
    try:
        result = subprocess.run(
            ["paplay", str(WAKE_BELL_SOUND)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
        )
    except subprocess.SubprocessError as error:
        raise RuntimeError("wake bell playback failed") from error
    if result.returncode != 0:
        raise RuntimeError("local bell playback failed")


def play_audio_cue(microphone: Microphone, cue_name: str) -> None:
    microphone.stop()
    try:
        play_local_bell()
    except (OSError, RuntimeError, subprocess.SubprocessError):
        LOGGER.exception("%s playback failed; continuing without audio cue", cue_name)
    finally:
        microphone.start()


def gateway_call(method: str, params: dict[str, object]) -> dict[str, object]:
    result = subprocess.run(
        [
            *OPENCLAW_COMMAND,
            "gateway",
            "call",
            method,
            "--params",
            json.dumps(params, ensure_ascii=False, separators=(",", ":")),
            "--json",
            "--timeout",
            "15000",
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"OpenClaw Gateway {method} request failed (exit {result.returncode})"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"OpenClaw Gateway {method} response was not valid JSON") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"OpenClaw Gateway {method} response was not an object")
    return payload


def chat_message_text(message: dict[str, object]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    return " ".join(
        part["text"].strip()
        for part in content
        if isinstance(part, dict)
        and part.get("type") == "text"
        and isinstance(part.get("text"), str)
        and part["text"].strip()
    ).strip()


def ask_openclaw(command: str) -> str:
    prompt = (
        "Você é o assistente de voz local do OpenClaw. "
        "O reconhecimento foi feito localmente. Responda em português brasileiro, "
        "com concisão. A mensagem transcrita do usuário é:\n" + command
    )
    history_params = {"sessionKey": SESSION_KEY, "agentId": AGENT_ID, "limit": 20}
    initial_history = gateway_call("chat.history", history_params)
    initial_messages = initial_history.get("messages")
    session_info = initial_history.get("sessionInfo")
    if not isinstance(initial_messages, list) or not isinstance(session_info, dict):
        raise RuntimeError("OpenClaw chat history response was incomplete")
    if session_info.get("hasActiveRun") is True:
        raise RuntimeError("OpenClaw voice chat already has an active run")
    previous_messages = {
        (message.get("role"), message.get("timestamp"), chat_message_text(message))
        for message in initial_messages
        if isinstance(message, dict)
    }

    acknowledgement = gateway_call(
        "chat.send",
        {
            "sessionKey": SESSION_KEY,
            "agentId": AGENT_ID,
            "message": prompt,
            "idempotencyKey": str(uuid.uuid4()),
            "timeoutMs": CHAT_TIMEOUT_SECONDS * 1000,
        },
    )
    run_id = acknowledgement.get("runId")
    if not isinstance(run_id, str) or not run_id:
        raise RuntimeError("OpenClaw chat.send did not return a run id")

    deadline = time.monotonic() + CHAT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        history = gateway_call("chat.history", history_params)
        messages = history.get("messages")
        session_info = history.get("sessionInfo")
        if not isinstance(messages, list) or not isinstance(session_info, dict):
            raise RuntimeError("OpenClaw chat history response was incomplete")
        active_run_ids = session_info.get("activeRunIds", [])
        run_is_active = isinstance(active_run_ids, list) and run_id in active_run_ids
        if not run_is_active:
            replies = [
                chat_message_text(message)
                for message in messages
                if isinstance(message, dict)
                and message.get("role") == "assistant"
                and (
                    message.get("role"),
                    message.get("timestamp"),
                    chat_message_text(message),
                )
                not in previous_messages
            ]
            answer = next((reply for reply in reversed(replies) if reply), "")
            if answer:
                return answer
        time.sleep(CHAT_POLL_INTERVAL_SECONDS)

    raise RuntimeError("OpenClaw voice chat did not finish before timeout")


def respond(microphone: Microphone, model: WhisperModel, command: str) -> None:
    while command:
        microphone.stop()
        request_succeeded = False
        try:
            response = ask_openclaw(command)
            speak(response)
            request_succeeded = True
        except Exception:
            LOGGER.exception("Voice request failed; transcript and audio were not logged")
            speak("Não consegui completar a solicitação agora.")
        finally:
            microphone.start()

        if not request_succeeded:
            return

        play_audio_cue(microphone, "Follow-up capture-start bell")
        LOGGER.info(
            "Listening locally for a follow-up for up to %s seconds",
            FOLLOW_UP_WAIT_SECONDS,
        )
        follow_up_audio = capture_utterance(microphone, FOLLOW_UP_WAIT_SECONDS)
        play_audio_cue(microphone, "Follow-up capture-complete bell")
        if not follow_up_audio:
            LOGGER.info("Follow-up window ended without speech; waiting for wake phrase")
            return

        command = strip_wake_prefix(transcribe(model, follow_up_audio, LANGUAGE))
        if not command:
            LOGGER.info("No follow-up command recognized; waiting for wake phrase")
            return
        LOGGER.info("Follow-up command captured locally; transcript is not logged")


def handle_wake(microphone: Microphone, model: WhisperModel, pcm: bytes, portuguese_text: Optional[str]) -> None:
    text = portuguese_text or transcribe(model, pcm, LANGUAGE)
    play_audio_cue(microphone, "Wake bell")
    command = strip_wake_prefix(text)
    if command:
        respond(microphone, model, command)
        return

    microphone.stop()
    speak("Estou ouvindo.")
    microphone.start()
    play_audio_cue(microphone, "Capture-start bell")
    next_audio = capture_utterance(microphone, COMMAND_WAIT_SECONDS)
    play_audio_cue(microphone, "Capture-complete bell")
    if not next_audio:
        microphone.stop()
        speak("Não ouvi o comando.")
        microphone.start()
        return
    command = strip_wake_prefix(transcribe(model, next_audio, LANGUAGE))
    if command:
        respond(microphone, model, command)
    else:
        microphone.stop()
        speak("Não consegui entender. Pode repetir?")
        microphone.start()


def main() -> None:
    ort.preload_dlls()
    model_path = WHISPER_CACHE
    if not model_path.exists():
        raise RuntimeError(f"local Whisper model cache is missing: {model_path}")
    model = WhisperModel(
        WAKE_MODEL,
        device="cpu",
        compute_type="int8",
        cpu_threads=int(os.environ.get("VOICE_CPU_THREADS", "4")),
        num_workers=1,
        download_root=str(model_path),
    )
    microphone = Microphone()
    microphone.start()
    LOGGER.info("Listening locally for OpenClaw on the selected microphone; audio is not saved or uploaded")
    try:
        while True:
            pcm = capture_utterance(microphone)
            if not pcm:
                continue
            try:
                detected, portuguese_text = detect_wake(model, pcm)
                if detected:
                    LOGGER.info("OpenClaw wake phrase detected")
                    handle_wake(microphone, model, pcm, portuguese_text)
                else:
                    LOGGER.info("Wake phrase not detected in captured audio")
            except Exception:
                LOGGER.exception("Local voice recognition failed; audio was discarded")
    finally:
        microphone.stop()


def tts_cli() -> None:
    pcm, sample_rate = synthesize_pcm16(sys.stdin.read())
    if not pcm or sample_rate <= 0:
        raise RuntimeError("local Kokoro TTS received no speech text")
    with wave.open(sys.stdout.buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm)


if __name__ == "__main__":
    if sys.argv[1:] == ["--tts-stdin"]:
        tts_cli()
    elif not sys.argv[1:]:
        main()
    else:
        raise SystemExit("usage: voice_assistant.py [--tts-stdin]")
