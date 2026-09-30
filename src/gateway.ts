import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import { appConfig } from "./config.js";

/** JSON parameters accepted by an OpenClaw Gateway method. */
export type GatewayParams = Record<string, unknown>;
/** Validated JSON object returned by an OpenClaw Gateway method. */
export type GatewayResponse = Record<string, unknown>;

/** Callback contract for one OpenClaw Gateway method call. */
export type GatewayCall = (
  method: string,
  params: GatewayParams,
) => Promise<GatewayResponse>;

/** Process runner used to execute the OpenClaw CLI without a shell. */
export type GatewayCommandRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runOpenClawCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout) => {
        if (error) {
          reject(new Error("OpenClaw Gateway command failed", { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Creates a shell-free Gateway caller using the installed OpenClaw CLI.
 *
 * @param executable - OpenClaw CLI executable path.
 * @param runCommand - Injectable process runner for deterministic tests.
 * @returns A function that invokes one Gateway method.
 */
export function createGatewayCall(
  executable = appConfig.openClawCommand,
  runCommand: GatewayCommandRunner = runOpenClawCommand,
): GatewayCall {
  return async (method, params) => {
    const output = await runCommand(
      executable,
      [
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--json",
        "--timeout",
        "15000",
      ],
      20_000,
    );

    let response: unknown;
    try {
      response = JSON.parse(output);
    } catch (error) {
      throw new Error(`OpenClaw Gateway ${method} response was not valid JSON`, {
        cause: error,
      });
    }
    if (!isRecord(response)) {
      throw new Error(`OpenClaw Gateway ${method} response was not an object`);
    }
    return response;
  };
}

/**
 * Extracts plain text from a Gateway chat message.
 *
 * @param message - Gateway message record.
 * @returns Concatenated text blocks, or an empty string.
 */
export function extractChatMessageText(message: GatewayResponse): string {
  const content = message.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(isTextBlock)
    .map((part) => part.text.trim())
    .join(" ");
}

function isTextBlock(
  value: unknown,
): value is Record<string, unknown> & { type: "text"; text: string } {
  return (
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  );
}

function messageIdentity(message: GatewayResponse): string {
  return JSON.stringify([
    message.role,
    message.timestamp,
    extractChatMessageText(message),
  ]);
}

function validHistory(
  response: GatewayResponse,
): { messages: GatewayResponse[]; sessionInfo: GatewayResponse } {
  const messages = response.messages;
  const sessionInfo = response.sessionInfo;
  if (
    !Array.isArray(messages) ||
    !messages.every(isRecord) ||
    !isRecord(sessionInfo)
  ) {
    throw new Error("OpenClaw chat history response was incomplete");
  }
  return { messages, sessionInfo };
}

/**
 * Sends a transcribed voice command and waits for its final assistant reply.
 *
 * @param command - User speech recognized locally.
 * @param gatewayCall - Function used to invoke OpenClaw Gateway methods.
 * @param sessionKey - Persistent conversation session key.
 * @param agentId - OpenClaw agent ID.
 * @param wait - Injectable poll delay.
 * @returns The assistant reply text.
 * @throws {Error} If the Gateway request fails or does not finish in time.
 */
export async function askOpenClaw(
  command: string,
  gatewayCall: GatewayCall,
  sessionKey = appConfig.sessionKey,
  agentId = appConfig.agentId,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<string> {
  const prompt =
    "Você é o assistente de voz local do OpenClaw. " +
    "O reconhecimento foi feito localmente. Responda em português brasileiro, " +
    `com concisão. A mensagem transcrita do usuário é:\n${command}`;
  const historyParams = { sessionKey, agentId, limit: 20 };
  const initial = validHistory(
    await gatewayCall("chat.history", historyParams),
  );
  if (initial.sessionInfo.hasActiveRun === true) {
    throw new Error("OpenClaw voice chat already has an active run");
  }
  const previousMessages = new Set(initial.messages.map(messageIdentity));
  const acknowledgement = await gatewayCall("chat.send", {
    sessionKey,
    agentId,
    message: prompt,
    idempotencyKey: randomUUID(),
    timeoutMs: appConfig.chatTimeoutMs,
  });
  const runId = acknowledgement.runId;
  if (typeof runId !== "string" || !runId) {
    throw new Error("OpenClaw chat.send did not return a run ID");
  }

  const deadline = Date.now() + appConfig.chatTimeoutMs;
  while (Date.now() < deadline) {
    const history = validHistory(
      await gatewayCall("chat.history", historyParams),
    );
    const activeRunIds = history.sessionInfo.activeRunIds;
    const runIsActive = Array.isArray(activeRunIds) && activeRunIds.includes(runId);
    if (!runIsActive) {
      const replies = history.messages
        .filter(
          (message) =>
            message.role === "assistant" &&
            !previousMessages.has(messageIdentity(message)),
        )
        .map(extractChatMessageText);
      const answer = replies.reverse().find((reply) => reply.length > 0);
      if (answer) {
        return answer;
      }
    }
    await wait(appConfig.chatPollIntervalMs);
  }

  throw new Error("OpenClaw voice chat did not finish before timeout");
}
