import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  isEnglishWakeCandidate,
  spokenText,
  stripWakePrefix,
} from "./audio.js";
import { captureUtterance, Microphone } from "./capture.js";
import { appConfig } from "./config.js";
import { createGatewayCall, askOpenClaw } from "./gateway.js";
import { loadWhisper, transcribe } from "./inference.js";
import { KokoroWorkerClient } from "./tts-worker-client.js";

const runFile = promisify(execFile);
const logger = {
  info(message: string): void {
    console.error(`INFO ${message}`);
  },
  error(message: string, error?: unknown): void {
    console.error(`ERROR ${message}`);
    if (error instanceof Error) {
      console.error(error.message);
    }
  },
};

async function playLocalBell(): Promise<void> {
  try {
    await runFile("paplay", [appConfig.wakeBellPath], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    throw new Error("Local bell playback failed", { cause: error });
  }
}

async function playAudioCue(
  microphone: Microphone,
  cueName: string,
): Promise<void> {
  await microphone.stop();
  try {
    await playLocalBell();
  } catch (error) {
    logger.error(`${cueName} playback failed; continuing without audio cue`, error);
  } finally {
    await microphone.start();
  }
}

async function playPcm(pcm16: Buffer, sampleRate: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const player = spawn(
      "paplay",
      [
        "--raw",
        "--format=s16le",
        `--rate=${sampleRate}`,
        "--channels=1",
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    if (!player.stdin) {
      player.kill();
      rejectPromise(new Error("Local playback process has no audio input"));
      return;
    }
    player.once("error", (error) => {
      rejectPromise(new Error("Local audio playback could not start", {
        cause: error,
      }));
    });
    player.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error("Local speech playback failed"));
      }
    });
    player.stdin.once("error", (error) => {
      rejectPromise(new Error("Could not send audio to the playback device", {
        cause: error,
      }));
    });
    player.stdin.end(pcm16);
  });
}

async function speak(
  text: string,
  ttsWorker: KokoroWorkerClient,
): Promise<void> {
  const plainText = spokenText(text);
  if (!plainText) {
    return;
  }
  const audio = await ttsWorker.synthesize(plainText);
  await playPcm(audio.pcm16, audio.sampleRate);
}

async function respond(
  microphone: Microphone,
  command: string,
  ttsWorker: KokoroWorkerClient,
): Promise<void> {
  const gatewayCall = createGatewayCall();
  while (command) {
    await microphone.stop();
    let requestSucceeded = false;
    try {
      const response = await askOpenClaw(command, gatewayCall);
      await speak(response, ttsWorker);
      requestSucceeded = true;
    } catch (error) {
      logger.error("Voice request failed; transcript and audio were not logged", error);
      try {
        await speak("Não consegui completar a solicitação agora.", ttsWorker);
      } catch (speechError) {
        logger.error("Could not play the voice failure message", speechError);
      }
    } finally {
      await microphone.start();
    }

    if (!requestSucceeded) {
      return;
    }

    await playAudioCue(microphone, "Follow-up capture-start bell");
    logger.info(
      `Listening locally for a follow-up for up to ${
        appConfig.followUpWaitMs / 1_000
      } seconds`,
    );
    const followUpAudio = await captureUtterance(
      microphone,
      appConfig.followUpWaitMs,
    );
    await playAudioCue(microphone, "Follow-up capture-complete bell");
    if (!followUpAudio) {
      logger.info("Follow-up window ended without speech; waiting for wake phrase");
      return;
    }

    command = stripWakePrefix(
      await transcribe(await loadWhisper(), followUpAudio, "pt"),
    );
    if (!command) {
      logger.info("No follow-up command recognized; waiting for wake phrase");
      return;
    }
    logger.info("Follow-up command captured locally; transcript is not logged");
  }
}

async function handleWake(
  microphone: Microphone,
  pcm: Buffer,
  ttsWorker: KokoroWorkerClient,
): Promise<void> {
  await playAudioCue(microphone, "Wake bell");
  const model = await loadWhisper();
  let command = stripWakePrefix(await transcribe(model, pcm, "pt"));
  if (command) {
    await respond(microphone, command, ttsWorker);
    return;
  }

  await microphone.stop();
  try {
    await speak("Estou ouvindo.", ttsWorker);
  } finally {
    await microphone.start();
  }
  await playAudioCue(microphone, "Capture-start bell");
  const nextAudio = await captureUtterance(microphone, appConfig.commandWaitMs);
  await playAudioCue(microphone, "Capture-complete bell");
  if (!nextAudio) {
    await microphone.stop();
    try {
      await speak("Não ouvi o comando.", ttsWorker);
    } finally {
      await microphone.start();
    }
    return;
  }

  command = stripWakePrefix(await transcribe(model, nextAudio, "pt"));
  if (command) {
    await respond(microphone, command, ttsWorker);
    return;
  }

  await microphone.stop();
  try {
    await speak("Não consegui entender. Pode repetir?", ttsWorker);
  } finally {
    await microphone.start();
  }
}

/**
 * Starts local wake-word listening and coordinates the voice conversation.
 *
 * @returns A promise that settles when startup or a fatal runtime error occurs.
 */
export async function main(): Promise<void> {
  const microphone = new Microphone();
  const ttsWorker = new KokoroWorkerClient();
  const model = await loadWhisper();
  let stopping = false;
  const stop = (): void => {
    stopping = true;
    void microphone.stop().catch((error: unknown) => {
      logger.error("Could not stop the microphone cleanly", error);
    });
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await microphone.start();
    logger.info(
      "Listening locally for OpenClaw; audio and recognized text are not logged or uploaded",
    );
    while (!stopping) {
      try {
        const pcm = await captureUtterance(microphone);
        if (!pcm) {
          continue;
        }
        const englishText = await transcribe(model, pcm, "en");
        if (!isEnglishWakeCandidate(englishText)) {
          logger.info("Wake phrase not detected in captured audio");
          continue;
        }
        logger.info("OpenClaw wake phrase detected");
        await handleWake(microphone, pcm, ttsWorker);
      } catch (error) {
        if (stopping) {
          break;
        }
        logger.error("Local voice recognition failed; audio was discarded", error);
        await microphone.stop();
        await delay(500);
        await microphone.start();
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await microphone.stop();
    await ttsWorker.close();
    await model.dispose();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    logger.error("OpenClaw local voice assistant stopped", error);
    process.exitCode = 1;
  });
}
