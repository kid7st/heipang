import { createHash } from "node:crypto";
import { getModelEnum } from "../models/models.js";

/** Deterministic RFC 4122 v5 UUID from a seed (survives restarts for the same seed). */
export function stableUuid(seed: string): string {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Signed int64 session id: deterministic for nonempty seeds, random otherwise. */
export function toInt64SessionId(seed?: string): string {
  if (seed?.trim()) {
    const s = seed.trim();
    if (/^-?\d+$/.test(s)) {
      const value = BigInt(s);
      if (value >= -(1n << 63n) && value <= (1n << 63n) - 1n) return s;
    }
    const hash = createHash("sha256").update(`antigravity:session:${s}`).digest();
    return String(new DataView(hash.buffer, hash.byteOffset, 8).getBigInt64(0, true));
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return String(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true));
}

export type AntigravityEnvelopeOptions = {
  isClaude?: boolean;
  isNonGemini?: boolean;
  step?: number;
  lastStepIndex?: string;
  requestIndex?: number;
  trajectoryId?: string;
  conversationId?: string;
  sessionId?: string;
  lastExecutionId?: string;
};

export function agentRequestEnvelope(
  wireModelId: string,
  options: AntigravityEnvelopeOptions = {},
): { requestId: string; sessionId: string; labels: Record<string, string> } {
  const isClaude = Boolean(options.isClaude);
  const isNonGemini = Boolean(options.isNonGemini || isClaude);
  const step = Math.max(1, options.step ?? 1);
  const lastStepIndex = options.lastStepIndex ?? String(Math.max(0, step - 1));
  const requestIndex = options.requestIndex ?? Math.max(0, step - 1);
  const agentId = options.conversationId || crypto.randomUUID();
  const trajectoryId = options.trajectoryId || crypto.randomUUID();
  const sessionId = options.sessionId || toInt64SessionId();

  const claudeLabel = isClaude ? "true" : "false";
  const nonGeminiLabel = isNonGemini ? "true" : "false";

  const labels: Record<string, string> = {
    cascade_id: agentId,
    root_cascade_id: agentId,
    last_step_index: lastStepIndex,
    request_id: `${trajectoryId}-${requestIndex}`,
    trajectory_id: trajectoryId,
    used_claude: claudeLabel,
    used_claude_conservative: claudeLabel,
    used_non_gemini_model: nonGeminiLabel,
  };

  const modelEnum = getModelEnum(wireModelId);
  if (modelEnum) {
    labels.model_enum = modelEnum;
  }

  if (options.lastExecutionId) labels.last_execution_id = options.lastExecutionId;

  // agy marshals labels from a Go map, which sorts its keys.
  const sortedLabels = Object.fromEntries(
    Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  return {
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    sessionId,
    labels: sortedLabels,
  };
}

/** Image generation uses its own request id shape in agy. */
export function imageGenRequestId(uuid: string = crypto.randomUUID()): string {
  return `image_gen/${Date.now()}/${uuid}/1`;
}

/** A stamped agent request id, for smoke scripts that only need a valid one. */
export function nowRequestId(): string {
  return agentRequestEnvelope("unknown").requestId;
}
