import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { appConfig } from "./config.js";

export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 100;
export const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1_000;

const PRE_ROLL_FRAMES = 5;
const SILENCE_FRAMES = 7;
const MAX_UTTERANCE_FRAMES = 120;
const MIN_VOICED_FRAMES = 4;

/** Source contract for sequential fixed-size PCM16 frame reads. */
export interface AudioFrameSource {
  /**
   * Reads the next frame from the active stream.
   *
   * @param timeoutMs - Optional read timeout.
   * @returns Audio frame, or null when the read times out.
   */
  readFrame(timeoutMs?: number): Promise<Buffer | null>;
}

interface PendingFrameRead {
  resolve: (frame: Buffer | null) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Captures mono PCM16 audio from the configured PipeWire/PulseAudio source.
 */
export class Microphone implements AudioFrameSource {
  private process: ChildProcess | undefined;
  private buffer = Buffer.alloc(0);
  private pendingRead: PendingFrameRead | undefined;
  private streamError: Error | undefined;

  /**
   * Starts the `parec` capture process if it is not already running.
   *
   * @returns A promise resolved after the audio stream has started.
   * @throws {Error} If `parec` cannot start or exits during initialization.
   */
  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const process = spawn(
      "parec",
      [
        `--device=${appConfig.microphoneSource}`,
        "--raw",
        "--format=s16le",
        `--rate=${SAMPLE_RATE}`,
        "--channels=1",
        "--latency-msec=100",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.process = process;
    this.buffer = Buffer.alloc(0);
    this.streamError = undefined;

    if (!process.stdout) {
      this.process = undefined;
      process.kill();
      throw new Error("PipeWire microphone stream did not provide audio output");
    }

    process.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.resolvePendingFrame();
    });
    process.stdout.on("end", () => {
      this.failPendingFrame(new Error("PipeWire microphone stream closed"));
    });
    process.stdout.on("error", (error: Error) => {
      this.failPendingFrame(
        new Error("PipeWire microphone stream failed", { cause: error }),
      );
    });
    process.on("error", (error) => {
      this.failPendingFrame(
        new Error("PipeWire microphone process failed", { cause: error }),
      );
    });
    process.once("close", (code, signal) => {
      if (this.process === process) {
        this.process = undefined;
      }
      if (code !== 0 || signal !== null) {
        this.failPendingFrame(new Error("PipeWire microphone stream stopped"));
      }
    });

    try {
      await once(process, "spawn");
      await delay(150);
      if (process.exitCode !== null || process.signalCode !== null) {
        throw new Error("PipeWire microphone stream failed to start");
      }
    } catch (error) {
      await this.stop();
      throw new Error("Could not start PipeWire microphone capture", {
        cause: error,
      });
    }
  }

  /**
   * Stops the capture process and releases any pending frame read.
   *
   * @returns A promise resolved when the process has exited.
   */
  async stop(): Promise<void> {
    const process = this.process;
    if (!process) {
      return;
    }
    this.process = undefined;
    this.failPendingFrame(new Error("Microphone capture stopped"));

    if (process.exitCode !== null || process.signalCode !== null) {
      return;
    }

    const closed = once(process, "close").then(() => undefined);
    process.kill("SIGTERM");
    await Promise.race([closed, delay(2_000)]);
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGKILL");
      await closed;
    }
  }

  /**
   * Reads exactly one 100 ms PCM16 frame from the active stream.
   *
   * @param timeoutMs - Optional maximum wait in milliseconds.
   * @returns The frame, or null when the read times out.
   * @throws {Error} If the microphone is stopped or the stream fails.
   */
  readFrame(timeoutMs?: number): Promise<Buffer | null> {
    if (!this.process) {
      return Promise.reject(new Error("Microphone is not running"));
    }
    if (this.streamError) {
      return Promise.reject(this.streamError);
    }
    if (this.buffer.length >= FRAME_BYTES) {
      const frame = this.buffer.subarray(0, FRAME_BYTES);
      this.buffer = this.buffer.subarray(FRAME_BYTES);
      return Promise.resolve(frame);
    }
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      return Promise.resolve(null);
    }
    if (this.pendingRead) {
      return Promise.reject(new Error("A microphone frame read is already pending"));
    }

    return new Promise((resolve, reject) => {
      const pendingRead: PendingFrameRead = { resolve, reject };
      if (timeoutMs !== undefined) {
        pendingRead.timer = setTimeout(() => {
          if (this.pendingRead === pendingRead) {
            this.pendingRead = undefined;
          }
          resolve(null);
        }, timeoutMs);
      }
      this.pendingRead = pendingRead;
      this.resolvePendingFrame();
    });
  }

  private resolvePendingFrame(): void {
    const pendingRead = this.pendingRead;
    if (!pendingRead || this.buffer.length < FRAME_BYTES) {
      return;
    }
    this.pendingRead = undefined;
    if (pendingRead.timer) {
      clearTimeout(pendingRead.timer);
    }
    const frame = this.buffer.subarray(0, FRAME_BYTES);
    this.buffer = this.buffer.subarray(FRAME_BYTES);
    pendingRead.resolve(frame);
  }

  private failPendingFrame(error: Error): void {
    this.streamError = error;
    const pendingRead = this.pendingRead;
    if (!pendingRead) {
      return;
    }
    this.pendingRead = undefined;
    if (pendingRead.timer) {
      clearTimeout(pendingRead.timer);
    }
    pendingRead.reject(error);
  }
}

/**
 * Finds one speech segment using pre-roll, RMS voice detection, and silence.
 *
 * @param microphone - Source of fixed-size PCM16 frames.
 * @param timeoutMs - Optional capture window before speech starts.
 * @returns Captured audio, or null when no valid utterance is detected.
 */
export async function captureUtterance(
  microphone: AudioFrameSource,
  timeoutMs?: number,
): Promise<Buffer | null> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const preRoll: Buffer[] = [];
  let activeFrames: Buffer[] | undefined;
  let loudFrames = 0;
  let quietFrames = 0;
  let voicedFrames = 0;

  while (true) {
    const remaining =
      activeFrames || deadline === undefined
        ? undefined
        : Math.max(0, deadline - Date.now());
    const frame = await microphone.readFrame(remaining);
    if (!frame) {
      return activeFrames ? Buffer.concat(activeFrames) : null;
    }
    if (frame.length !== FRAME_BYTES) {
      throw new Error("Microphone returned an invalid audio frame");
    }

    let sumSquares = 0;
    for (let offset = 0; offset < frame.length; offset += 2) {
      const sample = frame.readInt16LE(offset);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / (frame.length / 2));

    if (!activeFrames) {
      preRoll.push(frame);
      if (preRoll.length > PRE_ROLL_FRAMES) {
        preRoll.shift();
      }
      loudFrames = rms >= appConfig.rmsThreshold ? loudFrames + 1 : 0;
      if (loudFrames >= 2) {
        activeFrames = [...preRoll];
        voicedFrames = loudFrames;
        quietFrames = 0;
      }
      continue;
    }

    activeFrames.push(frame);
    if (rms >= appConfig.rmsThreshold * 0.7) {
      voicedFrames += 1;
      quietFrames = 0;
    } else {
      quietFrames += 1;
    }
    if (
      quietFrames >= SILENCE_FRAMES ||
      activeFrames.length >= MAX_UTTERANCE_FRAMES
    ) {
      return voicedFrames >= MIN_VOICED_FRAMES
        ? Buffer.concat(activeFrames)
        : null;
    }
  }
}
