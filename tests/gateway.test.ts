import assert from "node:assert/strict";
import test from "node:test";

import {
  createGatewayCall,
  extractChatMessageText,
  type GatewayCall,
  askOpenClaw,
} from "../src/gateway.js";

test("calls the OpenClaw CLI without a shell and parses the JSON response", async () => {
  let invocation: { executable: string; args: string[]; timeoutMs: number } | undefined;
  const call = createGatewayCall(
    "/opt/openclaw",
    async (executable, args, timeoutMs) => {
      invocation = { executable, args, timeoutMs };
      return '{"messages":[]}';
    },
  );

  assert.deepEqual(await call("chat.history", { sessionKey: "voice-session" }), {
    messages: [],
  });
  assert.equal(invocation?.executable, "/opt/openclaw");
  assert.deepEqual(invocation?.args.slice(0, 3), [
    "gateway",
    "call",
    "chat.history",
  ]);
  assert.deepEqual(
    JSON.parse(invocation?.args[invocation.args.indexOf("--params") + 1] ?? ""),
    { sessionKey: "voice-session" },
  );
  assert.equal(invocation?.timeoutMs, 20_000);
});

test("sends a voice turn into the persistent session and returns its final reply", async () => {
  const callOrder: Array<{ method: string; params: Record<string, unknown> }> = [];
  const replies: unknown[] = [
    {
      messages: [],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    },
    { runId: "run-1", status: "started" },
    {
      messages: [],
      sessionInfo: { hasActiveRun: true, activeRunIds: ["run-1"] },
    },
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Resposta da conversa." }],
          timestamp: 2,
        },
      ],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    },
  ];
  const waitIntervals: number[] = [];
  const gatewayCall: GatewayCall = async (method, params) => {
    callOrder.push({ method, params });
    return replies.shift() as Record<string, unknown>;
  };

  const response = await askOpenClaw(
    "Que horas são?",
    gatewayCall,
    "agent:voice:explicit:openclaw-local-voice",
    "voice",
    async (milliseconds) => {
      waitIntervals.push(milliseconds);
    },
  );

  assert.equal(response, "Resposta da conversa.");
  assert.deepEqual(waitIntervals, [100]);
  assert.equal(callOrder[1]?.method, "chat.send");
  assert.equal(callOrder[1]?.params.agentId, "voice");
  assert.equal(
    callOrder[1]?.params.sessionKey,
    "agent:voice:explicit:openclaw-local-voice",
  );
  assert.match(String(callOrder[1]?.params.message), /Que horas são\?/);
});

test("extracts text from string and structured Gateway message content", () => {
  assert.equal(extractChatMessageText({ content: "Resposta" }), "Resposta");
  assert.equal(
    extractChatMessageText({
      content: [
        { type: "text", text: "Resposta " },
        { type: "image", data: "ignored" },
        { type: "text", text: "final" },
      ],
    }),
    "Resposta final",
  );
});
