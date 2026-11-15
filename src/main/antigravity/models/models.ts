import type { AntigravityRouting, ChatModelConfig } from "../types/types.js";
import { ThinkingEffort } from "../types/enums.js";
import type { AntigravityCatalog } from "./grouping.js";

export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";

/** One row of the static catalog: Pi's model config plus the routing that model needs. */
export type KnownModel = ChatModelConfig & { routing: AntigravityRouting };

/**
 * Static catalog: everything this extension knows about the models `agy models`
 * currently advertises, collapsed to public Pi model IDs.
 *
 * This is the conservative fallback and the routing reference; a successful
 * discovery replaces the selectable list with what the account actually gets.
 * `catalog` holds what the account advertised last; `staticCatalog` is the seed.
 *
 * One row per public model. Per-effort runtime ids, output ceiling, cost, and
 * capability all live in that row so a new model is one entry, not four tables.
 */
const geminiFlashCost = { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 };
const geminiProCost = { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 };
const claudeSonnetCost = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
const claudeOpusCost = { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 };
const gptOssCost = { input: 0.6, output: 2.4, cacheRead: 0.15, cacheWrite: 0.6 };

// A null entry is intentionally hidden by Pi. Do not collapse levels that happen to
// route to the same runtime ID: the UI must reflect the levels the backend advertises.
const thinkingLevelMaps = {
  lowMediumHigh: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  },
  lowHigh: {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  },
  thinking: {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  },
  medium: {
    off: null,
    minimal: null,
    low: null,
    medium: "medium",
    high: null,
    xhigh: null,
    max: null,
  },
} satisfies Record<string, ChatModelConfig["thinkingLevelMap"]>;

export const ANTIGRAVITY_MODELS: KnownModel[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
    routing: {
      off: "gemini-3.8-flash-low",
      routing: {
        minimal: "gemini-3.8-flash-low",
        low: "gemini-3.8-flash-low",
        medium: "gemini-3.8-flash-medium",
        high: "gemini-3.8-flash-high",
        xhigh: "gemini-3.8-flash-high",
      },
      defaultRequestId: "gemini-3.8-flash-low",
    },
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
    routing: {
      off: "gemini-3.7-flash-low",
      routing: {
        minimal: "gemini-3.7-flash-low",
        low: "gemini-3.7-flash-low",
        medium: "gemini-3.7-flash-medium",
        high: "gemini-3.7-flash-high",
        xhigh: "gemini-3.7-flash-high",
      },
      defaultRequestId: "gemini-3.7-flash-low",
    },
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
    routing: {
      off: "gemini-3.6-flash-low",
      routing: {
        minimal: "gemini-3.6-flash-low",
        low: "gemini-3.6-flash-low",
        medium: "gemini-3.6-flash-medium",
        high: "gemini-3.6-flash-high",
        xhigh: "gemini-3.6-flash-high",
      },
      defaultRequestId: "gemini-3.6-flash-low",
    },
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.thinking,
    input: ["text", "image"],
    cost: claudeOpusCost,
    contextWindow: 250000,
    maxTokens: 64000,
    routing: {
      routing: {
        minimal: "claude-opus-4-6-thinking",
        low: "claude-opus-4-6-thinking",
        medium: "claude-opus-4-6-thinking",
        high: "claude-opus-4-6-thinking",
      },
      defaultRequestId: "claude-opus-4-6-thinking",
    },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.thinking,
    input: ["text", "image"],
    cost: claudeSonnetCost,
    contextWindow: 200000,
    maxTokens: 64000,
    routing: {
      off: "claude-sonnet-4-6",
      routing: {
        minimal: "claude-sonnet-4-6",
        low: "claude-sonnet-4-6",
        medium: "claude-sonnet-4-6",
        high: "claude-sonnet-4-6",
        xhigh: "claude-sonnet-4-6",
      },
      defaultRequestId: "claude-sonnet-4-6",
    },
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowHigh,
    input: ["text", "image"],
    cost: geminiProCost,
    contextWindow: 1048576,
    maxTokens: 65535,
    routing: {
      off: "gemini-3.1-pro-low",
      routing: {
        minimal: "gemini-3.1-pro-low",
        low: "gemini-3.1-pro-low",
        medium: "gemini-3.1-pro-low",
        high: "gemini-pro-agent",
        xhigh: "gemini-pro-agent",
      },
      defaultRequestId: "gemini-3.1-pro-low",
    },
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
    routing: {
      off: "gemini-3.5-flash-extra-low",
      routing: {
        minimal: "gemini-3.5-flash-extra-low",
        low: "gemini-3.5-flash-extra-low",
        medium: "gemini-3.5-flash-low",
        high: "gemini-3-flash-agent",
        xhigh: "gemini-3-flash-agent",
      },
      defaultRequestId: "gemini-3.5-flash-extra-low",
    },
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.medium,
    input: ["text"],
    cost: gptOssCost,
    contextWindow: 131072,
    maxTokens: 32768,
    routing: {
      off: "gpt-oss-120b-medium",
      routing: {
        minimal: "gpt-oss-120b-medium",
        low: "gpt-oss-120b-medium",
        medium: "gpt-oss-120b-medium",
        high: "gpt-oss-120b-medium",
      },
      defaultRequestId: "gpt-oss-120b-medium",
    },
  },
];

/** The seed routing table, derived so the two cannot drift. */
export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = Object.fromEntries(
  ANTIGRAVITY_MODELS.map((model) => [model.id, model.routing]),
);

/** Runtime ids a known model can be routed to. */
function runtimeIdsOf(model: KnownModel): string[] {
  const { off, routing, defaultRequestId } = model.routing;
  return [off, defaultRequestId, ...Object.values(routing ?? {})].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

function knownModelFor(id: string): KnownModel | undefined {
  return ANTIGRAVITY_MODELS.find((model) => model.id === id || runtimeIdsOf(model).includes(id));
}

/** Ceiling for a runtime id this extension has never seen, e.g. a newly advertised family. */
function fallbackMaxOutputTokens(id: string): number {
  if (id.startsWith("claude-")) return 64000;
  if (id.startsWith("gpt-oss-")) return 32768;
  if (id.startsWith("gemini-3.1-pro") || id === "gemini-pro-agent") return 65535;
  if (id.startsWith("gemini-")) return 65536;
  return 8192;
}

export function getMaxOutputTokens(modelId: string, runtimeModel?: string): number {
  // A refreshed (or restored) catalog is authoritative for the models it advertises.
  const advertised = catalog.find((model) => model.id === modelId);
  if (hasDiscoveredCatalog && advertised) return advertised.maxTokens;
  const known = knownModelFor(modelId) ?? (runtimeModel ? knownModelFor(runtimeModel) : undefined);
  if (known) return known.maxTokens;
  return fallbackMaxOutputTokens(runtimeModel ?? modelId);
}

let catalog: KnownModel[] | ChatModelConfig[] = ANTIGRAVITY_MODELS;
let currentRouting: Record<string, AntigravityRouting> = { ...ANTIGRAVITY_ROUTING };
let hasDiscoveredCatalog = false;

export function getCurrentAntigravityRouting(): Record<string, AntigravityRouting> {
  return currentRouting;
}

export function getCurrentAntigravityCatalog(): AntigravityCatalog {
  return { models: catalog, routing: currentRouting };
}

export function applyAntigravityCatalog(next: AntigravityCatalog): void {
  catalog = next.models;
  currentRouting = next.routing;
  hasDiscoveredCatalog = true;
}

export function resetAntigravityCatalogForTests(): void {
  catalog = ANTIGRAVITY_MODELS;
  currentRouting = { ...ANTIGRAVITY_ROUTING };
  hasDiscoveredCatalog = false;
}

export function getAntigravityRequestModelId(modelId: string, effort: string | undefined): string {
  const r = currentRouting[modelId] ?? ANTIGRAVITY_ROUTING[modelId];
  if (!r) return modelId;

  if (effort === undefined || effort === "off") {
    return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? modelId;
  }

  const effortKey = effort as ThinkingEffort;
  if (effortKey === ThinkingEffort.Xhigh) {
    return (
      r.routing?.xhigh ??
      r.routing?.high ??
      r.routing?.low ??
      r.routing?.minimal ??
      r.off ??
      r.defaultRequestId ??
      modelId
    );
  }

  return (
    r.routing?.[effortKey] ??
    r.routing?.low ??
    r.routing?.minimal ??
    r.off ??
    r.defaultRequestId ??
    modelId
  );
}

/**
 * If a next-gen model (e.g. Gemini 3.8 Flash) is not yet available on the backend,
 * provide a fallback runtime model ID (e.g. Gemini 3.7 Flash) to maintain availability.
 */
export function getFallbackRuntimeModel(runtimeModel: string, effort?: string): string | undefined {
  if (runtimeModel.startsWith("gemini-3.8-flash-")) {
    return runtimeModel.replace("gemini-3.8-flash-", "gemini-3.7-flash-");
  }
  if (runtimeModel === "gemini-3.8-flash") {
    return "gemini-3.7-flash-low";
  }
  if (runtimeModel === "gemini-3.7-flash-tiered") {
    return getAntigravityRequestModelId("gemini-3.6-flash", effort);
  }
  if (runtimeModel.startsWith("gemini-3.7-flash-")) {
    return runtimeModel.replace("gemini-3.7-flash-", "gemini-3.6-flash-");
  }
  if (runtimeModel === "gemini-3.7-flash") {
    return "gemini-3.6-flash-low";
  }
  return undefined;
}

export const ANTIGRAVITY_MODEL_ENUM: Record<string, string> = {
  // Gemini 3.8 Flash
  "gemini-3.8-flash": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
  "gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
  // Gemini 3.7 Flash
  "gemini-3.7-flash": "MODEL_PLACEHOLDER_M298",
  "gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
  "gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
  "gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
  // Gemini 3.6 Flash
  "gemini-3.6-flash": "MODEL_PLACEHOLDER_M71",
  "gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
  "gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
  "gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
  // Gemini 3.5 Flash
  "gemini-3.5-flash": "MODEL_PLACEHOLDER_M20",
  "gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
  "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
  "gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
  // Gemini 3.1 Pro
  "gemini-3.1-pro": "MODEL_PLACEHOLDER_M36",
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-3.1-pro-high": "MODEL_PLACEHOLDER_M37",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
  // Claude
  "claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
  "claude-opus-4-6": "MODEL_PLACEHOLDER_M26",
  "claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
  // GPT-OSS
  "gpt-oss-120b": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

const modelEnumCache = new Map<string, string>();

/** Register dynamically discovered model enum (e.g. from fetchAvailableModels). */
export function registerModelEnum(wireModelId: string, modelEnum: string): void {
  if (wireModelId && modelEnum) {
    modelEnumCache.set(wireModelId, modelEnum);
  }
}

/** Register batch of discovered model enums from fetchAvailableModels raw models dictionary. */
export function registerDiscoveredModelEnums(
  models: Record<string, { model?: unknown }> | undefined,
): void {
  if (!models) return;
  for (const [wireId, info] of Object.entries(models)) {
    if (typeof info?.model === "string" && info.model) {
      modelEnumCache.set(wireId, info.model);
    }
  }
}

/** Get model_enum label for a given wire model id (dynamic cache first, then static fallback). */
export function getModelEnum(wireModelId: string): string | undefined {
  const direct = modelEnumCache.get(wireModelId) || ANTIGRAVITY_MODEL_ENUM[wireModelId];
  if (direct) return direct;

  // Runtime overrides may name a public/base model while discovery only returned
  // an enum for its selected runtime variant (for example `-low`).
  const routed = getAntigravityRequestModelId(wireModelId, undefined);
  return modelEnumCache.get(routed) || ANTIGRAVITY_MODEL_ENUM[routed];
}

/** Return a serializable snapshot of model enums learned from discovery. */
export function snapshotDynamicModelEnums(): Record<string, string> {
  return Object.fromEntries(modelEnumCache);
}

/** Replace dynamically learned model enums with a previously persisted snapshot. */
export function restoreDynamicModelEnums(modelEnums: Record<string, string>): void {
  modelEnumCache.clear();
  for (const [wireModelId, modelEnum] of Object.entries(modelEnums)) {
    if (wireModelId && modelEnum) modelEnumCache.set(wireModelId, modelEnum);
  }
}

export function clearModelEnumCache(): void {
  modelEnumCache.clear();
}
