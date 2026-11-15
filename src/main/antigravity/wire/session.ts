import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { isRecord } from "../utils/util.js";
import { toInt64SessionId } from "./envelope.js";

export type AntigravityRequestState = {
  scope: string;
  conversationId: string;
  trajectoryId: string;
  sessionId: string;
  executionId: string;
  lastExecutionId?: string;
  step: number;
  requestIndex: number;
};

export type AntigravityAssistantMessage = AssistantMessage & {
  antigravity?: AntigravityRequestState;
};

export type RequestHistoryEvent =
  | Context["messages"][number]
  | {
      role: "antigravity_request";
      state: AntigravityRequestState;
    };

const attempts = new Map<string, AntigravityRequestState>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseRequestState(state: unknown): AntigravityRequestState {
  if (
    !isRecord(state) ||
    typeof state.scope !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.scope) ||
    ![state.conversationId, state.trajectoryId, state.executionId].every(
      (id) => typeof id === "string" && UUID.test(id),
    ) ||
    (state.lastExecutionId !== undefined &&
      (typeof state.lastExecutionId !== "string" || !UUID.test(state.lastExecutionId))) ||
    typeof state.sessionId !== "string" ||
    !/^-?\d{1,20}$/.test(state.sessionId) ||
    BigInt(state.sessionId) < -(1n << 63n) ||
    BigInt(state.sessionId) > (1n << 63n) - 1n ||
    typeof state.step !== "number" ||
    !Number.isSafeInteger(state.step) ||
    state.step < 1 ||
    typeof state.requestIndex !== "number" ||
    !Number.isSafeInteger(state.requestIndex) ||
    state.requestIndex < 0
  ) {
    throw new Error("Invalid Antigravity request state in session history.");
  }
  return state as AntigravityRequestState;
}

function stateOf(message: RequestHistoryEvent): AntigravityRequestState | undefined {
  if (message.role === "antigravity_request") return parseRequestState(message.state);
  if (message.role !== "assistant" || message.provider !== "antigravity") return undefined;
  const state = (message as AntigravityAssistantMessage).antigravity;
  return state === undefined ? undefined : parseRequestState(state);
}

function historyIdentity(history: readonly RequestHistoryEvent[], sessionId?: string) {
  const messages = history.filter((message) => message.role !== "system");
  const seed =
    sessionId?.trim() ||
    digest(messages.find((message) => message.role === "user") ?? messages[0] ?? randomUUID());
  return { messages, seed, scope: digest(seed) };
}

function allocateState({
  messages,
  seed,
  scope,
}: ReturnType<typeof historyIdentity>): AntigravityRequestState {
  for (let index = messages.length - 1; index >= 0; index--) {
    const previous = messages[index];
    const checkpoint = stateOf(previous);
    if (checkpoint?.scope !== scope) continue;
    const appended = messages
      .slice(index + 1)
      .filter((message) => message.role !== "antigravity_request");
    const newExecution = appended.some((message) => message.role === "user");
    const completed =
      previous.role === "assistant" &&
      !["error", "aborted", "pending"].includes(previous.stopReason);
    return parseRequestState({
      ...checkpoint,
      executionId: newExecution ? randomUUID() : checkpoint.executionId,
      lastExecutionId: newExecution ? checkpoint.executionId : checkpoint.lastExecutionId,
      step: checkpoint.step + 1 + appended.length,
      requestIndex: checkpoint.requestIndex + Number(completed),
    });
  }

  return {
    scope,
    conversationId: randomUUID(),
    trajectoryId: randomUUID(),
    sessionId: toInt64SessionId(seed),
    executionId: randomUUID(),
    step: Math.max(1, messages.filter((message) => message.role !== "antigravity_request").length),
    requestIndex: 0,
  };
}

// Persisted reservations already record retries; do not consult attempts from abandoned branches.
export function requestStateFromHistory(
  history: readonly RequestHistoryEvent[],
  sessionId: string,
): AntigravityRequestState {
  return allocateState(historyIdentity(history, sessionId));
}

export function nextRequestState(context: Context, sessionId?: string): AntigravityRequestState {
  const identity = historyIdentity(context.messages, sessionId);
  const key = digest({ scope: identity.scope, messages: identity.messages });
  const attempt = attempts.get(key);
  const state = attempt
    ? parseRequestState({ ...attempt, step: attempt.step + 1 })
    : allocateState(identity);
  attempts.delete(key);
  attempts.set(key, { ...state });
  if (attempts.size > 128) attempts.delete(attempts.keys().next().value!);
  return state;
}

export function clearRequestAttempts(): void {
  attempts.clear();
}
