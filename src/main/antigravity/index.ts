import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { RELAY_AUTH_SOURCE, resolveRelayApiKey } from "./auth/index.js";
import { relayUrl } from "./client/relay.js";
import { getLastDiagnostics, runWithDiagnostics } from "./diagnostics/index.js";
import { generateAntigravityImage, parseImageCommandArgs } from "./image/index.js";
import { executeAntigravitySearch, parseSearchCommandArgs } from "./search/index.js";
import {
  applyAntigravityCatalog,
  discoverAntigravityModels,
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  resolvedCatalog,
} from "./models/index.js";
import { antigravityProvider } from "./provider.js";
import { bindSessionStream } from "./wire/persistence.js";
import { fetchAccountUsage, formatModelsList, formatUsageSummary } from "./usage/index.js";
import { redactSecrets, safeError } from "./utils/index.js";

/**
 * Pi's interactive `notify` writes into the chat transcript. `console.log` in that
 * mode prints to the raw terminal and paints over the TUI. Use one channel only.
 */
function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}

/**
 * Every credential-backed command shares this shape: the work announces itself,
 * and a failure, including a missing relay address or key, is reported once with its label.
 */
async function withCredentials(
  ctx: ExtensionCommandContext,
  label: string,
  progress: string,
  work: (apiKey: string) => Promise<string>,
): Promise<void> {
  if (ctx.hasUI) ctx.ui.notify(progress, "info");
  try {
    emitCommandOutput(ctx, await work(await resolveRelayApiKey()));
  } catch (error) {
    emitCommandOutput(ctx, `${label} failed: ${safeError(error)}`, "error");
  }
}

export { applyAntigravityCatalog, discoverAntigravityModels, getCurrentAntigravityCatalog, fetchAccountUsage };

export default function (pi: ExtensionAPI): void {
  const stream = bindSessionStream(pi);

  // Print and RPC modes do not refresh catalogs before resolving --model. Refresh on
  // session start so a stale 1.2.x cache is replaced before the prompt, and so the next
  // headless process hydrates Gemini 4 from the persisted store (#93).
  pi.on("session_start", async (_event, ctx) => {
    // Pi's registry already skips the network in offline mode.
    if (typeof ctx.modelRegistry?.refresh !== "function") return;
    try {
      await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
    } catch {
      // Last-known-good catalog stays in place. Forced refreshes still report via the command.
    }
  });

  pi.registerProvider(antigravityProvider(stream));

  pi.registerCommand("antigravity.usage", {
    description: "Show Antigravity shared quota pools (Gemini / Claude+GPT, 5h + weekly)",
    handler: async (_args, ctx) => {
      await withCredentials(
        ctx,
        "Antigravity usage",
        "Fetching Antigravity usage…",
        async (apiKey) =>
          formatUsageSummary(await runWithDiagnostics(() => fetchAccountUsage(apiKey))),
      );
    },
  });

  pi.registerCommand("antigravity.models", {
    description: "List Antigravity runtime models + remaining pool fraction",
    handler: async (args, ctx) => {
      const all = /\ball\b/i.test(args || "");
      await withCredentials(
        ctx,
        "Antigravity models",
        "Fetching Antigravity usage…",
        async (apiKey) =>
          formatModelsList(await runWithDiagnostics(() => fetchAccountUsage(apiKey)), { all }),
      );
    },
  });

  pi.registerCommand("antigravity.refresh", {
    description: "Force refresh Antigravity dynamic model catalog",
    handler: async (_args, ctx) => {
      await withCredentials(
        ctx,
        "Antigravity model refresh",
        "Refreshing Antigravity models…",
        async (apiKey) => {
          if (typeof ctx.modelRegistry?.refresh === "function") {
            const result = await ctx.modelRegistry.refresh({
              force: true,
              providers: [PROVIDER_ID],
            });
            if (result?.errors?.has(PROVIDER_ID)) {
              throw result.errors.get(PROVIDER_ID)!;
            }
          } else {
            const discovered = await discoverAntigravityModels(apiKey);
            const next = resolvedCatalog(discovered, getCurrentAntigravityCatalog());
            if (discovered.models.length > 0) {
              applyAntigravityCatalog(next);
            }
          }
          const catalog = getCurrentAntigravityCatalog();
          const count = catalog.models.length;
          const sample = catalog.models
            .slice(0, 4)
            .map((m) => m.name || m.id)
            .join(", ");
          return `Antigravity models refreshed (${count} available: ${sample}${count > 4 ? ", …" : ""})`;
        },
      );
    },
  });

  pi.registerCommand("antigravity.doctor", {
    description: "Show sanitized Antigravity provider diagnostics",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      let relay = "not configured";
      let relayStatus: string;
      try {
        relay = relayUrl();
        await resolveRelayApiKey();
        relayStatus = "ok";
      } catch (error) {
        relayStatus = safeError(error);
      }
      const lines = [
        `provider=${PROVIDER_ID}`,
        `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
        `availableModels=${d.availableModels || "none"}`,
        `matchedModel=${d.matchedModelDebug || "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastProjectId=${d.projectId || "none"}`,
        `credentialSource=${RELAY_AUTH_SOURCE}`,
        `relay=${relay}`,
        `relayStatus=${relayStatus}`,
        ...(d.latencyMs !== undefined ? [`lastLatencyMs=${d.latencyMs}`] : []),
        `toolSchemaWarnings=${d.toolSchemaWarnings || "none"}`,
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "commands=/antigravity.usage /antigravity.models /antigravity.refresh /antigravity.doctor /antigravity.image /antigravity.search",
      ];
      emitCommandOutput(ctx, `Antigravity doctor\n${lines.join("\n")}`);
    },
  });

  pi.registerCommand("antigravity.image", {
    description:
      "Generate an image via Antigravity (usage: /antigravity.image [--ratio 16:9] <prompt>)",
    handler: async (args, ctx) => {
      const parsed = parseImageCommandArgs(args || "");
      if (!parsed.prompt) {
        emitCommandOutput(
          ctx,
          "Usage: /antigravity.image [--ratio 16:9] [--model gemini-3-pro-image] [--path file.png] <prompt>",
          "warning",
        );
        return;
      }
      await withCredentials(
        ctx,
        "Antigravity image",
        "Generating Antigravity image…",
        async (apiKey) => {
          const result = await generateAntigravityImage({
            apiKey,
            cwd: ctx.cwd,
            prompt: parsed.prompt,
            aspectRatio: parsed.aspectRatio,
            model: parsed.model,
            path: parsed.path,
          });
          return `Saved image to ${result.savedPaths.join(", ")}`;
        },
      );
    },
  });

  pi.registerCommand("antigravity.search", {
    description:
      "Search the web via Antigravity Grounding (usage: /antigravity.search [--domain <host>] <query>)",
    handler: async (args, ctx) => {
      const parsed = parseSearchCommandArgs(args || "");
      if (!parsed.query) {
        emitCommandOutput(ctx, "Usage: /antigravity.search [--domain <host>] <query>", "warning");
        return;
      }
      await withCredentials(
        ctx,
        "Antigravity search",
        "Searching Google via Antigravity Grounding…",
        (apiKey) =>
          executeAntigravitySearch({ apiKey, query: parsed.query, domain: parsed.domain }),
      );
    },
  });
}
