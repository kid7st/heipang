import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyAntigravityCatalog, discoverAntigravityModels, getCurrentAntigravityCatalog } from "pi-antigravity/app";
import type { NewModelInput, RemoteModel } from "../shared/types.js";

type AnyModel = Model<any>;

interface CatalogModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}
// Codex only returns its newest models when the caller looks like a current CLI.
const CODEX_CLIENT_VERSION = "0.170.0";
const ANTHROPIC_FLOOR: [number, number] = [4, 7];
const OPENAI_FLOOR: [number, number] = [5, 5];
function anthropicVer(id: string): [number, number] {
	const s = id.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
	const nums = (s.match(/\d+/g) ?? []).map(Number);
	if (nums.length === 0) return [99, 0]; // unknown/new family → treat as newest
	return [nums[0], nums[1] ?? 0];
}
function openaiVer(id: string): [number, number] {
	const m = id.match(/gpt-(\d+)(?:\.(\d+))?/i);
	if (!m) return [99, 0];
	return [Number(m[1]), Number(m[2] ?? 0)];
}
function verGte(v: [number, number], floor: [number, number]): boolean {
	return v[0] > floor[0] || (v[0] === floor[0] && v[1] >= floor[1]);
}
function verCmpDesc(a: [number, number], b: [number, number]): number {
	return b[0] - a[0] || b[1] - a[1];
}
function isRecentAnthropic(id: string): boolean {
	return verGte(anthropicVer(id), ANTHROPIC_FLOOR);
}
function usesAdaptiveAnthropicThinking(id: string): boolean {
	const [major, minor] = anthropicVer(id);
	if (/fable/.test(id)) return major >= 5;
	if (/opus|sonnet/.test(id)) return major >= 5 || (major === 4 && minor >= 6);
	return false;
}
function isRecentOpenAI(id: string): boolean {
	return verGte(openaiVer(id), OPENAI_FLOOR);
}
function anthropicDefaultCtx(id: string): number {
	const [maj, min] = anthropicVer(id);
	if (/opus|sonnet/.test(id) && (maj > 4 || (maj === 4 && min >= 6))) return 1_000_000;
	return 200_000;
}

export class ModelCatalog {
	private catalogMem?: { fetchedAt: number; models: CatalogModel[] };
	private catalogInflight?: Promise<CatalogModel[]>;
	private discovered = new Map<string, RemoteModel>();
	private static readonly CATALOG_TTL = 7 * 24 * 60 * 60 * 1000;
	private static readonly CATALOG_URL =
		"https://raw.githubusercontent.com/kid7st/heipang/main/models-catalog.json";

	constructor(private agentDir: string, private runtime: () => Promise<ModelRuntime>, private settings: SettingsManager, private signal?: AbortSignal) {}

	async providerApiKey(provider: string): Promise<string | undefined> {
		try { return (await (await this.runtime()).getAuth(provider, { signal: this.signal }))?.auth.apiKey; }
		catch (error) {
			if (this.signal?.aborted && error === this.signal.reason) return undefined;
			throw error;
		}
	}

	private decodeJwt(token: string): any {
		try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
		catch { return null; }
	}

	private remember(models: RemoteModel[]): void {
		for (const model of models) this.discovered.set(`${model.provider}/${model.id}`, model);
	}

	async addModels(models: NewModelInput[]): Promise<void> {
		const runtime = await this.runtime();
		const path = join(this.agentDir, "models.json");
		const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
		data.providers ??= {};
		let changed = false;
		for (const input of models) {
			if (!input.provider.trim() || !input.id.trim()) throw new Error("Model provider and ID are required");
			const known = runtime.getModel(input.provider, input.id);
			const discovered = this.discovered.get(`${input.provider}/${input.id}`);
			const cached = this.readCatalogCache()?.models.find((model) => model.provider === input.provider && model.id === input.id);
			const reference = discovered ?? known ?? cached;
			const values = {
				name: input.name || discovered?.display_name || known?.name || cached?.name || input.id,
				reasoning: input.reasoning ?? reference?.reasoning ?? known?.reasoning ?? true,
				contextWindow: input.contextWindow ?? reference?.contextWindow ?? known?.contextWindow ??
					(input.provider === "openai-codex" ? 272000 : input.provider === "antigravity" ? 1048576 : input.provider === "anthropic" ? anthropicDefaultCtx(input.id) : 1000000),
				maxTokens: input.maxTokens ?? reference?.maxTokens ?? known?.maxTokens ??
					(input.provider === "deepseek" ? 384000 : input.provider === "antigravity" ? 65536 : 128000),
			};
			if (known) {
				const override: Partial<typeof values> = {};
				for (const key of ["name", "reasoning", "contextWindow", "maxTokens"] as const) {
					if (values[key] !== known[key]) Object.assign(override, { [key]: values[key] });
				}
				if (!Object.keys(override).length) continue;
				const provider = data.providers[input.provider] ??= {};
				provider.modelOverrides ??= {};
				provider.modelOverrides[input.id] = { ...provider.modelOverrides[input.id], ...override };
				changed = true;
				continue;
			}
			const entry: any = { id: input.id };
			Object.assign(entry, values, { input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
			if (input.provider === "anthropic" && values.reasoning) {
				entry.thinkingLevelMap = { xhigh: "xhigh" };
				if (usesAdaptiveAnthropicThinking(input.id)) entry.compat = { forceAdaptiveThinking: true, supportsTemperature: false };
			} else if (input.provider === "openai-codex") {
				entry.api = "openai-codex-responses";
				entry.baseUrl = "https://chatgpt.com/backend-api";
				if (values.reasoning) entry.thinkingLevelMap = { off: null, xhigh: "xhigh" };
			} else if (input.provider === "deepseek") {
				entry.api = "openai-completions";
				entry.baseUrl = "https://api.deepseek.com";
				if (input.id === "deepseek-v4-pro") entry.input = ["text"];
			} else if (input.provider === "antigravity") {
				const model = getCurrentAntigravityCatalog().models.find((model) => model.id === input.id);
				entry.api = "antigravity-api";
				entry.baseUrl = "https://daily-cloudcode-pa.googleapis.com";
				if (model) {
					entry.input = model.input;
					entry.thinkingLevelMap = model.thinkingLevelMap;
					entry.cost = model.cost;
				}
			}
			const provider = data.providers[input.provider] ??= {};
			provider.models ??= [];
			const index = provider.models.findIndex((model: any) => model.id === input.id);
			if (index < 0) provider.models.push(entry);
			else provider.models[index] = { ...provider.models[index], ...entry };
			changed = true;
		}
		if (!changed) return;
		mkdirSync(this.agentDir, { recursive: true });
		const directory = mkdtempSync(join(this.agentDir, ".models-"));
		try {
			const temporary = join(directory, "models.json");
			writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, path);
		} finally { rmSync(directory, { recursive: true, force: true }); }
		await runtime.refresh({ allowNetwork: false });
	}

	private catalogCachePath(): string {
		return join(this.agentDir, "models-catalog.cache.json");
	}
	private readCatalogCache(): { fetchedAt: number; models: CatalogModel[] } | null {
		if (this.catalogMem) return this.catalogMem;
		try {
			const d = JSON.parse(readFileSync(this.catalogCachePath(), "utf8"));
			if (d && Array.isArray(d.models)) {
				this.catalogMem = { fetchedAt: Number(d.fetchedAt) || 0, models: d.models };
				return this.catalogMem;
			}
		} catch {
			/* no cache yet */
		}
		return null;
	}
	private async fetchCatalogRemote(): Promise<CatalogModel[]> {
		const res = await fetch(`${ModelCatalog.CATALOG_URL}?t=${Date.now()}`, { cache: "no-store" } as any);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json: any = await res.json();
		const models: CatalogModel[] = Array.isArray(json?.models)
			? json.models.filter((m: any) => m && typeof m.provider === "string" && typeof m.id === "string")
			: [];
		const rec = { fetchedAt: Date.now(), models };
		this.catalogMem = rec;
		try {
			writeFileSync(this.catalogCachePath(), `${JSON.stringify(rec, null, 2)}\n`, "utf8");
		} catch {
			/* ignore */
		}
		return models;
	}
	/** Latest-model catalog. Serves cache instantly and refreshes in the
	 * background when older than a week (providers ship models ~quarterly), so
	 * new models arrive with no reinstall. `force` awaits a fresh pull. */
	async loadCatalog(force = false): Promise<CatalogModel[]> {
		const cache = this.readCatalogCache();
		const fresh = cache && Date.now() - cache.fetchedAt < ModelCatalog.CATALOG_TTL;
		if (fresh && !force) return cache!.models;
		const doFetch = () => {
			if (!this.catalogInflight) {
				this.catalogInflight = this.fetchCatalogRemote().finally(() => {
					this.catalogInflight = undefined;
				});
			}
			return this.catalogInflight;
		};
		if (cache && !force) {
			doFetch().catch(() => {}); // stale-while-revalidate
			return cache.models;
		}
		try {
			return await doFetch();
		} catch (error) {
			if (force) throw error;
			return cache?.models ?? [];
		}
	}
	async refreshModelCatalog(): Promise<{ ok: boolean; count?: number; error?: string }> {
		try {
			const models = await this.loadCatalog(true);
			return { ok: true, count: models.length };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Anthropic: live account model list (/v1/models), limited to recent models
	 * (>= 4.7) and enriched with context windows from the remote catalog. */
	async fetchRemoteModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }> {
		try {
			const token = await this.providerApiKey("anthropic");
			if (!token) return { ok: false, error: "No anthropic auth found in auth.json" };
			const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
				headers: {
					Authorization: `Bearer ${token}`,
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "oauth-2025-04-20",
				},
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
			}
			const json = (await res.json()) as {
				data?: Array<{
					id: string;
					display_name?: string;
					created_at?: string;
					max_input_tokens?: number;
					max_tokens?: number;
					capabilities?: { thinking?: { supported?: boolean } };
				}>;
			};
			const catalog = await this.loadCatalog();
			const cat = new Map(catalog.filter((c) => c.provider === "anthropic").map((c) => [c.id, c] as const));
			// "Already added" = already ENABLED (in the chat dropdown), not merely
			// present in the registry/bundled catalog — otherwise bundled models can
			// never be enabled from here (their checkbox would be disabled).
			const enabled = new Set(this.settings.getEnabledModels() ?? []);
			const models: RemoteModel[] = (json.data ?? [])
				.filter((d) => isRecentAnthropic(d.id))
				.map((d) => {
					const c = cat.get(d.id);
					return {
						id: d.id,
						display_name: d.display_name ?? d.id,
						created_at: d.created_at,
						provider: "anthropic",
						reasoning: d.capabilities?.thinking?.supported ?? c?.reasoning ?? true,
						contextWindow: d.max_input_tokens ?? c?.contextWindow ?? anthropicDefaultCtx(d.id),
						maxTokens: d.max_tokens ?? c?.maxTokens ?? 128000,
						alreadyAdded: enabled.has(`anthropic/${d.id}`),
					};
				})
				.sort(
					(a, b) =>
						(b.created_at ?? "").localeCompare(a.created_at ?? "") ||
						verCmpDesc(anthropicVer(a.id), anthropicVer(b.id)),
				);
			this.remember(models);
			return { ok: true, models };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Live Codex model list. The ChatGPT backend exposes the same endpoint the
	 * Codex CLI uses, and it is the only authoritative source for a model's real
	 * context window. Guessed windows are dangerous: an inflated value disables
	 * auto-compaction until the provider rejects the request outright. */
	private async fetchCodexModelsLive(): Promise<Map<string, CatalogModel & { hidden?: boolean }>> {
		const out = new Map<string, CatalogModel & { hidden?: boolean }>();
		try {
			const apiKey = await this.providerApiKey("openai-codex");
			if (!apiKey) return out;
			const accountId = this.decodeJwt(apiKey)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
			if (!accountId) return out;
			const res = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`, {
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${apiKey}`,
					"chatgpt-account-id": accountId,
					originator: "pi",
				},
				signal: AbortSignal.timeout(10000),
			});
			if (!res.ok) return out;
			const json: any = await res.json();
			for (const m of json?.models ?? []) {
				if (!m?.slug) continue;
				// `context_window` is only the Codex CLI's default truncation point, not a
				// hard limit: GPT-5.6 Sol has completed turns well past it. Use the larger
				// `max_context_window` so auto-compaction does not fire hundreds of
				// thousands of tokens early.
				const window =
					typeof m.max_context_window === "number" && m.max_context_window > (m.context_window ?? 0)
						? m.max_context_window
						: m.context_window;
				out.set(m.slug, {
					provider: "openai-codex",
					id: m.slug,
					name: m.title || m.slug,
					reasoning: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.length > 0 : true,
					contextWindow: typeof window === "number" ? window : undefined,
					maxTokens: typeof m.max_output_tokens === "number" ? m.max_output_tokens : undefined,
					hidden: m.visibility === "hide",
				});
			}
		} catch {
			/* offline or signed out — fall back to the bundled/remote catalog */
		}
		return out;
	}

	/** OpenAI (ChatGPT/Codex): merges pi-ai's bundled catalog and the remote
	 * catalog, then overlays the live Codex model list (authoritative names and
	 * context windows), limited to recent models (>= 5.5). */
	async fetchRemoteOpenAIModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }> {
		try {
			const catalog = await this.loadCatalog();
			const bundled = ((await this.runtime()).getModels("openai-codex") as AnyModel[]) ?? [];
			const map = new Map<string, RemoteModel>();
			for (const m of bundled) {
				map.set(m.id, {
					id: m.id,
					display_name: m.name ?? m.id,
					provider: "openai-codex",
					reasoning: !!m.reasoning,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					alreadyAdded: false,
				});
			}
			for (const c of catalog) {
				if (c.provider !== "openai-codex") continue;
				map.set(c.id, {
					id: c.id,
					display_name: c.name ?? c.id,
					provider: "openai-codex",
					reasoning: c.reasoning ?? true,
					contextWindow: c.contextWindow ?? 272000,
					maxTokens: c.maxTokens ?? 128000,
					alreadyAdded: false,
				});
			}
			// Live values win: a wrong context window silently breaks compaction.
			for (const [id, live] of await this.fetchCodexModelsLive()) {
				if (live.hidden && !map.has(id)) continue;
				const current = map.get(id);
				map.set(id, {
					id,
					display_name: live.name ?? current?.display_name ?? id,
					provider: "openai-codex",
					reasoning: live.reasoning ?? current?.reasoning ?? true,
					contextWindow: live.contextWindow ?? current?.contextWindow ?? 272000,
					maxTokens: live.maxTokens ?? current?.maxTokens ?? 128000,
					alreadyAdded: false,
				});
			}
			// "Already added" = already ENABLED (see the Anthropic method) so bundled
			// models (e.g. gpt-5.5) stay selectable until you actually enable them.
			const enabled = new Set(this.settings.getEnabledModels() ?? []);
			const models: RemoteModel[] = [...map.values()]
				.filter((m) => isRecentOpenAI(m.id))
				.map((m) => ({ ...m, alreadyAdded: enabled.has(`openai-codex/${m.id}`) }))
				.sort((a, b) => verCmpDesc(openaiVer(a.id), openaiVer(b.id)) || a.id.localeCompare(b.id));
			if (models.length === 0) return { ok: false, error: "No recent OpenAI models found (try Refresh)" };
			this.remember(models);
			return { ok: true, models };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Antigravity: dynamic model discovery via Cloud Code API, falling back
	 * to the bundled catalog when offline or signed out. */
	async fetchRemoteAntigravityModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }> {
		try {
			const enabled = new Set(this.settings.getEnabledModels() ?? []);
			let catalogModels: Array<{ id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }> = [];
			const apiKey = await this.providerApiKey("antigravity");
			if (apiKey) {
				try {
					const discovered = await discoverAntigravityModels(apiKey);
					if (discovered.models.length > 0) {
						applyAntigravityCatalog(discovered);
						catalogModels = discovered.models.map((m: any) => ({
							id: m.id,
							name: m.name ?? m.id,
							reasoning: m.reasoning ?? true,
							contextWindow: m.contextWindow ?? 1048576,
							maxTokens: m.maxTokens ?? 65536,
						}));
					}
				} catch {
					/* fallback to static catalog on failure */
				}
			}
			if (catalogModels.length === 0) {
				const fallback = getCurrentAntigravityCatalog();
				catalogModels = fallback.models.map((m: any) => ({
					id: m.id,
					name: m.name ?? m.id,
					reasoning: "reasoning" in m ? (m as any).reasoning : true,
					contextWindow: "contextWindow" in m ? (m as any).contextWindow : 1048576,
					maxTokens: "maxTokens" in m ? (m as any).maxTokens : 65536,
				}));
			}
			const models: RemoteModel[] = catalogModels.map((m) => ({
				id: m.id,
				display_name: m.name ?? m.id,
				provider: "antigravity",
				reasoning: m.reasoning ?? true,
				contextWindow: m.contextWindow ?? 1048576,
				maxTokens: m.maxTokens ?? 65536,
				alreadyAdded: enabled.has(`antigravity/${m.id}`),
			}));
			this.remember(models);
			return { ok: true, models };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

}
