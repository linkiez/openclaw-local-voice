import assert from "node:assert/strict";
import test from "node:test";

import {
  KokoroWorkerClient,
  parseTtsResponse,
} from "../src/tts-worker-client.js";

test("warms up TTS synthesis with a short Portuguese phrase", async () => {
  const client = new KokoroWorkerClient();
  let requestedText = "";
  client.synthesize = async (text) => {
    requestedText = text;
    return { sampleRate: 24_000, pcm16: Buffer.from([0, 0]) };
  };

  assert.equal(await client.warmUp(), undefined);
  assert.equal(requestedText, "Pronto.");
});

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
