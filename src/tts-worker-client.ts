import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import { appConfig } from "./config.js";

/** Mono PCM16 result returned by the local Kokoro worker. */
export interface PcmAudio {
  /** Sample rate in hertz. */
  sampleRate: number;
  /** Little-endian signed 16-bit samples. */
  pcm16: Buffer;
}

interface PendingResponse {
  resolve: (audio: PcmAudio) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decodes and validates one JSON response from the Kokoro worker.
 *
 * @param line - Newline-delimited JSON response.
 * @returns Validated sample rate and PCM16 audio.
 * @throws {Error} If the response is malformed or contains invalid audio.
 */
export function parseTtsResponse(line: string): PcmAudio {
  let response: unknown;
  try {
    response = JSON.parse(line);
  } catch (error) {
    throw new Error("Kokoro worker response was not valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(response)) {
    throw new Error("Kokoro worker response was not an object");
  }

  const sampleRate = response.sampleRate;
  const encodedAudio = response.pcm16;
  if (
    typeof sampleRate !== "number" ||
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate > 192_000 ||
    typeof encodedAudio !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encodedAudio,
    )
  ) {
    throw new Error("Kokoro worker returned invalid audio");
  }

  const pcm16 = Buffer.from(encodedAudio, "base64");
  if (
    pcm16.length === 0 ||
    pcm16.length % 2 !== 0 ||
    pcm16.toString("base64") !== encodedAudio
  ) {
    throw new Error("Kokoro worker returned invalid audio");
  }
  return { sampleRate, pcm16 };
}

/**
 * Maintains one local Python/Kokoro worker to preserve the `pf_dora` voice.
 */
export class KokoroWorkerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending: PendingResponse[] = [];
  private closed = false;

  /**
   * Creates a client for the persistent local Python worker.
   *
   * @param pythonExecutable - Python runtime used for Kokoro.
   * @param workerPath - Worker script path.
   */
  constructor(
    private readonly pythonExecutable = appConfig.ttsPython,
    private readonly workerPath = appConfig.kokoroWorkerPath,
  ) {}

  /**
   * Requests PCM16 synthesis without logging or persisting the spoken text.
   *
   * @param text - Plain assistant reply to synthesize.
   * @returns Synthesized mono PCM16 audio.
   * @throws {Error} If the local worker or synthesis fails.
   */
  synthesize(text: string): Promise<PcmAudio> {
    if (this.closed) {
      return Promise.reject(new Error("Kokoro worker client is closed"));
    }
    const child = this.startWorker();

    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      try {
        child.stdin.write(`${JSON.stringify({ text })}\n`, (error) => {
          if (error) {
            this.failPending(new Error("Could not send text to Kokoro worker", {
              cause: error,
            }));
          }
        });
      } catch (error) {
        this.pending.pop();
        reject(
          new Error("Could not send text to Kokoro worker", { cause: error }),
        );
      }
    });
  }

  /**
   * Loads Kokoro before the first assistant reply is ready to speak.
   *
   * @returns A promise resolved after a short local synthesis completes.
   */
  async warmUp(): Promise<void> {
    await this.synthesize("Pronto.");
  }

  /**
   * Stops the worker and waits for its process to exit.
   *
   * @returns A promise resolved after worker cleanup.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failPending(new Error("Kokoro worker client is closing"));

    const child = this.child;
    if (!child) {
      return;
    }
    child.stdin.end();
    const exited = once(child, "close").then(() => undefined);
    await Promise.race([exited, delay(2_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited, delay(2_000)]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }

  private startWorker(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }

    const child = spawn(this.pythonExecutable, [this.workerPath], {
      cwd: appConfig.projectDirectory,
      env: {
        ...process.env,
        HF_HUB_DISABLE_TELEMETRY: "1",
        HF_HUB_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => this.handleLine(line));
    output.on("close", () => {
      this.failPending(new Error("Kokoro worker closed unexpectedly"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.stdin.on("error", (error) => {
      this.failPending(new Error("Could not communicate with the Kokoro worker", {
        cause: error,
      }));
    });
    child.on("error", (error) => {
      this.failPending(new Error("Could not start the Kokoro worker", {
        cause: error,
      }));
    });
    child.on("close", (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (code !== 0 || signal !== null) {
        this.failPending(new Error("Kokoro worker process failed"));
      }
    });
    return child;
  }

  private handleLine(line: string): void {
    const pending = this.pending.shift();
    if (!pending) {
      process.stderr.write("Kokoro worker returned an unexpected response\n");
      return;
    }

    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch (error) {
      pending.reject(
        new Error("Kokoro worker response was not valid JSON", { cause: error }),
      );
      return;
    }
    if (isRecord(response) && typeof response.error === "string") {
      pending.reject(new Error("Local Kokoro TTS synthesis failed"));
      return;
    }
    try {
      pending.resolve(parseTtsResponse(line));
    } catch (error) {
      pending.reject(
        error instanceof Error
          ? error
          : new Error("Kokoro worker returned invalid audio"),
      );
    }
  }

  private failPending(error: Error): void {
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(error);
    }
  }
}
