import assert from "node:assert/strict";
import test from "node:test";

import { pcm16ToWav } from "../src/audio.js";
import { validateWav } from "../tools/openclaw-kokoro-remote-tts.js";

test("accepts mono signed PCM16 WAV output", () => {
  assert.doesNotThrow(() =>
    validateWav(pcm16ToWav(Buffer.from([0, 0, 1, 0]), 24_000)),
  );
});

test("rejects invalid audio format and oversized output", () => {
  const invalidChannels = pcm16ToWav(Buffer.from([0, 0]), 24_000);
  invalidChannels.writeUInt16LE(2, 22);

  assert.throws(() => validateWav(invalidChannels), /invalid WAV/);
  assert.throws(
    () => validateWav(Buffer.alloc(50 * 1024 * 1024 + 1)),
    /invalid WAV/,
  );
});
