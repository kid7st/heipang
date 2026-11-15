import type { ThinkingWire } from "../types/types.js";

/**
 * What the wire format requires because of the model family behind a runtime id.
 *
 * Gemini requires thought signatures and uses model-role tool results. Claude and
 * GPT-OSS use user-role results and a restricted schema bridge.
 */
export type ModelFamily = "gemini" | "claude" | "gpt-oss";

export type FamilyProfile = {
  family: ModelFamily;
  isClaude: boolean;
  /** Any non-Gemini family: the backend labels and the custom-tool bridge both care. */
  isNonGemini: boolean;
  requiresThoughtSignature: boolean;
};

function familyOf(id: string): ModelFamily | undefined {
  if (id.startsWith("claude-")) return "claude";
  if (id.startsWith("gpt-oss-")) return "gpt-oss";
  if (id.startsWith("gemini-")) return "gemini";
  return undefined;
}

function geminiMajor(runtimeModel: string): number | undefined {
  const match = runtimeModel.match(/^gemini-(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * Classify from both the public model id and the runtime id: a pinned
 * ANTIGRAVITY_RUNTIME_MODEL can route a Gemini-looking model to another family.
 */
export function familyProfile(modelId: string, runtimeModel: string): FamilyProfile {
  const known = familyOf(runtimeModel) ?? familyOf(modelId);
  const family = known ?? "gemini";
  const isClaude = family === "claude";
  const isNonGemini = known !== "gemini";
  const major = geminiMajor(runtimeModel);
  return {
    family,
    isClaude,
    isNonGemini,
    requiresThoughtSignature: known === "gemini" && (major === undefined || major >= 3),
  };
}

/**
 * Thinking configuration the backend accepts for a runtime model at one effort level.
 *
 * agy sends `thinkingLevel` rather than a token budget, except for GPT-OSS: the level names for low,
 * medium, and high, and the bare number 100 for xhigh, whose level its wire enum
 * does not name. "off" is Pi's own state; agy has no equivalent, so it sends no
 * level at all.
 */
export function thinkingWire(
  runtimeModel: string,
  effort: string | undefined,
): ThinkingWire | undefined {
  const family = familyOf(runtimeModel);
  if (!family) return undefined;
  // The catalog gives gpt-oss-120b-medium a `thinkingBudget` and no level, and agy sends that
  // budget as it is. GPT-OSS has this one variant and is announced to leave on 2026-11-18.
  if (family === "gpt-oss" && effort && effort !== "off") {
    return { includeThoughts: true, thinkingBudget: GPT_OSS_THINKING_BUDGET };
  }
  return thinkingForEffort(effort);
}

const GPT_OSS_THINKING_BUDGET = 8192;

function thinkingForEffort(effort: string | undefined): ThinkingWire | undefined {
  if (!effort || effort === "off") return { includeThoughts: false };
  if (effort === "xhigh" || effort === "max") return { includeThoughts: true, thinkingLevel: 100 };
  if (effort === "high") return { includeThoughts: true, thinkingLevel: "HIGH" };
  if (effort === "medium") return { includeThoughts: true, thinkingLevel: "MEDIUM" };
  return { includeThoughts: true, thinkingLevel: "LOW" };
}
