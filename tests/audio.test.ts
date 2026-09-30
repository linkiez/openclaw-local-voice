import assert from "node:assert/strict";
import test from "node:test";

import {
  audioToPcm16,
  isDirectEnglishWake,
  isEnglishWakeCandidate,
  isPortugueseWakeConfirmation,
  pcm16ToWav,
  pcm16ToFloat32,
  spokenText,
  stripWakePrefix,
} from "../src/audio.js";

test("matches direct and ambiguous English wake phrases", () => {
  assert.equal(isDirectEnglishWake("Open claw, what time is it?"), true);
  assert.equal(isDirectEnglishWake("OpenClaw"), true);
  assert.equal(isEnglishWakeCandidate("Open cloud, keyword assault"), true);
  assert.equal(isDirectEnglishWake("Open cloud services"), false);
});

test("confirms Portuguese wake phrase candidates", () => {
  assert.equal(isPortugueseWakeConfirmation("Oping Cloud, que horas são?"), true);
  assert.equal(isPortugueseWakeConfirmation("Open cloud services"), false);
});

test("strips supported wake prefixes without changing ordinary commands", () => {
  assert.equal(stripWakePrefix("Oping clau, que horas são?"), "que horas são?");
  assert.equal(stripWakePrefix("OpenClaw"), "");
  assert.equal(stripWakePrefix("Que horas são?"), "Que horas são?");
});

test("normalizes, amplifies, and clips incoming PCM samples", () => {
  const pcm = Buffer.alloc(8);
  [-1_000, 1_000, -10_000, 10_000].forEach((sample, index) =>
    pcm.writeInt16LE(sample, index * 2),
  );

  assert.deepEqual(Array.from(pcm16ToFloat32(pcm, 4)), [
    -4_000 / 32_768,
    4_000 / 32_768,
    -1,
    1,
  ]);
});

test("rejects incomplete PCM frames", () => {
  assert.throws(() => pcm16ToFloat32(Buffer.from([0]), 1), /even number of bytes/);
});

test("converts float samples to clipped signed PCM16", () => {
  const pcm = audioToPcm16(new Float32Array([-1.5, -0.5, 0.5, 1.5]));

  assert.deepEqual(
    [0, 2, 4, 6].map((offset) => pcm.readInt16LE(offset)),
    [-32767, -16383, 16383, 32767],
  );
});

test("wraps PCM16 samples in a mono WAV container", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wav = pcm16ToWav(pcm, 24_000);

  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("rejects unsupported WAV sample rates", () => {
  assert.throws(
    () => pcm16ToWav(Buffer.from([0, 0]), 1_000_000),
    /between 1 and 192,000 Hz/,
  );
});

test("removes markup and links from speech output", () => {
  assert.equal(
    spokenText("**Resposta** [aqui](https://example.com) `texto`"),
    "Resposta aqui texto",
  );
});
