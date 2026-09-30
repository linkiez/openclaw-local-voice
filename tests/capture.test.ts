import assert from "node:assert/strict";
import test from "node:test";

import { captureUtterance, FRAME_BYTES } from "../src/capture.js";

class FrameSource {
  constructor(private readonly frames: Buffer[]) {}

  async readFrame(): Promise<Buffer | null> {
    return this.frames.shift() ?? null;
  }
}

function frame(sample: number): Buffer {
  const buffer = Buffer.alloc(FRAME_BYTES);
  for (let offset = 0; offset < buffer.length; offset += 2) {
    buffer.writeInt16LE(sample, offset);
  }
  return buffer;
}

test("captures voiced frames with pre-roll and stops after silence", async () => {
  const source = new FrameSource([
    ...Array.from({ length: 5 }, () => frame(0)),
    ...Array.from({ length: 4 }, () => frame(500)),
    ...Array.from({ length: 7 }, () => frame(0)),
  ]);

  const audio = await captureUtterance(source, 1_000);

  assert.ok(audio);
  assert.equal(audio.length, 14 * FRAME_BYTES);
});

test("returns null when the capture window contains no speech", async () => {
  const source = new FrameSource([frame(0), frame(0)]);

  assert.equal(await captureUtterance(source, 1_000), null);
});

test("rejects a malformed short PCM frame", async () => {
  const source = new FrameSource([Buffer.alloc(FRAME_BYTES - 1)]);

  await assert.rejects(
    captureUtterance(source, 1_000),
    /invalid audio frame/,
  );
});
