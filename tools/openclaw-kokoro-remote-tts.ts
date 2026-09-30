import { spawn } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_WAV_BYTES = 50 * 1024 * 1024;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function remotePath(value: string | undefined, homeRelativePath: string): string {
  return value ? shellQuote(value) : `"$HOME/${homeRelativePath}"`;
}

function validateTarget(target: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(target) || target.startsWith("-")) {
    throw new Error("OPENCLAW_VOICE_NODE must be an SSH host alias");
  }
}

/**
 * Verifies that remote audio is a bounded mono PCM16 WAV buffer.
 *
 * @param wav - Candidate WAV data from the voice node.
 * @throws {Error} If audio format, channels, or size are invalid.
 */
export function validateWav(wav: Buffer): void {
  if (
    wav.length < 44 ||
    wav.length > MAX_WAV_BYTES ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE" ||
    wav.toString("ascii", 12, 16) !== "fmt " ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt32LE(24) <= 0 ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString("ascii", 36, 40) !== "data" ||
    wav.readUInt32LE(40) !== wav.length - 44
  ) {
    throw new Error("Remote Kokoro TTS returned invalid WAV audio");
  }
}

function synthesizeRemotely(target: string, text: string): Promise<Buffer> {
  validateTarget(target);
  const nodeExecutable = remotePath(
    process.env.OPENCLAW_VOICE_NODE_BIN,
    ".nvs/node/24.15.0/x64/bin/node",
  );
  const ttsScript = remotePath(
    process.env.OPENCLAW_VOICE_TTS_SCRIPT,
    ".local/share/openclaw-voice/dist/src/tts-cli.js",
  );
  const remoteCommand = [
    "/usr/bin/env",
    "HF_HUB_OFFLINE=1",
    "HF_HUB_DISABLE_TELEMETRY=1",
    nodeExecutable,
    ttsScript,
  ]
    .join(" ");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "StrictHostKeyChecking=yes",
        target,
        remoteCommand,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let timedOut = false;
    let oversized = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 115_000);

    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_WAV_BYTES) {
        oversized = true;
        child.kill("SIGTERM");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      while (Buffer.concat(stderr).length > 4_000) {
        const first = stderr.shift();
        if (!first) {
          break;
        }
        const extraBytes = Buffer.concat(stderr).length - 4_000;
        if (extraBytes > 0 && stderr[0]) {
          stderr[0] = stderr[0].subarray(extraBytes);
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error("Could not start the remote Kokoro TTS command", {
        cause: error,
      }));
    });
    child.stdin.once("error", (error) => {
      reject(new Error("Could not send text to remote Kokoro TTS", {
        cause: error,
      }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("Remote Kokoro TTS timed out"));
      } else if (oversized) {
        reject(new Error("Remote Kokoro TTS output exceeded 50 MiB"));
      } else if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            diagnostic
              ? `Remote Kokoro TTS failed: ${diagnostic}`
              : "Remote Kokoro TTS failed",
          ),
        );
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
    child.stdin.end(text, "utf8");
  });
}

/**
 * Synthesizes a WAV through the configured local voice node and stores it safely.
 *
 * @returns A promise resolved after validated WAV output is written.
 */
export async function main(): Promise<void> {
  const [outputPath, text, ...extraArguments] = process.argv.slice(2);
  if (!outputPath || text === undefined || extraArguments.length > 0) {
    throw new Error(
      "usage: openclaw-kokoro-remote-tts OUTPUT_PATH TEXT",
    );
  }

  const target = process.env.OPENCLAW_VOICE_NODE ?? "openclaw-voice-node";
  const wav = await synthesizeRemotely(target, text);
  validateWav(wav);

  const temporaryPath = `${outputPath}.part-${process.pid}`;
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(temporaryPath, wav, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(
      "Remote Kokoro TTS failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exitCode = 1;
  });
}
