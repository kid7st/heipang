export function antigravityEnv(name: string): string | undefined {
  return process.env[`ANTIGRAVITY_${name}`] || process.env[`NOAGY_${name}`];
}

/**
 * Whether a model-facing extra tool (`google_search`, `generate_image`) is registered.
 * `ANTIGRAVITY_NO_EXTRA_TOOLS=1` disables both; `ANTIGRAVITY_NO_SEARCH_TOOL=1` and
 * `ANTIGRAVITY_NO_IMAGE_TOOL=1` disable one, e.g. to avoid clashing with another search provider.
 */
export function isExtraToolEnabled(tool: "SEARCH" | "IMAGE"): boolean {
  return antigravityEnv("NO_EXTRA_TOOLS") !== "1" && antigravityEnv(`NO_${tool}_TOOL`) !== "1";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Replace lone surrogates so a UTF-8 encoder cannot split a code point. */
export function sanitizeText(text: unknown): string {
  return String(text ?? "").toWellFormed();
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
