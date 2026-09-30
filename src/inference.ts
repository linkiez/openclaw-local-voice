import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipelineType,
} from "@huggingface/transformers";

import { pcm16ToFloat32 } from "./audio.js";
import { appConfig } from "./config.js";

let transcriberPromise:
  | Promise<AutomaticSpeechRecognitionPipelineType>
  | undefined;

/**
 * Loads or returns the cached local Whisper pipeline.
 *
 * @param allowRemoteModels - Whether an uncached model may be downloaded.
 * @returns The CPU/quantized automatic speech recognition pipeline.
 */
export function loadWhisper(
  allowRemoteModels = process.env.HF_HUB_OFFLINE !== "1",
): Promise<AutomaticSpeechRecognitionPipelineType> {
  env.cacheDir = appConfig.whisperCacheDirectory;
  env.allowRemoteModels = allowRemoteModels;
  transcriberPromise ??= pipeline(
    "automatic-speech-recognition",
    appConfig.whisperModel,
    { device: "cpu", dtype: "q8" },
  ).catch((error: unknown) => {
    transcriberPromise = undefined;
    throw error;
  });
  return transcriberPromise;
}

/**
 * Runs local Whisper transcription for one mono 16 kHz PCM utterance.
 *
 * @param model - Loaded Whisper pipeline.
 * @param pcm - Captured PCM16 audio.
 * @param language - Source language, either "en" or "pt".
 * @returns Recognized text without surrounding whitespace.
 */
export async function transcribe(
  model: AutomaticSpeechRecognitionPipelineType,
  pcm: Buffer,
  language: "en" | "pt",
): Promise<string> {
  const samples = pcm16ToFloat32(pcm, appConfig.inputGain);
  const output = await model(samples, {
    language: language === "en" ? "english" : "portuguese",
    task: "transcribe",
    num_beams: 3,
    temperature: 0,
  });
  const first = Array.isArray(output) ? output[0] : output;
  return first?.text.trim() ?? "";
}
