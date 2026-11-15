import { antigravityTransport } from "../client/transport.js";

import { antigravityEndpoint, antigravityHeaders, parseApiKey } from "../client/client.js";
import { AntigravityRequestType, AntigravityUserAgent, GeminiRole } from "../types/enums.js";
import { isRecord } from "../utils/util.js";
import { describeAntigravityFailure } from "../wire/index.js";

/** The search model agy uses, and the only one this request is built for. */
export const SEARCH_MODEL = "gemini-3.5-flash-lite";

/** agy's search instruction, verbatim: the model must search, not converse. */
export const SEARCH_SYSTEM_INSTRUCTION =
  "You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.";

/** Image results requested alongside the web sources, as agy asks for them. */
const SEARCH_IMAGE_RESULT_COUNT = 5;

export type SearchSource = {
  /** Original groundingChunks index, including gaps from skipped non-web chunks. */
  index?: number;
  title: string;
  url: string;
  /** Rendered label: host plus readable path, or the advertised title. */
  label?: string;
};

export type SearchSupport = {
  text: string;
  startIndex?: number;
  endIndex?: number;
  partIndex?: number;
  sourceIndices: number[];
};

export type SearchResult = {
  text: string;
  sources: SearchSource[];
  queries: string[];
  /** Optional so existing callers can still construct results with the original shape. */
  parts?: Array<{ index: number; text: string }>;
  supports?: SearchSupport[];
};

export type ExecuteSearchOptions = {
  apiKey?: string;
  query: string;
  domain?: string;
  signal?: AbortSignal;
};

export type SearchCommandArgs = {
  query: string;
  domain?: string;
};

/**
 * Parse arguments for the interactive `/antigravity.search` command.
 * `--domain <host>` narrows the search the way agy's `site:` hint does.
 */
export function parseSearchCommandArgs(args: string): SearchCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const out: SearchCommandArgs = { query: "" };
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const next = tokens[i + 1];
    if (token === "--domain" && next) {
      out.domain = next;
      i += 1;
      continue;
    }
    rest.push(token);
  }

  out.query = rest.join(" ");
  return out;
}

/**
 * The web-search request agy sends: a lite Gemini model used as a search engine bot,
 * with server-side Google Search grounding. It carries no request envelope, no
 * session ids, and no labels — the backend treats it as a plain search, not a turn.
 */
export function buildSearchRequest(
  options: { query: string; domain?: string },
  model: string,
  projectId: string,
): Record<string, unknown> {
  const query = options.query.trim();
  const text = options.domain ? `${query} site:${options.domain}` : query;

  // Key order is agy's, captured from a real 1.5.9 web_search request.
  return {
    project: projectId,
    request: {
      contents: [{ role: GeminiRole.User, parts: [{ text }] }],
      systemInstruction: {
        role: GeminiRole.User,
        parts: [{ text: SEARCH_SYSTEM_INSTRUCTION }],
      },
      tools: [
        {
          googleSearch: {
            enhancedContent: { imageSearch: { maxResultCount: SEARCH_IMAGE_RESULT_COUNT } },
          },
        },
      ],
      generationConfig: { candidateCount: 1 },
    },
    model,
    userAgent: AntigravityUserAgent.Antigravity,
    requestType: AntigravityRequestType.WebSearch,
  };
}

/**
 * Parse visible candidate text and grounding metadata from an Antigravity response.
 * Preserve original part and source indices so UTF-8 citation offsets remain usable.
 *
 * @param data - Raw JSON response from Antigravity generateContent API.
 * @returns Synthesized text, web queries, sources, and grounding supports.
 */
export function parseSearchResponse(data: unknown): SearchResult {
  const result: SearchResult = { text: "", sources: [], queries: [], parts: [], supports: [] };
  if (!isRecord(data)) return result;

  const responseObj = isRecord(data.response) ? data.response : data;
  const candidates = Array.isArray(responseObj.candidates)
    ? (responseObj.candidates as unknown[])
    : [];
  const candidate = candidates[0];

  if (!isRecord(candidate)) {
    const errorObj = isRecord(data.error)
      ? data.error
      : isRecord(responseObj.error)
        ? responseObj.error
        : undefined;
    const msg =
      typeof errorObj?.message === "string"
        ? errorObj.message
        : "No candidate returned from Antigravity Search";
    result.text = `Error: ${msg}`;
    return result;
  }

  // Extract synthesized text (ignoring thinking parts)
  const content = isRecord(candidate.content) ? candidate.content : undefined;
  if (Array.isArray(content?.parts)) {
    result.parts = content.parts.flatMap((part, index) =>
      isRecord(part) && !part.thought && typeof part.text === "string" && part.text
        ? [{ index, text: part.text }]
        : [],
    );
    result.text = result.parts.map((part) => part.text).join("\n\n");
  }

  // Extract grounding citations & executed queries
  const grounding = isRecord(candidate.groundingMetadata) ? candidate.groundingMetadata : undefined;
  if (grounding) {
    if (Array.isArray(grounding.webSearchQueries)) {
      result.queries = grounding.webSearchQueries.filter((q): q is string => typeof q === "string");
    }
    if (Array.isArray(grounding.groundingChunks)) {
      for (const [index, chunk] of grounding.groundingChunks.entries()) {
        if (!isRecord(chunk)) continue;
        const web = isRecord(chunk.web) ? chunk.web : undefined;
        if (typeof web?.uri === "string") {
          result.sources.push({
            index,
            title: typeof web.title === "string" && web.title.trim() ? web.title.trim() : web.uri,
            url: web.uri,
          });
        }
      }
    }
    if (Array.isArray(grounding.groundingSupports)) {
      const sourceIndices = new Set(result.sources.map((source) => source.index));
      const textPartIndices = new Set(result.parts?.map((part) => part.index));
      for (const support of grounding.groundingSupports) {
        if (!isRecord(support) || !isRecord(support.segment)) continue;
        if (
          typeof support.segment.text !== "string" ||
          !Array.isArray(support.groundingChunkIndices)
        )
          continue;
        const partIndex = support.segment.partIndex ?? 0;
        if (typeof partIndex !== "number" || !textPartIndices.has(partIndex)) continue;
        const indices = support.groundingChunkIndices.filter(
          (index): index is number =>
            typeof index === "number" && Number.isInteger(index) && sourceIndices.has(index),
        );
        if (indices.length === 0) continue;
        result.supports?.push({
          text: support.segment.text,
          startIndex:
            typeof support.segment.startIndex === "number" ? support.segment.startIndex : undefined,
          endIndex:
            typeof support.segment.endIndex === "number" ? support.segment.endIndex : undefined,
          partIndex:
            typeof support.segment.partIndex === "number" ? support.segment.partIndex : undefined,
          sourceIndices: indices,
        });
      }
    }
  }

  return result;
}

/** Google wraps each source in this host; its path is an opaque token, not a readable path. */
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

/** True when a grounding title is nothing but a host, which names no page by itself. */
function isBareDomainTitle(title: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title);
}

/** Host of a URL, or the input unchanged when it does not parse. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Readable path segment for a label, but never the grounding redirect path: that is an
 * opaque token, and using it produces labels that are all distinct yet say nothing.
 */
function readablePath(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === GROUNDING_REDIRECT_HOST ||
      parsed.hostname.endsWith(`.${GROUNDING_REDIRECT_HOST}`)
    ) {
      return "";
    }
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/" || pathname.includes("grounding-api-redirect")) return "";
    return pathname;
  } catch {
    return "";
  }
}

/**
 * Label shown inline at the claim and in the source list.
 *
 * The advertised title wins when it names something more specific than the host. Otherwise
 * the label is the host, with the URL's path when it is not an opaque grounding redirect.
 * Nothing follows the redirect: the link is only ever opened by the reader.
 */
export function sourceLabel(source: SearchSource): string {
  // The chunk title is the real host; the raw url can be the opaque redirect host, which
  // must never surface as a label.
  const host = isBareDomainTitle(source.title) ? source.title.trim() : hostnameOf(source.url);
  if (source.title && !isBareDomainTitle(source.title)) return source.title;
  const path = readablePath(source.url);
  return path ? `${host}${path}` : host;
}
/** Keep a label from breaking out of its link slot or its list line. */
function escapeLinkText(text: string): string {
  return text.replace(/[[\]]/g, "\\$&").replace(/\s+/g, " ");
}

/** Encode characters that would close a Markdown link destination. */
function escapeLinkDestination(url: string): string {
  return url.replace(/\)/g, "%29").replace(/ /g, "%20");
}

/** One contiguous claim, carrying every source index that supports it. */
type CitationSpan = { start: number; end: number; indices: number[] };

type LineKind = "text" | "skip" | "table-row";
type LineInfo = { start: number; end: number; kind: LineKind; pipeAt?: number };

/**
 * Classify every line so citations never land in prose-hostile places.
 *
 * Google attaches supports to Markdown headings too, which would produce
 * `### Single-Writer Rule[1,2]` noise, and a marker appended after a table row's final
 * `|` adds a phantom column. Fenced code needs protecting for the same reason.
 */
function analyzeLines(text: string): LineInfo[] {
  const raw = text.split("\n");
  const lines: LineInfo[] = [];
  let offset = 0;
  let inFence = false;
  for (let index = 0; index < raw.length; index++) {
    const line = raw[index] ?? "";
    const start = offset;
    const end = start + line.length;
    offset = end + 1;

    let kind: LineKind = "text";
    let pipeAt: number | undefined;
    const isTableLine = (value: string): boolean => /^\s*\|?[\s:|-]*-[\s:|-]*\|/.test(value);

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      kind = "skip";
    } else if (inFence) {
      kind = "skip";
    } else if (/^\s*#{1,6}\s/.test(line)) {
      kind = "skip";
    } else if (line.trim().startsWith("|")) {
      const next = raw[index + 1] ?? "";
      if (isTableLine(line) || isTableLine(next)) {
        kind = "skip"; // separator or header row: a marker here breaks the table
      } else {
        const lastPipe = line.lastIndexOf("|");
        kind = "table-row";
        pipeAt = lastPipe > 0 ? start + lastPipe : end;
      }
    }
    lines.push({ start, end, kind, pipeAt });
  }
  return lines;
}

/** The classified line containing a character offset. */
function lineAt(lines: LineInfo[], position: number): LineInfo | undefined {
  return lines.find((line) => position >= line.start && position <= line.end);
}

/** Drop spans contained in a larger span, then merge overlapping ones, so one claim gets one marker. */
function mergeCitationSpans(spans: CitationSpan[]): CitationSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: CitationSpan[] = [];
  for (const span of sorted) {
    const container = kept.find((other) => other.start <= span.start && other.end >= span.end);
    if (container) {
      container.indices = [...new Set([...container.indices, ...span.indices])].sort(
        (a, b) => a - b,
      );
      continue;
    }
    kept.push({ start: span.start, end: span.end, indices: [...span.indices] });
  }
  const merged: CitationSpan[] = [];
  for (const span of kept) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
      previous.indices = [...new Set([...previous.indices, ...span.indices])].sort((a, b) => a - b);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/**
 * Map each UTF-8 byte offset in `text` to the JS character index it starts at.
 * Keep in sync with the byte-based verification below.
 */
function buildByteToCharMap(text: string): number[] {
  const map: number[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index) as number;
    const width = codePoint > 0xffff ? 2 : 1;
    const byteLength = Buffer.byteLength(text.slice(index, index + width), "utf8");
    for (let byte = 0; byte < byteLength; byte++) map.push(index);
    index += width;
  }
  map.push(text.length);
  return map;
}

/**
 * Google's offsets are UTF-8 bytes within a content Part, not JS character indices.
 *
 * Each segment is verified byte-for-byte before use. A segment whose bytes do not match
 * its reported text is relocated by searching the part instead of being discarded: the
 * offsets drift on some answers (table-heavy ones in particular), and dropping those
 * citations silently removes exactly the provenance this function exists to provide.
 *
 * Markers are grouped per insertion point. The first mention of a source carries both its
 * number and a full link, so the number always matches its entry in the source list below and
 * the reader never has to resolve an unexplained `[n]`.
 */
function citeSearchText(res: SearchResult): string {
  if (!res.supports?.length) return res.text;
  const textParts = res.parts ?? [{ index: 0, text: res.text }];
  // Respect callers editing result.text; original offsets no longer apply.
  if (textParts.map((part) => part.text).join("\n\n") !== res.text) {
    return res.text;
  }

  const bySourceIndex = new Map<number, { number: number; label: string; url: string }>();
  res.sources.forEach((source, position) => {
    const sourceIndex = source.index ?? position;
    bySourceIndex.set(sourceIndex, {
      number: sourceIndex + 1,
      label: sourceLabel(source),
      url: source.url,
    });
  });

  const seen = new Set<number>();
  const insertionsByPart = new Map<number, Array<{ at: number; text: string }>>();

  for (const part of textParts) {
    const bytes = Buffer.from(part.text, "utf8");
    const byteToChar = buildByteToCharMap(part.text);
    const lines = analyzeLines(part.text);
    const spans: CitationSpan[] = [];

    for (const support of res.supports ?? []) {
      if ((support.partIndex ?? 0) !== part.index) continue;
      const indices = support.sourceIndices.filter((index) => bySourceIndex.has(index));
      if (indices.length === 0) continue;

      let start = support.startIndex;
      let end = support.endIndex;
      const offsetsTrustworthy =
        typeof start === "number" &&
        typeof end === "number" &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end > start &&
        end <= bytes.length &&
        bytes.subarray(start, end).toString("utf8") === support.text;

      if (!offsetsTrustworthy) {
        const located = part.text.indexOf(support.text);
        if (located < 0) continue;
        start = Buffer.byteLength(part.text.slice(0, located), "utf8");
        end = start + Buffer.byteLength(support.text, "utf8");
      }

      const startChar = byteToChar[start as number] ?? part.text.length;
      const endChar = byteToChar[end as number] ?? part.text.length;
      if (endChar <= startChar) continue;
      spans.push({
        start: startChar,
        end: endChar,
        indices: [...new Set(indices)].sort((a, b) => a - b),
      });
    }

    for (const span of mergeCitationSpans(spans)) {
      const line = lineAt(lines, span.end);
      if (!line || line.kind === "skip") continue;
      const at = line.kind === "table-row" ? (line.pipeAt ?? span.end) : span.end;
      const pieces = span.indices.map((index) => {
        const source = bySourceIndex.get(index);
        if (!source) return "";
        if (seen.has(index)) return `[${source.number}]`;
        seen.add(index);
        // The first mention carries the number too, so it matches the sources list below.
        return `[${source.number}] [${escapeLinkText(source.label)}](${escapeLinkDestination(source.url)})`;
      });
      const text = ` ${pieces.filter(Boolean).join(" ")}`;
      const list = insertionsByPart.get(part.index) ?? [];
      list.push({ at, text });
      insertionsByPart.set(part.index, list);
    }
  }

  const rendered = textParts.map((part) => {
    let text = part.text;
    for (const insertion of (insertionsByPart.get(part.index) ?? []).sort((a, b) => b.at - a.at)) {
      text = text.slice(0, insertion.at) + insertion.text + text.slice(insertion.at);
    }
    return text;
  });

  return rendered.join("\n\n") || res.text;
}

/**
 * Formats structured SearchResult into clean Markdown for agent consumption.
 *
 * @param res - Structured search result containing text, sources, and executed queries.
 * @returns Formatted markdown string.
 */
export function formatSearchResult(res: SearchResult): string {
  const sections: string[] = [];

  const cited = citeSearchText(res);
  if (cited) sections.push(cited);

  if (res.sources.length > 0) {
    const list = res.sources
      .map((s, index) => {
        const number = res.supports?.length ? `[${(s.index ?? index) + 1}] ` : "";
        const url = s.url;
        return `- ${number}[${escapeLinkText(sourceLabel(s))}](${escapeLinkDestination(url)})`;
      })
      .join("\n");
    sections.push(`### Sources\n${list}`);
  }

  if (res.queries.length > 0) {
    const queries = res.queries.map((q) => `\`${q}\``).join(", ");
    sections.push(`*Search queries: ${queries}*`);
  }

  return sections.join("\n\n");
}

/**
 * Run one grounded search and format the result. agy issues a single request with no
 * fallback chain, so a failure here is reported rather than retried on another model.
 */
export async function executeAntigravitySearch(options: ExecuteSearchOptions): Promise<string> {
  const query = options.query.trim();
  if (!query) throw new Error("Search query is required.");

  const creds = parseApiKey(options.apiKey);
  const body = JSON.stringify(buildSearchRequest(options, SEARCH_MODEL, creds.projectId));
  if (options.signal?.aborted) throw new Error("Search request was aborted");

  const response = await antigravityTransport.fetch(
    `${antigravityEndpoint()}/v1internal:generateContent`,
    {
      method: "POST",
      headers: antigravityHeaders(creds.token),
      body,
      signal: options.signal,
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(describeAntigravityFailure(response.status, detail));
  }

  const data: unknown = await response.json();
  const parsed = parseSearchResponse(data);
  for (const source of parsed.sources) source.label = sourceLabel(source);
  return formatSearchResult(parsed);
}
