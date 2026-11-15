import { RELAY_HELP, relayUrl } from "./relay.js";
import { antigravityTransport } from "./transport.js";
import {
  getCurrentAvailableModels,
  getCurrentEndpoint,
  getCurrentMatchedModelDebug,
  setLastAvailableModels,
  setLastEndpoint,
  setLastError,
  setLastMatchedModelDebug,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { safeError } from "../utils/security.js";
import type { AntigravityApiKey, AvailableModelsRaw, DynamicModelInfo } from "../types/types.js";
import { antigravityEnv, asString, isRecord } from "../utils/util.js";
import { stableUuid } from "../wire/envelope.js";
import { registerDiscoveredModelEnums, registerModelEnum } from "../models/models.js";

export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000;
const projectCache = new Map<string, { projectId: string | undefined; expiresAt: number }>();

const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const modelCache = new Map<string, { result: DynamicModelInfo | undefined; expiresAt: number }>();

/** Metadata lookups (project/model discovery) must be fast; a stalled endpoint should
 * fall through to the next candidate instead of hanging the whole request. */
const DISCOVERY_TIMEOUT_MS = 8000;

/** In-flight de-dupe: concurrent requests for the same (token, project, model) share one probe. */
const inFlightModelLookups = new Map<string, Promise<DynamicModelInfo | undefined>>();

/** UUID-shaped stable id from a seed (account email preferred over cwd). */
export function stableProjectId(seed: string): string {
  return stableUuid(`antigravity:${seed}`);
}

/**
 * Fallback project id when discovery fails.
 * Prefer ANTIGRAVITY_PROJECT_ID, then a stable seed (email), never process.cwd().
 */
export function defaultProjectId(seed = "antigravity-default"): string {
  return antigravityEnv("PROJECT_ID")?.trim() || stableProjectId(seed);
}

/** Where requests go: the relay, never Google directly. */
export function antigravityEndpoint(): string {
  return relayUrl();
}

// Catalog visibility is gated on this fingerprint, so it tracks the official agy CLI
// release. Captured from agy 1.5.9 on darwin/arm64: the version and the changelist
// both matter, and dropping `cl` hides gemini-pro-orchestrator* from the catalog.
const CLI_VERSION = "1.5.9";

/** Piper changelist of the agy 1.5.9 build; the native CLI reports its build stamp. */
const CLI_CHANGELIST = "1021519450";

/** Go spells the host platform as GOOS, which is not Node's `process.platform` on Windows. */
function runtimeOsType(): string {
  return process.platform === "win32" ? "windows" : process.platform;
}

/** Go spells the host architecture as GOARCH (x64 is amd64). */
function runtimeArch(): string {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "ia32":
      return "386";
    default:
      return process.arch;
  }
}

/** Default User-Agent matching pure Antigravity CLI wire fingerprint. */
export function defaultUserAgent(): string {
  return `antigravity/cli/${CLI_VERSION} (aidev_client; os_type=${runtimeOsType()}; arch=${runtimeArch()}; cl=${CLI_CHANGELIST}; auth_method=consumer)`;
}

// The request-scoped transport removes fetch defaults after these headers are assembled.
// Insertion order is the wire order and follows agy's HTTP/1.1 requests.
export function antigravityHeaders(token: string): Record<string, string> {
  return {
    "User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

export function jsonOrTextError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; status?: string; code?: number };
    };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON
  }
  return text;
}

export function parseApiKey(apiKeyRaw: string | undefined): AntigravityApiKey {
  if (!apiKeyRaw) throw new Error(`No relay credentials are available. ${RELAY_HELP}`);
  try {
    const parsed = JSON.parse(apiKeyRaw) as Partial<AntigravityApiKey>;
    if (!parsed.token || !parsed.projectId) throw new Error("missing token or projectId");
    return {
      token: parsed.token,
      projectId: parsed.projectId,
      ...(parsed.account ? { account: parsed.account } : {}),
    };
  } catch (error) {
    throw new Error(`Invalid Antigravity credentials. ${RELAY_HELP}`, { cause: error });
  }
}

export function extractProjectId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const direct =
    data.antigravityProjectId ??
    data.projectId ??
    data.backendProjectId ??
    data.userDefinedCloudaicompanionProject ??
    data.cloudaicompanionProject ??
    data.project;
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct.id);
    if (nestedId) return nestedId;
  }
  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractProjectId(item);
        if (nested) return nested;
        const itemId = asString(item);
        if (itemId) return itemId;
      }
    }
  }
  return undefined;
}

async function listCloudAICompanionProjects(token: string): Promise<string | undefined> {
  const endpoint = antigravityEndpoint();
  try {
    const res = await antigravityTransport.fetch(
      `${endpoint}/v1internal:listCloudAICompanionProjects`,
      {
        method: "POST",
        headers: antigravityHeaders(token),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      },
    );
    setLastStatus(res.status);
    setLastEndpoint(endpoint);
    if (!res.ok) return undefined;
    return extractProjectId(await res.json());
  } catch (error) {
    setLastError(safeError(error));
    return undefined;
  }
}

function collectModelLabels(value: unknown, out: string[] = []): string[] {
  if (!value || out.length > 50) return out;
  if (typeof value === "string") {
    if (/gemini|claude|gpt-oss/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelLabels(item, out);
    return out;
  }
  if (isRecord(value)) {
    for (const key of ["id", "name", "label", "displayName", "model", "modelId"]) {
      collectModelLabels(value[key], out);
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") collectModelLabels(nested, out);
    }
  }
  return out;
}

function summarizeModelCandidate(value: unknown): string {
  if (!isRecord(value)) return String(value ?? "none");
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|auth|credential|secret|email/i.test(key)) continue;
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = raw;
    else if (Array.isArray(raw)) out[key] = `[array:${String(raw.length)}]`;
    else if (isRecord(raw)) {
      out[key] = `{${Object.keys(raw).slice(0, 12).join(",")}}`;
    }
  }
  return JSON.stringify(out).slice(0, 1200);
}

/** Runtime ids must not be internal placeholder enums, internal chats, or image endpoints. */
export function isUsableRuntimeModelId(id: string): boolean {
  return (
    /^[a-z0-9][a-z0-9_.-]*$/i.test(id) &&
    !/\s/.test(id) &&
    !/^MODEL_/i.test(id) &&
    !/^(chat_|tab_)/i.test(id) &&
    !/image/i.test(id)
  );
}

function dynamicModelFromInfo(modelId: string, info: unknown): DynamicModelInfo {
  if (!isRecord(info)) return { id: modelId };
  setLastMatchedModelDebug(summarizeModelCandidate({ modelId, ...info }));
  const experiments = Array.isArray(info.modelExperiments)
    ? info.modelExperiments.filter((item): item is string => typeof item === "string")
    : undefined;
  const modelEnum = asString(info.model);
  if (modelEnum) {
    registerModelEnum(modelId, modelEnum);
  }
  return {
    id: modelId,
    experiments,
    apiProvider: asString(info.apiProvider),
    modelProvider: asString(info.modelProvider),
    model: modelEnum,
  };
}

/**
 * Resolve a requested runtime model against fetchAvailableModels payload.
 * The real runtime ids are the keys of `data.models`; the nested `model` field is often
 * a MODEL_PLACEHOLDER_* enum that 404s on streamGenerateContent.
 *
 * Uses deterministic key lookup (exact or case-insensitive) and exact display name match.
 * Zero regexes, zero prefix wildcards, zero fuzzy guessing.
 */
function findDynamicModel(value: unknown, requestedId: string): DynamicModelInfo | undefined {
  if (!value) return undefined;

  if (isRecord(value) && isRecord(value.models)) {
    const modelsMap = value.models;
    // 1. Direct exact key lookup
    if (isUsableRuntimeModelId(requestedId) && requestedId in modelsMap) {
      return dynamicModelFromInfo(requestedId, modelsMap[requestedId]);
    }
    // 2. Case-insensitive exact key lookup
    const lowerReq = requestedId.toLowerCase();
    for (const [modelId, info] of Object.entries(modelsMap)) {
      if (modelId.toLowerCase() === lowerReq && isUsableRuntimeModelId(modelId)) {
        return dynamicModelFromInfo(modelId, info);
      }
    }
    // 3. Exact display name lookup (for when a user references an exact model label)
    for (const [modelId, info] of Object.entries(modelsMap)) {
      if (!isUsableRuntimeModelId(modelId)) continue;
      if (isRecord(info)) {
        const label = info.label ?? info.displayName ?? info.name;
        if (typeof label === "string" && label.toLowerCase() === lowerReq) {
          return dynamicModelFromInfo(modelId, info);
        }
      }
    }
    return undefined;
  }

  if (typeof value === "string") {
    return value.toLowerCase() === requestedId.toLowerCase() && isUsableRuntimeModelId(value)
      ? { id: value }
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDynamicModel(item, requestedId);
      if (found) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") {
        const found = findDynamicModel(nested, requestedId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

async function fetchAvailableRuntimeModelUncached(
  token: string,
  projectId: string,
  requestedRuntimeModel: string,
): Promise<DynamicModelInfo | undefined> {
  const endpoint = antigravityEndpoint();
  try {
    const res = await antigravityTransport.fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: antigravityHeaders(token),
      body: JSON.stringify({ project: projectId }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    setLastStatus(res.status);
    setLastEndpoint(endpoint);
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    if (isRecord(data) && isRecord(data.models)) {
      registerDiscoveredModelEnums(data.models as Record<string, { model?: unknown }>);
    }
    const labels = [...new Set(collectModelLabels(data))].slice(0, 16);
    if (labels.length) setLastAvailableModels(labels.join(","));
    return findDynamicModel(data, requestedRuntimeModel);
  } catch (error) {
    setLastError(safeError(error));
    return undefined;
  }
}

export async function fetchAvailableRuntimeModel(
  token: string,
  projectId: string,
  requestedRuntimeModel: string,
): Promise<DynamicModelInfo | undefined> {
  const cacheKey = `${token}::${projectId}::${requestedRuntimeModel}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  // De-dupe concurrent lookups for the same key (e.g. parallel requests right after
  // startup) so they share one probe instead of each firing their own round-trips.
  const inFlight = inFlightModelLookups.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = fetchAvailableRuntimeModelUncached(token, projectId, requestedRuntimeModel).then(
    (result) => {
      modelCache.set(cacheKey, { result, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
      return result;
    },
  );
  inFlightModelLookups.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightModelLookups.delete(cacheKey);
    // Evict expired entries; bound map size to avoid unbounded growth.
    if (modelCache.size > 64) {
      const now = Date.now();
      for (const [key, entry] of modelCache) {
        if (entry.expiresAt <= now) modelCache.delete(key);
      }
    }
  }
}

function catalogSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchAvailableModelsCatalog(
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ endpoint: string; status: number; data: AvailableModelsRaw }> {
  const endpoint = antigravityEndpoint();
  const res = await antigravityTransport.fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: antigravityHeaders(token),
    body: JSON.stringify({ project: projectId }),
    signal: catalogSignal(signal),
  });
  setLastEndpoint(endpoint);
  setLastStatus(res.status);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const message =
      isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string"
        ? parsed.error.message
        : text;
    setLastError(message);
    throw new Error(`/v1internal:fetchAvailableModels failed (${res.status}): ${message}`);
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.models) ||
    Object.keys(parsed.models).length === 0 ||
    !Object.values(parsed.models).every(isRecord)
  ) {
    throw new Error("/v1internal:fetchAvailableModels returned an unrecognized catalog");
  }
  registerDiscoveredModelEnums(parsed.models as Record<string, { model?: unknown }>);
  return {
    endpoint,
    status: res.status,
    data: {
      models: parsed.models as AvailableModelsRaw["models"],
      defaultAgentModelId:
        typeof parsed.defaultAgentModelId === "string" ? parsed.defaultAgentModelId : undefined,
      defaultAgentModel:
        typeof parsed.defaultAgentModel === "string" ? parsed.defaultAgentModel : undefined,
      agentModelSorts: Array.isArray(parsed.agentModelSorts)
        ? (parsed.agentModelSorts as AvailableModelsRaw["agentModelSorts"])
        : undefined,
    },
  };
}

/** The body agy sends to loadCodeAssist; extra metadata fields would make this request distinguishable. */
export const LOAD_CODE_ASSIST_BODY = JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } });

/**
 * The loadCodeAssist RPC: project id, tier, and quota metadata in one response. Callers
 * that need the raw body (usage) and callers that only need the project id share it, so
 * the request shape cannot drift between them.
 */
export async function loadCodeAssistResponse(
  token: string,
): Promise<{ endpoint: string; status: number; data: unknown } | undefined> {
  const endpoint = antigravityEndpoint();
  try {
    const res = await antigravityTransport.fetch(`${endpoint}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: antigravityHeaders(token),
      body: LOAD_CODE_ASSIST_BODY,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    setLastStatus(res.status);
    setLastEndpoint(endpoint);
    if (!res.ok) return undefined;
    return { endpoint, status: res.status, data: await res.json() };
  } catch (error) {
    setLastError(safeError(error));
    return undefined;
  }
}

async function loadProjectIdUncached(token: string): Promise<string | undefined> {
  const response = await loadCodeAssistResponse(token);
  if (!response) return undefined;
  const project = extractProjectId(response.data);
  if (project) return project;
  return await listCloudAICompanionProjects(token);
}

/** Discover project id with a short in-memory LRU cache keyed by access token. */
export async function loadCodeAssist(token: string): Promise<string | undefined> {
  const cached = projectCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    // Refresh LRU order: delete and re-insert so newest is at the end.
    projectCache.delete(token);
    projectCache.set(token, cached);
    return cached.projectId;
  }

  const projectId = await loadProjectIdUncached(token);
  projectCache.set(token, { projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });

  // Evict oldest entry when the cache exceeds 32 entries (O(1) — Map preserves insertion order).
  if (projectCache.size > 32) {
    const oldestKey = projectCache.keys().next().value;
    if (oldestKey !== undefined) projectCache.delete(oldestKey);
  }
  return projectId;
}

export function resolveProjectId(opts: {
  token: string;
  credentialProjectId?: string;
  warmedProject?: string | null;
}): string {
  return (
    antigravityEnv("PROJECT_ID")?.trim() ||
    opts.warmedProject ||
    opts.credentialProjectId ||
    defaultProjectId()
  );
}

/** Build a diagnostic suffix using the active request bag. */
export function formatRequestDiagnostics(extra: {
  projectId: string;
  runtimeModel: string;
}): string {
  return `endpoint=${getCurrentEndpoint() || "unknown"}, project=${extra.projectId}, runtimeModel=${extra.runtimeModel}, matched=${getCurrentMatchedModelDebug() || "none"}, available=${getCurrentAvailableModels() || "unknown"}`;
}
