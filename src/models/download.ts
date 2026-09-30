import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { env } from "@huggingface/transformers";

import { appConfig } from "../config.js";
import { loadWhisper } from "../inference.js";

const KOKORO_ASSETS = [
  {
    name: "kokoro-v1.0.onnx",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
  },
  {
    name: "voices-v1.0.bin",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
  },
] as const;

async function downloadAsset(
  url: string,
  destination: string,
): Promise<void> {
  try {
    const existing = await stat(destination);
    if (existing.isFile() && existing.size > 0) {
      return;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const temporaryPath = `${destination}.part-${process.pid}`;
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed with HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const chunks = Readable.from(
      (async function* (): AsyncGenerator<Uint8Array> {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              return;
            }
            yield chunk.value;
          }
        } finally {
          reader.releaseLock();
        }
      })(),
    );
    await pipeline(
      chunks,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    const downloaded = await stat(temporaryPath);
    if (!downloaded.isFile() || downloaded.size === 0) {
      throw new Error("Model download returned an empty file");
    }
    await rename(temporaryPath, destination);
  } catch (error) {
    throw new Error(`Could not download model asset ${url}`, { cause: error });
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Downloads local Whisper cache and Kokoro model assets required by the app.
 *
 * @returns A promise resolved when the local models are ready.
 */
export async function downloadModels(): Promise<void> {
  env.cacheDir = appConfig.whisperCacheDirectory;
  env.allowRemoteModels = true;
  await mkdir(appConfig.whisperCacheDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(appConfig.voiceDataDirectory, "models/kokoro"), {
    recursive: true,
    mode: 0o700,
  });

  const whisper = await loadWhisper(true);
  await whisper.dispose();
  await Promise.all(
    KOKORO_ASSETS.map((asset) =>
      downloadAsset(
        asset.url,
        join(appConfig.voiceDataDirectory, "models/kokoro", asset.name),
      ),
    ),
  );
  console.log(`Local models are ready in ${appConfig.voiceDataDirectory}/models`);
}

if (
  process.argv[1] &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  downloadModels().catch((error: unknown) => {
    console.error(
      "Model download failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exitCode = 1;
  });
}
