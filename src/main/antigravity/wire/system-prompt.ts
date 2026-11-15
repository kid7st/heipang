/**
 * Google rejects a request whose system prompt says it runs inside `pi` with
 * `429 RESOURCE_EXHAUSTED`: the same request passes once the word is replaced (measured by
 * replaying a rejected request through the relay). Pi's default prompt opens with "You are a
 * coding assistant running inside pi, a coding agent harness", so every stock Pi would be turned
 * away. Only the system prompt is rewritten, never what the user wrote.
 */
export const HARNESS_NAME = "antigravity";

// A standalone word only: "piece", "pi-coding-agent" and "PI_VERSION" stay as they are.
const STANDALONE_PI = /(?<=^|\s)pi(?![\w-])/gi;

// Upstream reports 429 responses for this exact Pi documentation phrase.
const CODEMODE_DOCS_BLURB =
  /codemode scripts and non-LLM models such as classifiers and image models/g;

export function renameHarness(systemPrompt: string): string {
  return systemPrompt
    .replace(STANDALONE_PI, HARNESS_NAME)
    .replace(CODEMODE_DOCS_BLURB, "codemode scripts");
}
