from __future__ import annotations

import os
import select
import subprocess
import time
from collections import deque
from typing import Optional

import numpy as np

MIC_SOURCE = os.environ.get("VOICE_MIC_SOURCE", "default")
SAMPLE_RATE = 16_000
FRAME_MS = 100
FRAME_BYTES = SAMPLE_RATE * 2 * FRAME_MS // 1000
PRE_ROLL_FRAMES = 5
RMS_THRESHOLD = int(os.environ.get("VOICE_RMS_THRESHOLD", "250"))
SILENCE_FRAMES = 7
MAX_UTTERANCE_FRAMES = 120


class Microphone:
    def __init__(self) -> None:
        self.process: Optional[subprocess.Popen[bytes]] = None

    def start(self) -> None:
        if self.process is not None:
            return
        self.process = subprocess.Popen(
            [
                "parec",
                f"--device={MIC_SOURCE}",
                "--raw",
                "--format=s16le",
                f"--rate={SAMPLE_RATE}",
                "--channels=1",
                "--latency-msec=100",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        time.sleep(0.15)
        if self.process.poll() is not None:
            self.stop()
            raise RuntimeError("PipeWire microphone stream failed to start")

    def stop(self) -> None:
        if self.process is None:
            return
        process, self.process = self.process, None
        try:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        finally:
            if process.stdout is not None:
                process.stdout.close()

    def read_frame(self, timeout: Optional[float]) -> Optional[bytes]:
        if self.process is None or self.process.stdout is None:
            raise RuntimeError("microphone is not running")
        deadline = None if timeout is None else time.monotonic() + timeout
        data = bytearray()
        while len(data) < FRAME_BYTES:
            remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
            ready, _, _ = select.select([self.process.stdout], [], [], remaining)
            if not ready:
                return None
            chunk = os.read(self.process.stdout.fileno(), FRAME_BYTES - len(data))
            if not chunk:
                raise RuntimeError("PipeWire microphone stream closed")
            data.extend(chunk)
        return bytes(data)


def capture_utterance(microphone: Microphone, timeout: Optional[float] = None) -> Optional[bytes]:
    deadline = None if timeout is None else time.monotonic() + timeout
    pre_roll: deque[bytes] = deque(maxlen=PRE_ROLL_FRAMES)
    active: Optional[list[bytes]] = None
    loud_frames = 0
    quiet_frames = 0
    voiced_frames = 0
    while True:
        remaining = None if active is not None or deadline is None else max(0.0, deadline - time.monotonic())
        frame = microphone.read_frame(remaining)
        if frame is None:
            return None if active is None else b"".join(active)
        samples = np.frombuffer(frame, dtype=np.int16).astype(np.float32)
        rms = float(np.sqrt(np.mean(samples * samples)))
        if active is None:
            pre_roll.append(frame)
            loud_frames = loud_frames + 1 if rms >= RMS_THRESHOLD else 0
            if loud_frames >= 2:
                active = list(pre_roll)
                voiced_frames = loud_frames
                quiet_frames = 0
        else:
            active.append(frame)
            if rms >= RMS_THRESHOLD * 0.7:
                voiced_frames += 1
                quiet_frames = 0
            else:
                quiet_frames += 1
            if quiet_frames >= SILENCE_FRAMES or len(active) >= MAX_UTTERANCE_FRAMES:
                return b"".join(active) if voiced_frames >= 4 else None
