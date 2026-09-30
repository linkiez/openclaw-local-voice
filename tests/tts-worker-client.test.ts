import assert from "node:assert/strict";
import test from "node:test";

import { parseTtsResponse } from "../src/tts-worker-client.js";

test("decodes a valid Kokoro worker response", () => {
  const pcm16 = Buffer.from([1, 2, 3, 4]);
  const response = JSON.stringify({
    sampleRate: 24_000,
    pcm16: pcm16.toString("base64"),
  });

  assert.deepEqual(parseTtsResponse(response), { sampleRate: 24_000, pcm16 });
});

test("rejects malformed or incomplete Kokoro worker responses", () => {
  assert.throws(() => parseTtsResponse("not json"), /valid JSON/);
  assert.throws(() => parseTtsResponse('{"sampleRate":0,"pcm16":""}'), /invalid audio/);
});
