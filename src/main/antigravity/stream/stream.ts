import { antigravityTransport } from "../client/transport.js";
import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type TextContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
// Namespace import: transcript helpers exist on pi-ai >= 0.86; resolved at runtime.
import * as piAi from "@earendil-works/pi-ai";
import {
  antigravityEndpoint,
  antigravityHeaders,
  fetchAvailableRuntimeModel,
  formatRequestDiagnostics,
  isUsableRuntimeModelId,
  loadCodeAssist,
  parseApiKey,
  resolveProjectId,
} from "../client/client.js";
import { renameHarness } from "../wire/system-prompt.js";
import { registerTrajectory } from "../client/trajectory.js";
import {
  getCurrentAvailableModels,
  getCurrentEndpoint,
  getCurrentMatchedModelDebug,
  runWithDiagnostics,
  setLastAvailableModels,
  setLastEndpoint,
  setLastError,
  setLastLatencyMs,
  setLastMatchedModelDebug,
  setLastProjectId,
  setLastResolvedRuntimeModel,
  setLastStatus,
  setLastToolSchemaWarnings,
} from "../diagnostics/diagnostics.js";
import {
  AntigravityRequestType,
  AntigravityUserAgent,
  GeminiRole,
  GeminiToolCallingMode,
  StopReason,
  ToolChoice,
} from "../types/enums.js";
import {
  getCurrentAntigravityRouting,
  getMaxOutputTokens,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  PROVIDER_ID,
} from "../models/models.js";
import { safeError } from "../utils/security.js";
import { classifyAntigravityFailure, renderAntigravityFailure } from "../wire/failure.js";
import {
  ANTIGRAVITY_API,
  type ActiveBlock,
  type AntigravityGenerateRequest,
  type AntigravityStreamOptions,
  type ContentBlock,
  type GeminiContent,
  type GeminiFunctionDeclaration,
  type GeminiFunctionResponsePart,
  type GeminiGenerationConfig,
  type GeminiInlineDataPart,
  type GeminiPart,
  type GeminiRequestBody,
  type GeminiTextPart,
  type StreamChunk,
} from "../types/types.js";
import { antigravityEnv, isRecord, sanitizeText } from "../utils/util.js";
import {
  agentRequestEnvelope,
  familyProfile,
  toInt64SessionId,
  thinkingWire,
  type AntigravityEnvelopeOptions,
} from "../wire/index.js";
import { nextRequestState, type AntigravityAssistantMessage } from "../wire/session.js";

export { ANTIGRAVITY_API };

const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.';

const CONTINUATION_TEXT = "Continue the active task using the available instructions and context.";
let toolCallCounter = 0;

function sanitizeToolCallId(id: string, fallbackName?: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${++toolCallCounter}`;
}

type TranscriptHelpers = {
  getCurrentSystemPrompt?: (messages: Context["messages"]) => string;
  getCurrentTools?: (messages: Context["messages"]) => Tool[];
};

const transcriptHelpers = piAi as unknown as TranscriptHelpers;

/**
 * pi >= 0.86 hands providers a normalized transcript: the system prompt and tool
 * declarations live in system messages and are read with `getCurrentSystemPrompt()` /
 * `getCurrentTools()`. Older releases pass the flat Context fields instead, so both are
 * consulted and Pi owns the transcript replay.
 */
function resolveCurrentSystemPrompt(context: Context): string | undefined {
  const fromTranscript = transcriptHelpers.getCurrentSystemPrompt?.(context.messages ?? []);
  return fromTranscript?.trim() ? fromTranscript : context.systemPrompt;
}

function resolveCurrentTools(context: Context): Tool[] | undefined {
  const fromTranscript = transcriptHelpers.getCurrentTools?.(context.messages ?? []);
  return fromTranscript?.length ? fromTranscript : context.tools;
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(signature?: string): boolean {
  if (!signature || typeof signature !== "string" || signature.length === 0) return false;
  if (signature.length % 4 !== 0) return false;
  return base64SignaturePattern.test(signature);
}

function parseImageData(raw: string, explicitMime?: string): { data: string; mimeType: string } {
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    return {
      mimeType: explicitMime || match[1] || "image/png",
      data: match[2].trim(),
    };
  }
  return {
    mimeType: explicitMime || "image/png",
    data: raw.trim(),
  };
}

const SKILL_BLOCK_PATTERN = /<skill\b[^>]*>[\s\S]*?<\/skill\s*>/gi;

function skillBlocks(content: unknown): string[] {
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((item) =>
            isRecord(item) && item.type === "text" && typeof item.text === "string"
              ? [item.text]
              : [],
          )
        : [];
  return texts.flatMap((text) => text.match(SKILL_BLOCK_PATTERN) || []);
}

function withoutSkillBlocks(text: string): string {
  return text.replace(SKILL_BLOCK_PATTERN, "");
}

function imagePartOf(block: ContentBlock): GeminiInlineDataPart[] {
  if (block.type !== "image") return [];
  const rawData = block.data || block.source?.data;
  if (!rawData) return [];
  const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
  const { data, mimeType } = parseImageData(rawData, explicitMime);
  return data ? [{ inlineData: { mimeType, data } }] : [];
}

function asTextParts(content: unknown): Array<GeminiTextPart | GeminiInlineDataPart> {
  const textPart = (text: string): GeminiTextPart[] => {
    const userText = withoutSkillBlocks(text);
    return userText.trim() ? [{ text: sanitizeText(userText) }] : [];
  };
  if (typeof content === "string") return textPart(content);
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Array<GeminiTextPart | GeminiInlineDataPart> => {
    if (!isRecord(item)) return [];
    const block = item as ContentBlock;
    return block.type === "text" ? textPart(block.text) : imagePartOf(block);
  });
}

function asImageParts(content: unknown): GeminiInlineDataPart[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => (isRecord(item) ? imagePartOf(item as ContentBlock) : []));
}

function appendTurn(contents: GeminiContent[], role: GeminiRole, parts: GeminiPart[]): void {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (
    last &&
    last.role === role &&
    last.parts.some((part) => "functionResponse" in part) ===
      parts.some((part) => "functionResponse" in part)
  ) {
    last.parts.push(...parts);
  } else {
    contents.push({ role, parts });
  }
}

/** Exported for unit tests. */
export function convertMessages(
  model: Model<Api>,
  context: Context,
  runtimeModel: string,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const profile = familyProfile(model.id, runtimeModel);
  const requiresSig = profile.requiresThoughtSignature;
  const droppedToolCallIds = new Map<string, string>();
  for (const msg of context.messages) {
    if ((msg.role as string) === "system") continue;
    if (msg.role === "user") {
      const parts = asTextParts(msg.content);
      appendTurn(contents, GeminiRole.User, parts);
    } else if (msg.role === "assistant") {
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const parts: GeminiPart[] = [];
      const isSameModel = msg.provider === PROVIDER_ID && msg.model === model.id;
      const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
      const firstCallHasSig =
        toolCalls.length > 0 && isValidThoughtSignature(toolCalls[0]?.thoughtSignature);
      const allSigsValid = toolCalls.every(
        (tc) => !tc.thoughtSignature || isValidThoughtSignature(tc.thoughtSignature),
      );
      const groupIsSigned = isSameModel && firstCallHasSig && allSigsValid;

      for (const block of msg.content) {
        if (block.type === "text") {
          const textSig =
            isSameModel && isValidThoughtSignature(block.textSignature)
              ? block.textSignature
              : undefined;
          if ((!block.text || block.text.trim() === "") && !textSig) {
            continue;
          }
          parts.push({
            text: sanitizeText(block.text),
            ...(textSig ? { thoughtSignature: textSig } : {}),
          });
        } else if (block.type === "thinking" && String(block.thinking || "").trim()) {
          if (!isSameModel) continue;
          parts.push({
            thought: true,
            text: sanitizeText(block.thinking),
            ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
          });
        } else if (block.type === "toolCall") {
          if (requiresSig && !groupIsSigned) {
            const rawId = block.id || "";
            const argsText = (() => {
              try {
                return JSON.stringify(block.arguments ?? {});
              } catch {
                return "{}";
              }
            })();
            if (rawId) {
              droppedToolCallIds.set(rawId, argsText);
              droppedToolCallIds.set(sanitizeToolCallId(rawId, block.name), argsText);
            } else {
              droppedToolCallIds.set(`empty:${block.name}`, argsText);
            }
          } else {
            parts.push({
              functionCall: {
                id: sanitizeToolCallId(block.id || "", block.name),
                name: block.name,
                args: sortKeysDeep(block.arguments ?? {}) as Record<string, unknown>,
              },
              ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
            });
          }
        }
      }
      appendTurn(contents, GeminiRole.Model, parts);
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => sanitizeText(c.text))
        .join("\n");
      const responseText = text || (msg.isError ? "Tool failed" : "");
      const imageParts = asImageParts(msg.content);
      const rawId = msg.toolCallId || "";
      const sanitizedId = sanitizeToolCallId(rawId, msg.toolName);
      const droppedArgs = requiresSig
        ? (droppedToolCallIds.get(rawId) ??
          droppedToolCallIds.get(sanitizedId) ??
          (rawId === "" ? droppedToolCallIds.get(`empty:${msg.toolName}`) : undefined))
        : undefined;
      if (droppedArgs !== undefined) {
        const label =
          droppedArgs === "{}" ? `\`${msg.toolName}\`` : `\`${msg.toolName}\` (${droppedArgs})`;
        appendTurn(contents, GeminiRole.User, [
          { text: sanitizeText(`[Observation from ${label}:\n${responseText}]`) },
          ...imageParts,
        ]);
      } else {
        const part: GeminiFunctionResponsePart = {
          functionResponse: {
            id: sanitizedId,
            name: msg.toolName,
            response: msg.isError ? { error: responseText } : { output: responseText },
          },
        };
        appendTurn(contents, profile.isNonGemini ? GeminiRole.User : GeminiRole.Model, [
          part,
          ...imageParts,
        ]);
      }
    }
  }

  // Compaction can remove the user/tool-result boundary required before a function call.
  for (let index = 0; index < contents.length; index += 1) {
    const turn = contents[index];
    if (
      turn?.role === GeminiRole.Model &&
      turn.parts.some((part) => "functionCall" in part) &&
      contents[index - 1]?.role !== GeminiRole.User &&
      !contents[index - 1]?.parts.some((part) => "functionResponse" in part)
    ) {
      contents.splice(index, 0, {
        role: GeminiRole.User,
        parts: [{ text: CONTINUATION_TEXT }],
      });
      index += 1;
    }
  }

  // Google Antigravity requires a natural-language user part in the request,
  // including tool-only continuation turns. Keep injected Skills in the system
  // instruction, then add this protocol bridge only when existing context gives
  // the model something concrete to act on.
  const hasUserText = contents.some(
    (turn) =>
      turn.role === GeminiRole.User &&
      turn.parts.some((part) => "text" in part && Boolean(part.text.trim())),
  );
  if (!hasUserText && contents.length > 0) {
    const bridge = {
      text: CONTINUATION_TEXT,
    };
    const userTurn = contents.find((turn) => turn.role === GeminiRole.User);
    if (userTurn) userTurn.parts.push(bridge);
    else contents.unshift({ role: GeminiRole.User, parts: [bridge] });
  }

  const lastTurn = contents.at(-1);
  if (
    lastTurn?.role === GeminiRole.Model &&
    !lastTurn.parts.some((part) => "functionResponse" in part)
  ) {
    if (lastTurn.parts.some((part) => "functionCall" in part)) {
      throw new Error(
        "Antigravity request is missing tool result(s) for the final assistant tool call. Provide the corresponding tool result before continuing.",
      );
    }
    appendTurn(contents, GeminiRole.User, [{ text: CONTINUATION_TEXT }]);
  }

  return contents;
}

type SchemaReferenceIssue = {
  path: string;
  ref: string;
  reason: string;
};

type DereferencedSchema = {
  schema: unknown;
  issues: SchemaReferenceIssue[];
};

type DereferenceState = {
  nodes: number;
};

const MAX_SCHEMA_DEREFERENCE_DEPTH = 64;
const MAX_SCHEMA_DEREFERENCE_NODES = 10_000;
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Resolve a local RFC 6901 JSON Pointer against the original tool schema. */
function resolveLocalJsonPointer(ref: string, rootSchema: unknown): unknown {
  if (ref === "#") return rootSchema;
  if (!ref.startsWith("#/")) return undefined;

  let current: unknown = rootSchema;
  for (const token of ref.slice(2).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Dereference every schema in a keyword map without interpreting map keys as JSON Schema keywords. */
function dereferenceSchemaMap(
  schemaMap: unknown,
  rootSchema: unknown,
  refStack: Set<string>,
  objectStack: Set<object>,
  state: DereferenceState,
  path: string,
  depth: number,
): DereferencedSchema {
  if (!isRecord(schemaMap)) {
    return dereferenceSchema(schemaMap, rootSchema, refStack, objectStack, state, path, depth);
  }

  const out: Record<string, unknown> = {};
  const issues: SchemaReferenceIssue[] = [];
  for (const [key, value] of Object.entries(schemaMap)) {
    const result = dereferenceSchema(
      value,
      rootSchema,
      refStack,
      objectStack,
      state,
      `${path}.${key}`,
      depth,
    );
    out[key] = result.schema;
    issues.push(...result.issues);
  }
  return { schema: out, issues };
}

/**
 * Inline reachable local references while bounding expansion of untrusted MCP schemas.
 * A reported issue causes only the affected tool declaration to be omitted.
 */
function dereferenceSchema(
  schema: unknown,
  rootSchema: unknown = schema,
  refStack = new Set<string>(),
  objectStack = new Set<object>(),
  state: DereferenceState = { nodes: 0 },
  path = "$",
  depth = 0,
): DereferencedSchema {
  if (depth > MAX_SCHEMA_DEREFERENCE_DEPTH) {
    return {
      schema: {},
      issues: [
        {
          path,
          ref: "(depth limit)",
          reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_DEPTH} levels`,
        },
      ],
    };
  }
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_DEREFERENCE_NODES) {
    return {
      schema: {},
      issues: [
        {
          path,
          ref: "(node limit)",
          reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_NODES} nodes`,
        },
      ],
    };
  }
  if (!schema || typeof schema !== "object") return { schema, issues: [] };

  if (Array.isArray(schema)) {
    const results = schema.map((item, index) =>
      dereferenceSchema(
        item,
        rootSchema,
        refStack,
        objectStack,
        state,
        `${path}[${index}]`,
        depth + 1,
      ),
    );
    return {
      schema: results.map((result) => result.schema),
      issues: results.flatMap((result) => result.issues),
    };
  }

  const s = schema as Record<string, unknown>;
  if (objectStack.has(s)) {
    return {
      schema: {},
      issues: [{ path, ref: "(object cycle)", reason: "circular schema object" }],
    };
  }

  const nextObjectStack = new Set(objectStack);
  nextObjectStack.add(s);

  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    if (refStack.has(ref)) {
      return {
        schema: {},
        issues: [{ path, ref, reason: "circular local reference" }],
      };
    }

    const target = resolveLocalJsonPointer(ref, rootSchema);
    if (target === undefined) {
      return {
        schema: {},
        issues: [{ path, ref, reason: "target is not present in the root schema" }],
      };
    }

    const nextRefStack = new Set(refStack);
    nextRefStack.add(ref);
    const resolved = dereferenceSchema(
      target,
      rootSchema,
      nextRefStack,
      nextObjectStack,
      state,
      path,
      depth + 1,
    );
    const { $ref: _, ...siblings } = s;
    const siblingResult = dereferenceSchema(
      siblings,
      rootSchema,
      refStack,
      nextObjectStack,
      state,
      path,
      depth + 1,
    );

    if (isRecord(resolved.schema) && isRecord(siblingResult.schema)) {
      return {
        schema: { ...resolved.schema, ...siblingResult.schema },
        issues: [...resolved.issues, ...siblingResult.issues],
      };
    }
    return {
      schema: resolved.schema,
      issues: [...resolved.issues, ...siblingResult.issues],
    };
  }

  const out: Record<string, unknown> = {};
  const issues: SchemaReferenceIssue[] = [];
  for (const [key, value] of Object.entries(s)) {
    // Definitions are available through rootSchema while resolving $ref, but must
    // not be emitted because the Antigravity backend requires self-contained schemas.
    if (key === "$defs" || key === "definitions") continue;

    let result: DereferencedSchema | undefined;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      result = dereferenceSchemaMap(
        value,
        rootSchema,
        refStack,
        nextObjectStack,
        state,
        `${path}.${key}`,
        depth + 1,
      );
    } else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
      result = dereferenceSchema(
        value,
        rootSchema,
        refStack,
        nextObjectStack,
        state,
        `${path}.${key}`,
        depth + 1,
      );
    }

    if (result) {
      out[key] = result.schema;
      issues.push(...result.issues);
    } else {
      out[key] = value;
    }
  }
  return { schema: out, issues };
}

function ensureRootObjectSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} };
  }
  if (!schema.type) {
    return { ...schema, type: "object", properties: schema.properties || {} };
  }
  return schema;
}

const META_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
]);

/** Remove schema metadata without treating user-defined property names as keywords. */
function stripMetaSchemaMap(schemaMap: unknown): unknown {
  if (!isRecord(schemaMap)) return stripMetaSchema(schemaMap);
  return Object.fromEntries(
    Object.entries(schemaMap).map(([key, value]) => [key, stripMetaSchema(value)]),
  );
}

/** Remove metadata that Cloud Code Assist rejects from JSON Schema keyword positions. */
function stripMetaSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripMetaSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (META_SCHEMA_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] = stripMetaSchemaMap(value);
    } else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
      out[key] = stripMetaSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Protobuf `Schema` fields accepted by Cloud Code Assist's Claude/GPT custom-tool
 * bridge (`parameters` field). Anything else — `nullable`, `anyOf`, `format`,
 * `$ref`, etc. — returns `Unknown name "..."` / Invalid JSON payload (400).
 * Allowlist rather than denylist so new JSON Schema keywords cannot 400 the request.
 * Pi still validates tool args after the model calls them.
 */
// agy sends exactly these keywords in the `parameters` of every model family, Claude and GPT-OSS
// included (captured with claude-sonnet-5-5 and gpt-oss-120b). A tool that uses them stays on
// `parameters` instead of falling back to `parametersJsonSchema`, a field agy never sends.
const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "minimum",
  "minLength",
  "minItems",
]);

function normalizeCustomToolType(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  // JSON Schema union types like ["string","null"] → first non-null scalar type.
  const entries = value as unknown[];
  const scalar = entries.find(
    (entry): entry is string => typeof entry === "string" && entry !== "null",
  );
  return scalar;
}

function normalizeCustomToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const normalizedType = normalizeCustomToolType(value);
      if (normalizedType !== undefined) out.type = normalizedType;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      // Property names are user-defined, not Schema keywords — never allowlist-filter them.
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (
      key === "enum" &&
      Array.isArray(value) &&
      !value.every((entry) => typeof entry === "string")
    ) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

/**
 * agy builds a tool call's arguments from a Go map, which writes its keys sorted. A model's
 * arguments arrive in the order it produced them.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortKeysDeep(entry)]),
  );
}

// agy writes schemas from Go: keywords in struct order, `properties` in map (alphabetical) order.
// This is the order of every schema in a captured agy 1.5.9 request. Keywords it never sent keep
// their relative order after the known ones.
const SCHEMA_KEY_ORDER = [
  "type",
  "description",
  "enum",
  "format",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "properties",
  "required",
];

function schemaKeyRank(key: string): number {
  const index = SCHEMA_KEY_ORDER.indexOf(key);
  return index < 0 ? SCHEMA_KEY_ORDER.length : index;
}

/** Exported for unit tests. */
export function orderSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(orderSchema);
  if (!schema || typeof schema !== "object") return schema;
  const entries = Object.entries(schema).sort(([a], [b]) => schemaKeyRank(a) - schemaKeyRank(b));
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
        const properties = Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, property]) => [name, orderSchema(property)]);
        return [key, Object.fromEntries(properties)];
      }
      return [key, orderSchema(value)];
    }),
  );
}

// Prefer agy's protobuf schema dialect; Gemini's JSON Schema field preserves richer constraints.
export function convertTools(
  tools: Tool[] | undefined,
  customBackend = false,
): { functionDeclarations: GeminiFunctionDeclaration[] }[] | undefined {
  if (!tools?.length) return undefined;

  const warnings: string[] = [];
  const functionDeclarations = tools.flatMap((tool) => {
    const dereferenced = dereferenceSchema(tool.parameters);
    if (dereferenced.issues.length > 0) {
      const detail = dereferenced.issues
        .map((issue) => `${issue.path} (${issue.ref}: ${issue.reason})`)
        .join(", ");
      warnings.push(`Skipped tool '${tool.name}' due to unresolved schema reference: ${detail}`);
      return [];
    }

    const rootObject = ensureRootObjectSchema(dereferenced.schema);
    const schema = stripMetaSchema(rootObject);
    const parameters = normalizeCustomToolSchema(schema);
    const lossless = isDeepStrictEqual(parameters, schema);
    if (!lossless) {
      warnings.push(
        customBackend
          ? `Tool '${tool.name}' uses a reduced backend schema; Pi retains the original argument validation.`
          : `Tool '${tool.name}' uses parametersJsonSchema to preserve constraints unsupported by parameters.`,
      );
    }
    return [
      {
        name: tool.name,
        description: tool.description,
        ...(customBackend || lossless
          ? { parameters: orderSchema(parameters) }
          : { parametersJsonSchema: schema }),
      },
    ];
  });

  setLastToolSchemaWarnings(warnings.length ? warnings : undefined);
  if (!functionDeclarations.length) return undefined;
  return functionDeclarations.map((declaration) => ({ functionDeclarations: [declaration] }));
}

function mapToolChoiceMode(
  toolChoice: AntigravityStreamOptions["toolChoice"],
): GeminiToolCallingMode {
  if (toolChoice === ToolChoice.None) return GeminiToolCallingMode.None;
  if (toolChoice === ToolChoice.Any || toolChoice === ToolChoice.Required)
    return GeminiToolCallingMode.Any;
  return GeminiToolCallingMode.Auto;
}

/** The text of the conversation's first user message, which agy titles the conversation from. */
function firstUserMessage(context: Context): string | undefined {
  const first = context.messages.find((message) => message.role === "user");
  if (!first) return undefined;
  if (typeof first.content === "string") return first.content;
  return first.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** Exported for unit tests. */
export function buildRequest(
  model: Model<Api>,
  context: Context,
  projectId: string,
  options: AntigravityStreamOptions,
  runtimeModel: string,
  requestState?: AntigravityEnvelopeOptions,
): AntigravityGenerateRequest {
  const injectedSkills = context.messages.flatMap((msg) =>
    msg.role === "user" ? skillBlocks(msg.content) : [],
  );
  const systemPromptText = resolveCurrentSystemPrompt(context);
  const declaredTools = resolveCurrentTools(context);
  const systemParts = systemPromptText
    ? [{ text: renameHarness(sanitizeText(systemPromptText)) }]
    : [{ text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION }];
  systemParts.push(
    ...injectedSkills.map((skill) => ({ text: renameHarness(sanitizeText(skill)) })),
  );

  const contents = convertMessages(model, context, runtimeModel);
  // convertMessages guarantees a user text part whenever the transcript has any turn,
  // so an empty list is the only case left that needs the instructions as a prompt.
  if (contents.length === 0 && (injectedSkills.length > 0 || Boolean(systemPromptText))) {
    contents.unshift({
      role: GeminiRole.User,
      parts: [{ text: "Apply the active system instructions." }],
    });
  }

  const generationConfig: GeminiGenerationConfig = {};
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  generationConfig.maxOutputTokens =
    options.maxTokens !== undefined
      ? Math.min(options.maxTokens, maxAllowed)
      : Math.min(maxAllowed, model.maxTokens || maxAllowed);
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  const thinking = thinkingWire(runtimeModel, options.reasoning ?? "off");
  if (thinking) generationConfig.thinkingConfig = thinking;

  const profile = familyProfile(model.id, runtimeModel);
  const tools = convertTools(declaredTools, profile.family !== "gemini");
  const envelope = agentRequestEnvelope(runtimeModel, {
    isClaude: profile.isClaude,
    isNonGemini: profile.isNonGemini,
    sessionId: toInt64SessionId(options.sessionId),
    ...requestState,
  });

  // Key order is agy's, captured from a real 1.5.9 request: Go writes structs in field order.
  const request: GeminiRequestBody = {
    contents,
    systemInstruction: {
      role: GeminiRole.User,
      parts: systemParts,
    },
    ...(tools ? { tools } : {}),
    ...(options.toolChoice && options.toolChoice !== ToolChoice.Auto
      ? { toolConfig: { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } } }
      : {}),
    labels: envelope.labels,
    generationConfig,
    sessionId: envelope.sessionId,
  };

  return {
    project: projectId,
    requestId: envelope.requestId,
    request,
    model: runtimeModel,
    userAgent: AntigravityUserAgent.Antigravity,
    requestType: AntigravityRequestType.Agent,
  };
}

/** Exported for unit tests. */
export function mapStopReason(reason: string | undefined): StopReason {
  if (reason === "STOP") return StopReason.Stop;
  if (reason === "MAX_TOKENS") return StopReason.Length;
  return reason ? StopReason.Error : StopReason.Stop;
}

const DEBUG_DUMP_PATH = "/tmp/antigravity-last-request.json";

/**
 * ANTIGRAVITY_DEBUG_DUMP=1 saves the payload of a rejected request so a wire change
 * can be compared against agy. The body contains the conversation, so it is opt-in
 * and always written to a fixed path.
 */
async function dumpFailedRequest(detail: {
  status?: number;
  runtimeModel: string;
  body: string | undefined;
  errorText: string;
}): Promise<void> {
  if (antigravityEnv("DEBUG_DUMP") !== "1" || !detail.body) return;
  let parsedBody: unknown = detail.body;
  try {
    parsedBody = JSON.parse(detail.body);
  } catch {
    // Not JSON: keep the raw string in the dump.
  }
  try {
    await writeFile(
      DEBUG_DUMP_PATH,
      JSON.stringify(
        {
          status: detail.status,
          runtimeModel: detail.runtimeModel,
          errorText: detail.errorText.slice(0, 4000),
          body: parsedBody,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    setLastError(`debug dump failed: ${safeError(error)}`);
  }
}

/** Record a static route so doctor output is not matched=none on models that skip discovery. */
function recordStaticRouteDiagnostics(runtimeModel: string): void {
  if (!getCurrentMatchedModelDebug()) {
    setLastMatchedModelDebug(`static:${runtimeModel}`);
  }
  if (!getCurrentAvailableModels()) {
    const ids = Object.keys(getCurrentAntigravityRouting());
    setLastAvailableModels(ids.length > 0 ? ids.join(",") : "static-catalog");
  }
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: ANTIGRAVITY_API,
    provider: PROVIDER_ID,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function asToolCallArguments(args: Record<string, unknown> | undefined): ToolCall["arguments"] {
  return (args ?? {}) as ToolCall["arguments"];
}

/** Default response-header deadline for streaming requests (see fetchWithHeaderDeadline). */
const STREAM_HEADER_TIMEOUT_DEFAULT_MS = 180_000;
/** Default mid-body stall deadline: abort when no SSE bytes arrive for this long. */
const STREAM_STALL_TIMEOUT_DEFAULT_MS = 120_000;

function envTimeoutMs(name: string, fallback: number): number {
  const raw = antigravityEnv(name);
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

/**
 * Streaming header deadline in milliseconds, from ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS
 * (or the legacy NOAGY_ prefix). 0 disables the deadline; invalid values fall back
 * to the default.
 */
export function streamHeaderTimeoutMs(): number {
  return envTimeoutMs("STREAM_HEADER_TIMEOUT_MS", STREAM_HEADER_TIMEOUT_DEFAULT_MS);
}

/**
 * Mid-body stall deadline in milliseconds, from ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS
 * (legacy NOAGY_ prefix honored). 0 disables. A healthy SSE stream emits bytes
 * continuously while generating, so a silent gap this long means the connection
 * is dead even though headers arrived — abort with a named error rather than
 * hanging until an external process timeout.
 */
export function streamStallTimeoutMs(): number {
  return envTimeoutMs("STREAM_STALL_TIMEOUT_MS", STREAM_STALL_TIMEOUT_DEFAULT_MS);
}

function stallError(stallMs: number): Error {
  return new Error(`stream stalled: no data for ${stallMs}ms`);
}

/**
 * Guard a response body against mid-stream stalls while retaining caller
 * cancellation until the body finishes or is cancelled. The wrapper reads only
 * when its consumer pulls, preserving backpressure; its timer is unref'd so an
 * armed deadline cannot keep the process alive.
 */
function guardResponseBody(
  response: Response,
  controller: AbortController,
  stallMs: number,
  cleanup: () => void,
): Response {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    cleanup();
  };
  const reset = () => {
    if (stallMs <= 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(stallError(stallMs)), stallMs);
  };
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abortBody = () => {
    streamController?.error(controller.signal.reason);
    void reader.cancel(controller.signal.reason).catch(() => undefined);
    finish();
  };
  controller.signal.addEventListener("abort", abortBody, { once: true });
  reset();
  const guarded = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    async pull(streamController) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          streamController.close();
          return;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw new Error("Response body yielded an invalid chunk");
        }
        reset();
        streamController.enqueue(chunk.value);
      } catch (error) {
        finish();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(guarded, response);
}

/**
 * Fetch with a response-header deadline and a mid-body stall watchdog. A server
 * can accept a request on a warm keep-alive socket and then never send response
 * headers (header phase), or send headers and then go silent mid-body (stall
 * phase); either way the request is aborted with a named error instead of
 * hanging until an external process timeout. Long healthy responses are never
 * cut: the header timer disarms once headers arrive, and the stall timer resets
 * on every chunk, so only genuine silence aborts.
 *
 * Exported with an injectable fetch for unit tests.
 */
export async function fetchWithHeaderDeadline(
  url: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  stallMs: number = 0,
  fetchFn: (input: string, init: RequestInit) => Promise<Response> = antigravityTransport.fetch,
): Promise<Response> {
  if (timeoutMs <= 0 && stallMs <= 0) {
    return fetchFn(url, { ...init, signal: callerSignal ?? init.signal });
  }
  const controller = new AbortController();
  const forward = () => controller.abort(callerSignal?.reason);
  const cleanup = () => callerSignal?.removeEventListener("abort", forward);
  callerSignal?.addEventListener("abort", forward, { once: true });
  if (callerSignal?.aborted) forward();
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () => controller.abort(new Error(`no response headers within ${timeoutMs}ms`)),
          timeoutMs,
        )
      : undefined;
  let responseBodyGuarded = false;
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    responseBodyGuarded = Boolean(response.body);
    return guardResponseBody(response, controller, stallMs, cleanup);
  } finally {
    if (timer) clearTimeout(timer);
    if (!responseBodyGuarded) cleanup();
  }
}

/** Exported for unit tests. */

export async function streamResponse(
  response: Response,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model?: Model<Api>,
): Promise<boolean> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Consumed-prefix offset: the buffer is compacted once per network chunk instead of
  // re-copying the whole remainder for every SSE line.
  let scanStart = 0;
  let started = false;
  let currentBlock: ActiveBlock | null = null;
  let hasContent = false;
  let sawFinishReason = false;
  let stray = "";
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  const consumeStray = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    stray = stray ? `${stray}\n${trimmed}` : trimmed;
    const start = stray.indexOf("{");
    if (start < 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stray.slice(start));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return;
    const record = parsed as { error?: { code?: unknown; message?: unknown } };
    const status = typeof record.error?.code === "number" ? record.error.code : undefined;
    if (status !== undefined) setLastStatus(status);
    throw new Error(
      renderAntigravityFailure(classifyAntigravityFailure(status, stray.slice(start))),
    );
  };

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) {
      consumeStray(line);
      return;
    }
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") return;

    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(json) as StreamChunk;
    } catch {
      return;
    }

    if (chunk.error) {
      const status = typeof chunk.error.code === "number" ? chunk.error.code : undefined;
      if (status !== undefined) setLastStatus(status);
      throw new Error(
        renderAntigravityFailure(
          classifyAntigravityFailure(status, JSON.stringify({ error: chunk.error })),
        ),
      );
    }

    const responseData = chunk.response || chunk;
    const candidate = responseData.candidates?.[0];

    for (const part of candidate?.content?.parts || []) {
      if (part.text !== undefined) {
        hasContent = true;
        const isThinking = part.thought === true;
        const type = isThinking ? "thinking" : "text";
        if (!currentBlock || currentBlock.type !== type) {
          finishCurrent();
          currentBlock = isThinking
            ? { type: "thinking", thinking: "", thinkingSignature: undefined }
            : { type: "text", text: "" };
          blocks.push(currentBlock);
          ensureStarted();
          stream.push({
            type: isThinking ? "thinking_start" : "text_start",
            contentIndex: blockIndex(),
            partial: output,
          });
        }
        if (isThinking && currentBlock.type === "thinking") {
          currentBlock.thinking += part.text;
          if (part.thoughtSignature) currentBlock.thinkingSignature = part.thoughtSignature;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: part.text,
            partial: output,
          });
        } else if (!isThinking && currentBlock.type === "text") {
          currentBlock.text += part.text;
          if (part.thoughtSignature) currentBlock.textSignature = part.thoughtSignature;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: part.text,
            partial: output,
          });
        }
      }

      if (part.functionCall) {
        hasContent = true;
        finishCurrent();
        const rawId = part.functionCall.id || "";
        const toolCall: ToolCall = {
          type: "toolCall",
          id: sanitizeToolCallId(rawId, part.functionCall.name),
          name: part.functionCall.name || "",
          arguments: asToolCallArguments(part.functionCall.args),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        };
        blocks.push(toolCall);
        ensureStarted();
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: JSON.stringify(toolCall.arguments),
          partial: output,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall,
          partial: output,
        });
      }
    }

    if (candidate?.finishReason) {
      sawFinishReason = true;
      output.rawStopReason = candidate.finishReason;
      output.stopReason = blocks.some((b) => b.type === "toolCall")
        ? StopReason.ToolUse
        : mapStopReason(candidate.finishReason);
    }

    if (responseData.usageMetadata) {
      const prompt = responseData.usageMetadata.promptTokenCount || 0;
      const cacheRead = responseData.usageMetadata.cachedContentTokenCount || 0;
      const thoughts = responseData.usageMetadata.thoughtsTokenCount || 0;
      output.usage.input = prompt - cacheRead;
      output.usage.output = (responseData.usageMetadata.candidatesTokenCount || 0) + thoughts;
      output.usage.reasoning = thoughts;
      output.usage.cacheRead = cacheRead;
      output.usage.totalTokens = responseData.usageMetadata.totalTokenCount || 0;
      if (model?.cost) {
        calculateCost(model, output.usage);
      } else {
        output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      }
    }
  };

  const ensureStarted = () => {
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }
  };

  const finishCurrent = () => {
    if (!currentBlock) return;
    if (currentBlock.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: currentBlock.text,
        partial: output,
      });
    } else {
      stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: currentBlock.thinking,
        partial: output,
      });
    }
    currentBlock = null;
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) continue;
    buffer += decoder.decode(result.value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n", scanStart)) !== -1) {
      const line = buffer.slice(scanStart, newlineIdx);
      scanStart = newlineIdx + 1;
      handleLine(line.replace(/\r$/, ""));
    }

    if (scanStart > 0) {
      buffer = buffer.slice(scanStart);
      scanStart = 0;
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) handleLine(buffer.replace(/\r$/, ""));
  if (!sawFinishReason) {
    throw new Error(
      "Antigravity stream ended without a finish reason; the response was terminated before completion.",
    );
  }

  finishCurrent();
  return hasContent;
}

export function streamAntigravity(
  model: Model<Api>,
  context: Context,
  options?: AntigravityStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const opts = options ?? {};

  void runWithDiagnostics(async () => {
    const startTime = Date.now();
    const output: AntigravityAssistantMessage = createOutput(model);
    try {
      const creds = parseApiKey(opts.apiKey);
      // Skip loadCodeAssist roundtrip when credentials already carry a projectId.
      const warmedProject = creds.projectId ? null : await loadCodeAssist(creds.token);
      const projectId = resolveProjectId({
        token: creds.token,
        warmedProject,
        credentialProjectId: creds.projectId,
      });
      setLastProjectId(projectId);

      const effort = opts.reasoning ?? "off";
      const isKnownModel = model.id in getCurrentAntigravityRouting();
      const baseRuntimeModel =
        antigravityEnv("RUNTIME_MODEL")?.trim() || getAntigravityRequestModelId(model.id, effort);

      let initialRuntimeModel = baseRuntimeModel;
      // Skip pre-flight model discovery for known static models to optimize TTFT latency.
      // Dynamic lookup is only needed for unmapped custom models.
      if (!isKnownModel && !antigravityEnv("RUNTIME_MODEL")) {
        const dynamic = await fetchAvailableRuntimeModel(creds.token, projectId, baseRuntimeModel);
        if (dynamic?.id && isUsableRuntimeModelId(dynamic.id)) {
          initialRuntimeModel = dynamic.id;
        }
      }

      const runtimeCandidates = [initialRuntimeModel];
      const fallback = getFallbackRuntimeModel(initialRuntimeModel, effort);
      if (fallback && fallback !== initialRuntimeModel) {
        runtimeCandidates.push(fallback);
      }

      const requestHeaders = antigravityHeaders(creds.token);

      let response: Response | undefined;
      let lastText = "";
      let requestBody: string | undefined;
      let received = false;
      let runtimeModel = initialRuntimeModel;

      for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
        if (opts.signal?.aborted) throw new Error("Request was aborted");
        if (emptyAttempt > 0) {
          const delay = 500 * 2 ** (emptyAttempt - 1);
          await new Promise((res) => setTimeout(res, delay));
        }

        for (let candIdx = 0; candIdx < runtimeCandidates.length; candIdx++) {
          runtimeModel = runtimeCandidates[candIdx]!;
          setLastResolvedRuntimeModel(runtimeModel);
          recordStaticRouteDiagnostics(runtimeModel);
          const requestState =
            opts.reserveRequestState?.() ?? nextRequestState(context, opts.sessionId);
          output.antigravity = requestState;
          const rawPayload = buildRequest(
            model,
            context,
            projectId,
            opts,
            runtimeModel,
            requestState,
          );
          let requestPayload: unknown = rawPayload;
          if (opts.onPayload) {
            const nextPayload = await opts.onPayload(rawPayload, model);
            if (nextPayload !== undefined) requestPayload = nextPayload;
          }
          const body =
            typeof requestPayload === "string" ? requestPayload : JSON.stringify(requestPayload);
          requestBody = body;

          if (requestState.requestIndex === 0) {
            await registerTrajectory({
              token: creds.token,
              projectId,
              trajectoryId: requestState.trajectoryId,
              sessionId: requestState.sessionId,
              firstMessage: firstUserMessage(context),
              signal: opts.signal,
            });
          }
          const endpoint = antigravityEndpoint();
          setLastEndpoint(endpoint);
          response = await fetchWithHeaderDeadline(
            `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
            {
              method: "POST",
              headers: requestHeaders,
              body,
            },
            opts.signal,
            streamHeaderTimeoutMs(),
            streamStallTimeoutMs(),
          );
          setLastStatus(response.status);
          if (response.ok) {
            if (opts.onResponse) {
              const headersObj: Record<string, string> = {};
              response.headers.forEach((v, k) => {
                headersObj[k] = v;
              });
              await opts.onResponse({ status: response.status, headers: headersObj }, model);
            }
          } else {
            lastText = await response.text();
          }

          if (response?.ok) break;
          if (response?.status === 404) {
            if (candIdx + 1 < runtimeCandidates.length) {
              continue;
            }
            if (isKnownModel && candIdx === runtimeCandidates.length - 1) {
              const dynamic = await fetchAvailableRuntimeModel(
                creds.token,
                projectId,
                baseRuntimeModel,
              );
              if (
                dynamic?.id &&
                !runtimeCandidates.includes(dynamic.id) &&
                isUsableRuntimeModelId(dynamic.id)
              ) {
                runtimeCandidates.push(dynamic.id);
                continue;
              }
            }
          }
          break;
        }

        if (!response || !response.ok) {
          await dumpFailedRequest({
            status: response?.status,
            runtimeModel,
            body: requestBody,
            errorText: lastText,
          });
          const failure = classifyAntigravityFailure(response?.status, lastText);
          throw new Error(
            `Antigravity API error (${formatRequestDiagnostics({ projectId, runtimeModel })}): ${renderAntigravityFailure(failure)}`,
          );
        }

        output.content = [];
        output.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        output.stopReason = "stop";

        received = await streamResponse(response, stream, output, model);
        if (received) break;
      }

      if (!received) throw new Error("Antigravity API returned an empty response");
      setLastLatencyMs(Date.now() - startTime);
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        const errorDetail = output.rawStopReason
          ? `Provider stopped with: ${output.rawStopReason}`
          : "An unknown error occurred";
        output.errorMessage = output.errorMessage || errorDetail;
        setLastError(output.errorMessage);
        stream.push({ type: "error", reason: output.stopReason, error: output });
      } else if (output.stopReason === "pending") {
        // Pi's stop-reason union includes "pending"; a completed stream never carries it.
        throw new Error("Antigravity API returned no stop reason");
      } else {
        stream.push({ type: "done", reason: output.stopReason, message: output });
      }
      stream.end();
    } catch (error) {
      setLastLatencyMs(Date.now() - startTime);
      output.stopReason = opts.signal?.aborted ? "aborted" : "error";
      output.errorMessage = safeError(error);
      setLastError(output.errorMessage);
      // Ensure endpoint is recorded even if failure happened before setLastEndpoint.
      if (!getCurrentEndpoint()) setLastEndpoint(antigravityEndpoint());
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  });

  return stream;
}
