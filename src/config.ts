import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function positiveNumber(name: string, defaultValue: number): number {
  const configuredValue = process.env[name];
  const value = configuredValue === undefined ? defaultValue : Number(configuredValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function positiveInteger(name: string, defaultValue: number): number {
  const value = positiveNumber(name, defaultValue);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(moduleDirectory, "../..");
const voiceDataDirectory = resolve(
  process.env.OPENCLAW_VOICE_DATA_DIR ??
    join(homedir(), ".local/share/openclaw-voice"),
);
const configuredWhisperModel =
  process.env.VOICE_WHISPER_MODEL ?? process.env.VOICE_WAKE_MODEL ?? "small";
const whisperModel = configuredWhisperModel.startsWith("onnx-community/")
  ? configuredWhisperModel
  : `onnx-community/whisper-${configuredWhisperModel}`;
const openClawCommand =
  process.env.OPENCLAW_COMMAND ?? process.env.OPENCLAW_CLI ?? "openclaw";

if (!openClawCommand.trim()) {
  throw new Error("OPENCLAW_COMMAND must not be empty");
}

/** Validated paths and runtime options shared by the voice modules. */
export const appConfig = Object.freeze({
  projectDirectory,
  voiceDataDirectory,
  whisperModel,
  whisperCacheDirectory: join(voiceDataDirectory, "models/whisper"),
  kokoroModelPath: join(
    voiceDataDirectory,
    "models/kokoro/kokoro-v1.0.onnx",
  ),
  kokoroVoicesPath: join(voiceDataDirectory, "models/kokoro/voices-v1.0.bin"),
  kokoroWorkerPath: join(projectDirectory, "tools/kokoro_tts_worker.py"),
  ttsPython:
    process.env.OPENCLAW_TTS_PYTHON ??
    join(voiceDataDirectory, "venv/bin/python"),
  microphoneSource: process.env.VOICE_MIC_SOURCE ?? "default",
  rmsThreshold: positiveInteger("VOICE_RMS_THRESHOLD", 250),
  inputGain: positiveNumber("VOICE_INPUT_GAIN", 6),
  wakeBellPath:
    process.env.VOICE_WAKE_BELL_SOUND ??
    "/usr/share/sounds/freedesktop/stereo/bell.oga",
  openClawCommand,
  agentId: "voice",
  sessionKey:
    process.env.OPENCLAW_SESSION_KEY ??
    "agent:voice:explicit:openclaw-local-voice",
  commandWaitMs: 8_000,
  followUpWaitMs: 15_000,
  chatTimeoutMs: 90_000,
  chatPollIntervalMs: 100,
});
