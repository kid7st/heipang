/**
 * Optional model-facing search tool.
 * Disable this extension resource in `pi config` to keep the Antigravity provider
 * and `/antigravity.search` without registering `google_search`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeAntigravitySearch } from "../search/index.js";
import { resolveRelayApiKey } from "../auth/index.js";
import { isExtraToolEnabled, redactSecrets } from "../utils/index.js";

export default function (pi: ExtensionAPI): void {
  if (!isExtraToolEnabled("SEARCH")) return;
  pi.registerTool({
    name: "search_web",
    label: "Search web",
    description:
      "Performs a web search for a given query. Returns a summary of relevant information along with URL citations.",
    promptSnippet: "Real-time Google Search grounding via Antigravity",
    promptGuidelines: [
      "Use search_web when you need real-time, up-to-date web information, latest news, documentation, or fact checking.",
      "Pass a domain when the answer should come from one site.",
    ],
    parameters: Type.Object({
      domain: Type.Optional(
        Type.String({
          description: "Optional domain to recommend the search prioritize",
        }),
      ),
      query: Type.String(),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const apiKey = await resolveRelayApiKey(signal);
      onUpdate?.({
        content: [{ type: "text", text: `Searching Google for: "${params.query}"…` }],
        details: {},
      });
      try {
        const result = await executeAntigravitySearch({
          apiKey,
          query: params.query,
          domain: params.domain,
          signal,
        });
        return {
          content: [{ type: "text", text: result }],
          details: {},
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(redactSecrets(msg), { cause: error });
      }
    },
  });
}
