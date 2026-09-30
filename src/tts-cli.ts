import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { spokenText, pcm16ToWav } from "./audio.js";
import { KokoroWorkerClient } from "./tts-worker-client.js";

async function readTextInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 64 * 1024) {
      throw new Error("TTS input exceeds the supported size");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeOutput(audio: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.once("error", reject);
    process.stdout.write(audio, () => {
      process.stdout.off("error", reject);
      resolve();
    });
  });
}

/**
 * Reads speech text from stdin and writes a mono PCM16 WAV to stdout.
 *
 * @returns A promise resolved after the WAV has been written.
 */
export async function main(): Promise<void> {
  const text = spokenText(await readTextInput());
  if (!text) {
    throw new Error("Local Kokoro TTS received no speech text");
  }

  const worker = new KokoroWorkerClient();
  try {
    const audio = await worker.synthesize(text);
    await writeOutput(pcm16ToWav(audio.pcm16, audio.sampleRate));
  } finally {
    await worker.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(
      "Local Kokoro TTS failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exitCode = 1;
  });
}
