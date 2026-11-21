import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { clipboard, nativeImage } from "electron";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AuthPrompt, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { convertPdfAttachments } from "./provider-compat.js";
import { measuredStream } from "./request-stream.js";
import type { InputBridge } from "./input-requests.js";
import { createExtensionUI } from "./extension-ui.js";
import { SessionTasks } from "./session-tasks.js";
import type { SessionIndexResult } from "./session-index-worker.js";
import { ModelCatalog } from "./model-catalog.js";
import { createPersistentModelRuntime, unresolvedCredentialErrors } from "./model-runtime.js";
import { antigravityProvider, fetchAccountUsage, hasRelayConfiguration } from "pi-antigravity/app";
import { AntigravitySettingsStore } from "./antigravity-settings.js";
import { createSessionResources, loadSessionResources } from "./session-resources.js";
import type {
	AccountInfo,
	AntigravitySettingsInput,
	ActiveState,
	CommandInfo,
	ExtensionItem,
	GuiSettings,
	ModelInfo,
	ModelsPayload,
	NewModelInput,
	OpenSessionResult,
	PiSettings,
	RemoteModel,
	ResourcesPayload,
	SessionListItem,
	Task,
	ThinkingLevel,
	UIMessage,
	UsageInfo,
} from "../shared/types.js";

const BUILTIN_COMMANDS: CommandInfo[] = [
	{ name: "usage", description: "Show this account's usage (5h / 7d limits)", source: "builtin" },
	{ name: "compact", description: "Summarize & compact the conversation to free context", source: "builtin" },
	{ name: "new", description: "Start a new conversation", source: "builtin" },
];

const DEFAULT_GUI_SETTINGS: GuiSettings = {
	autoExtractTasks: true,
	rightPanelOpen: true,
	workspaceNames: {},
	folderOrder: [],
	sidebarWidth: 280,
	rightPanelWidth: 320,
	sidebarCollapsed: false,
	disabledExtensions: [],
};

// Retain version-gate recovery until its original failure is verified against the bundled SDK.
const DEFAULT_CLAUDE_CODE_VERSION = "2.1.280";
const CLAUDE_CODE_VERSION_REQUIRED = /version (\d+\.\d+\.\d+) or newer is required/i;

type AnyModel = Model<any>;

// Anthropic's API accepts at most 100 images per request. Above 20 images it
// additionally requires every image to fit inside 2000×2000. A separate HTTP
// body limit (base64 included) can still cause 413, so keep the *whole image
// payload* inside a safe budget and adapt compression to the actual image count.
// Only request copies are changed; session files retain the original images.
const MANY_IMAGE_THRESHOLD = 20;
const MANY_IMAGE_MAX_PX = 2000;
const IMAGE_PAYLOAD_BASE64_BUDGET = 16 * 1024 * 1024;

function fitImageForRequest(block: any, targetBase64Chars: number, maxPx: number): any {
	try {
		const source = nativeImage.createFromBuffer(Buffer.from(block.data, "base64"));
		if (source.isEmpty()) return block;
		const { width, height } = source.getSize();
		const longest = Math.max(width, height);
		if (longest <= maxPx && block.data.length <= targetBase64Chars) return block;

		// OCR benefits more from pixel dimensions than pristine JPEG quality. Try
		// progressively smaller dimensions while keeping useful text detail.
		const dimensionSteps = [maxPx, 1800, 1600, 1400, 1200, 1000, 800]
			.filter((n, i, a) => n <= maxPx && n <= longest && a.indexOf(n) === i);
		if (dimensionSteps.length === 0) dimensionSteps.push(Math.min(maxPx, longest));
		const qualitySteps = [86, 76, 66, 56, 46];
		let smallest: Buffer | undefined;

		for (const longestTarget of dimensionSteps) {
			const scale = Math.min(1, longestTarget / longest);
			const candidate = scale < 1
				? source.resize({
						width: Math.max(1, Math.floor(width * scale)),
						height: Math.max(1, Math.floor(height * scale)),
						quality: "best",
					})
				: source;
			for (const quality of qualitySteps) {
				const encoded = candidate.toJPEG(quality);
				if (!smallest || encoded.length < smallest.length) smallest = encoded;
				if (Math.ceil(encoded.length / 3) * 4 <= targetBase64Chars) {
					return { ...block, data: encoded.toString("base64"), mimeType: "image/jpeg" };
				}
			}
		}

		return smallest ? { ...block, data: smallest.toString("base64"), mimeType: "image/jpeg" } : block;
	} catch {
		return block;
	}
}

function guardManyImageContext(messages: AgentMessage[]): AgentMessage[] {
	let imageCount = 0;
	let totalBase64Chars = 0;
	for (const message of messages) {
		const content = (message as any).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type !== "image" || typeof block.data !== "string" || !/^image\//.test(block.mimeType || "")) continue;
			imageCount++;
			totalBase64Chars += block.data.length;
		}
	}
	if (imageCount === 0) return messages;
	const manyImages = imageCount > MANY_IMAGE_THRESHOLD;
	if (!manyImages && totalBase64Chars <= IMAGE_PAYLOAD_BASE64_BUDGET) return messages;

	const targetPerImage = Math.max(64 * 1024, Math.floor(IMAGE_PAYLOAD_BASE64_BUDGET / imageCount));
	const maxPx = manyImages ? MANY_IMAGE_MAX_PX : 8000;
	return messages.map((message) => {
		const content = (message as any).content;
		if (!Array.isArray(content)) return message;
		let changed = false;
		const guarded = content.map((block: any) => {
			if (block?.type !== "image" || typeof block.data !== "string" || !/^image\//.test(block.mimeType || "")) return block;
			const fitted = fitImageForRequest(block, targetPerImage, maxPx);
			if (fitted !== block) changed = true;
			return fitted;
		});
		return changed ? ({ ...message, content: guarded } as AgentMessage) : message;
	});
}

type SessionNavigation = {
	cwd?: string;
	path?: string;
	controller: AbortController;
	opening?: Promise<OpenSessionResult>;
};

function sessionFileKey(path: string): string {
	try { return realpathSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return resolve(path);
	}
}

export class Driver {
	readonly agentDir: string;
	private modelRuntimePromise: Promise<ModelRuntime>;
	private credentialRevisions = new Map<string, symbol>();
	private providerWarmupPromise?: Promise<void>;
	private settings: SettingsManager;

	private catalogLoader: DefaultResourceLoader;
	private guiSettings: GuiSettings;

	private session?: AgentSession;
	private activeCwd = "";
	private unsubscribe?: () => void;
	// SessionManager.listAll() parses every JSONL (including image base64). Cache
	// the result so startup/event bursts never rescan hundreds of MB repeatedly.
	private sessionListCache?: SessionListItem[];
	private sessionListInflight?: Promise<SessionIndexResult>;
	private sessionIndexWorker?: Worker;
	private contextCache?: { sessionId: string; value: number | undefined };
	private lastStateKey = "";

	private sessionTasks = new WeakMap<AgentSession, SessionTasks>();
	private sessionControllers = new Map<AgentSession, AbortController>();
	private sessionOperations = new WeakMap<AgentSession, Set<Promise<unknown>>>();
	private sessionShutdownErrors = new WeakMap<AgentSession, unknown[]>();
	private shutdownController = new AbortController();
	private releasingSessions = new WeakMap<AgentSession, Promise<void>>();
	private navigationSequence = 0;
	private navigation?: SessionNavigation;
	private pendingNavigations = new Set<SessionNavigation>();
	private fileMutation?: { cwd?: string; path?: string; done?: Promise<void> };
	private closing = false;
	private shutdownErrors: Error[] = [];
	private shutdownPromise?: Promise<void>;
	oauthBridge?: InputBridge;
	private loginController?: AbortController;

	private claudeCodeVersion = DEFAULT_CLAUDE_CODE_VERSION;

	private sentUiCount = 0;
	private sentRawCount = 0;
	private sentTailUiCount = 0;
	private msgFlushTimer?: ReturnType<typeof setTimeout>;

	// live-usage cache (the upstream usage endpoints rate-limit aggressively → 429)
	private usageCache = new Map<string, { ts: number; value: UsageInfo }>();
	private usageInflight = new Map<string, Promise<UsageInfo>>();
	private static readonly USAGE_TTL = 60_000;

	private onMessages?: (messages: UIMessage[], sessionId: string) => void;
	private onMessagesPatch?: (from: number, messages: UIMessage[], sessionId: string) => void;
	private onState?: (state: ActiveState) => void;
	private onTasks?: (tasks: Task[], sessionId: string) => void;
	private onSessionUpdated?: (path?: string) => void;
	private onRunComplete?: (path?: string) => void;
	private onError?: (message: string) => void;
	private onBackground?: (sessions: { path: string; cwd: string }[]) => void;

	// Sessions that keep running after the user navigates away (multi-session
	// parallelism). The SDK persists their messages internally on message_end,
	// so they finish + save even with no UI attached. Disposed on completion.
	private bgSessions = new Map<string, { session: AgentSession; unsubscribe: () => void; cwd: string }>();

	// Per-session run timing (keyed by sessionId), so "working for X" keeps
	// counting from the real start even after leaving + returning to a session.
	private runStart = new Map<string, number>();
	private lastRunMs = new Map<string, number>();

	// The SDK has auto-retry, but some provider stream failures (notably Anthropic
	// "terminated") can still surface as a final assistant error with no visible
	// retry. Keep a GUI-level fallback that continues from the same user turn.
	private guiRetryAttempt = new Map<string, number>();
	private guiRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// A manual stop must also suppress retries which are created just after the
	// provider/agent emits its final error event. Cleared by the next user send.
	private cancelledRuns = new Set<string>();

	private catalog: ModelCatalog;

	private antigravitySettings: AntigravitySettingsStore;

	constructor() {
		this.agentDir = getAgentDir();
		this.antigravitySettings = new AntigravitySettingsStore(this.agentDir);
		this.modelRuntimePromise = this.createModelRuntime();
		this.guiSettings = this.loadGuiSettings();
		const resources = createSessionResources(homedir(), this.agentDir, () => this.guiSettings?.disabledExtensions ?? []);
		this.settings = resources.settingsManager;
		this.catalogLoader = resources.resourceLoader;
		this.catalog = new ModelCatalog(this.agentDir, () => this.runtime(), this.settings, this.shutdownController.signal);
		void this.catalog.loadCatalog();
	}

	setHandlers(handlers: {
		onMessages: (messages: UIMessage[], sessionId: string) => void;
		onMessagesPatch: (from: number, messages: UIMessage[], sessionId: string) => void;
		onState: (state: ActiveState) => void;
		onTasks: (tasks: Task[], sessionId: string) => void;
		onSessionUpdated: (path?: string) => void;
		onRunComplete: (path?: string) => void;
		onError: (message: string) => void;
		onBackground?: (sessions: { path: string; cwd: string }[]) => void;
	}): void {
		this.onMessages = handlers.onMessages;
		this.onMessagesPatch = handlers.onMessagesPatch;
		this.onState = handlers.onState;
		this.onTasks = handlers.onTasks;
		this.onSessionUpdated = handlers.onSessionUpdated;
		this.onRunComplete = handlers.onRunComplete;
		this.onError = handlers.onError;
		this.onBackground = handlers.onBackground;
	}

	// --------------------------------------------------------- resources/settings

	async getResources(): Promise<ResourcesPayload> {
		if (!this.session) await this.warmExtensionProviders();
		const resourceLoader = this.session?.resourceLoader ?? this.catalogLoader;
		const ext = resourceLoader.getExtensions();
		const skillsRes = resourceLoader.getSkills();
		const errByPath = new Map(ext.errors.map((e) => [e.path, e.error]));
		const disabledList = this.guiSettings?.disabledExtensions ?? [];
		const disabledKeys = new Set(disabledList.flatMap((path) => isAbsolute(path) ? [path, resolve(path)] : [path]));
		const isDisabled = (path: string) => disabledKeys.has(path) || (isAbsolute(path) && disabledKeys.has(resolve(path)));
		const isBuiltin = (path: string) => path.startsWith("<") || path.startsWith("builtin:");
		const extensions: ExtensionItem[] = ext.extensions
			.filter((e) => !isDisabled(e.path) && !isDisabled(e.resolvedPath) && (!isAbsolute(e.resolvedPath) || existsSync(e.resolvedPath)))
			.map((e) => ({
				name: basename(e.path).replace(/\.[tj]s$/, ""),
				path: e.path,
				tools: [...e.tools.keys()],
				commands: [...e.commands.keys()],
				error: errByPath.get(e.path),
				builtin: isBuiltin(e.path),
			}))
			.concat(
				ext.errors
					.filter((er) => !isDisabled(er.path) && !ext.extensions.some((e) => e.path === er.path))
					.map((er) => ({
						name: basename(er.path).replace(/\.[tj]s$/, ""),
						path: er.path,
						tools: [],
						commands: [],
						error: er.error,
						builtin: isBuiltin(er.path),
					})),
			);
		for (const path of disabledList) {
			if (isBuiltin(path) || (isAbsolute(path) && !existsSync(path))) continue;
			extensions.push({
				name: basename(path).replace(/\.[tj]s$/, ""),
				path,
				tools: [],
				commands: [],
				disabled: true,
				builtin: false,
			});
		}
		return {
			extensions,
			skills: skillsRes.skills.filter((s) => existsSync(s.filePath)).map((s) => ({ name: s.name, description: s.description, filePath: s.filePath })),
			skillDiagnostics: skillsRes.diagnostics.map((d) => ({ type: d.type, message: d.message, path: d.path })),
			extensionsDir: join(this.agentDir, "extensions"),
			skillsDir: join(this.agentDir, "skills"),
		};
	}

	async getPiSettings(): Promise<PiSettings> {
		await this.settings.reload();
		return {
			defaultThinkingLevel: this.settings.getDefaultThinkingLevel(),
			steeringMode: this.settings.getSteeringMode(),
			followUpMode: this.settings.getFollowUpMode(),
		};
	}

	async setPiSettings(partial: Partial<PiSettings>): Promise<PiSettings> {
		if (partial.defaultThinkingLevel) this.settings.setDefaultThinkingLevel(partial.defaultThinkingLevel);
		if (partial.steeringMode) this.settings.setSteeringMode(partial.steeringMode);
		if (partial.followUpMode) this.settings.setFollowUpMode(partial.followUpMode);
		await this.settings.flush();
		for (const session of this.liveSessions()) {
			await session.settingsManager.reload();
			if (partial.steeringMode) session.setSteeringMode(partial.steeringMode);
			if (partial.followUpMode) session.setFollowUpMode(partial.followUpMode);
		}
		return this.getPiSettings();
	}

	private guiSettingsPath(): string {
		return join(this.agentDir, ".pi-gui.json");
	}
	private loadGuiSettings(): GuiSettings {
		try {
			const raw = JSON.parse(readFileSync(this.guiSettingsPath(), "utf8"));
			return {
				...DEFAULT_GUI_SETTINGS,
				...raw,
				disabledExtensions: Array.isArray(raw.disabledExtensions)
					? raw.disabledExtensions.filter((p: unknown): p is string => typeof p === "string")
					: [],
			};
		} catch {
			return { ...DEFAULT_GUI_SETTINGS };
		}
	}
	getGuiSettings(): GuiSettings {
		return this.guiSettings;
	}
	setGuiSettings(partial: Partial<GuiSettings>): GuiSettings {
		this.guiSettings = { ...this.guiSettings, ...partial };
		try {
			writeFileSync(this.guiSettingsPath(), `${JSON.stringify(this.guiSettings, null, 2)}\n`, "utf8");
		} catch {
			/* ignore */
		}
		return this.guiSettings;
	}

	// ---------------------------------------------------------------- models

	private async createModelRuntime(): Promise<ModelRuntime> {
		const runtime = await createPersistentModelRuntime(this.agentDir, this.shutdownController.signal, this.credentialRevisions);
		runtime.registerNativeProvider(antigravityProvider());
		// Override shared OAuth credentials in memory without changing CLI authentication.
		if (hasRelayConfiguration()) await runtime.setRuntimeApiKey("antigravity", "heipang-relay");
		return runtime;
	}

	/** Catalog and account operations must not register providers into live sessions. */
	private async runtime(): Promise<ModelRuntime> {
		this.shutdownController.signal.throwIfAborted();
		const runtime = await this.modelRuntimePromise;
		this.shutdownController.signal.throwIfAborted();
		return runtime;
	}

	// Register account-level providers without firing session lifecycle hooks.
	private async warmExtensionProviders(): Promise<void> {
		this.shutdownController.signal.throwIfAborted();
		if (this.providerWarmupPromise) return this.providerWarmupPromise;
		this.providerWarmupPromise = (async () => {
			await this.catalogLoader.reload();
			const { session } = await createAgentSession({
				agentDir: this.agentDir,
				cwd: homedir(),
				modelRuntime: await this.runtime(),
				settingsManager: this.settings,
				resourceLoader: this.catalogLoader,
				sessionManager: SessionManager.inMemory(),
			});
			session.dispose();
		})().catch((error) => {
			this.providerWarmupPromise = undefined;
			this.onError?.(`Could not load extension providers: ${error instanceof Error ? error.message : String(error)}`);
		});
		return this.providerWarmupPromise;
	}

	private modelToInfo(m: AnyModel, hasAuth: boolean): ModelInfo {
		return {
			provider: m.provider,
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			thinkingLevels: getSupportedThinkingLevels(m) as ThinkingLevel[],
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			hasAuth,
		};
	}

	async listModels(): Promise<ModelsPayload> {
		await this.settings.reload();
		await this.warmExtensionProviders();
		const runtime = this.session?.modelRuntime ?? await this.runtime();
		const availableModels = await runtime.getAvailable();
		const availableKeys = new Set(availableModels.map((m) => `${m.provider}/${m.id}`));
		const all = runtime
			.getModels()
			.map((m) => this.modelToInfo(m as AnyModel, availableKeys.has(`${m.provider}/${m.id}`)));
		const available = availableModels.map((m) => this.modelToInfo(m as AnyModel, true));
		return {
			all,
			available,
			enabled: this.settings.getEnabledModels() ?? [],
			defaultProvider: this.settings.getDefaultProvider(),
			defaultModel: this.settings.getDefaultModel(),
			defaultThinkingLevel: this.settings.getDefaultThinkingLevel(),
		};
	}

	private liveSessions(): AgentSession[] {
		return [...(this.session ? [this.session] : []), ...[...this.bgSessions.values()].map((entry) => entry.session)];
	}

	async addModels(models: NewModelInput[]): Promise<ModelsPayload> {
		await this.catalog.addModels(models);
		await Promise.all(this.liveSessions().map((session) => session.modelRuntime.refresh({ allowNetwork: false })));
		return this.listModels();
	}

	async setEnabledModels(enabled: string[]): Promise<ModelsPayload> {
		this.settings.setEnabledModels(enabled);
		await this.settings.flush();
		return this.listModels();
	}

	async setDefaultModel(provider: string, id: string): Promise<ModelsPayload> {
		this.settings.setDefaultModelAndProvider(provider, id);
		await this.settings.flush();
		return this.listModels();
	}

	// -------- Remote model catalog (weekly-refreshed "latest models") --------

	async refreshModelCatalog(): Promise<{ ok: boolean; count?: number; error?: string }> {
		return this.catalog.refreshModelCatalog();
	}

	async fetchRemoteModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }> {
		return this.catalog.fetchRemoteModels();
	}

	async fetchRemoteOpenAIModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }> {
		return this.catalog.fetchRemoteOpenAIModels();
	}

	async fetchRemoteAntigravityModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }> {
		return this.catalog.fetchRemoteAntigravityModels();
	}

	// -------------------------------------------------------------- sessions

	private archiveDir(): string {
		return join(this.agentDir, "sessions-archived");
	}

	private assertSessionAvailable(cwd?: string, path?: string): void {
		if (this.closing) throw new Error("The application is closing");
		if ((this.fileMutation?.path && path && sessionFileKey(path) === this.fileMutation.path)
			|| (this.fileMutation?.cwd && cwd && resolve(cwd) === this.fileMutation.cwd)) {
			throw new Error("This session is being deleted or archived. Wait for the operation to finish.");
		}
	}

	private async mutateSessionFiles(scope: { cwd: string } | { path: string }, mutate: () => void | Promise<void>): Promise<void> {
		this.assertSessionAvailable();
		if (this.fileMutation) throw new Error("Another session file operation is in progress.");
		const target = "cwd" in scope ? { cwd: resolve(scope.cwd) } : { path: sessionFileKey(scope.path) };
		const matches = (cwd: string | undefined, path?: string) => "cwd" in target
			? !!cwd && resolve(cwd) === target.cwd : !!path && sessionFileKey(path) === target.path;
		const activeMatches = this.session && matches(this.session.sessionManager.getCwd(), this.session.sessionFile);
		const navigationMatches = this.navigation && matches(this.navigation.cwd, this.navigation.path);
		const pending = [...this.pendingNavigations].filter((navigation) => matches(navigation.cwd, navigation.path));
		const mutation: NonNullable<Driver["fileMutation"]> = target;
		this.fileMutation = mutation;
		if (navigationMatches) this.cancelNavigation();
		for (const navigation of pending) navigation.controller.abort(new Error("Session navigation was superseded"));
		const operation = (async () => {
			try {
				if (activeMatches) await this.disposeSession();
				for (const [path, bg] of this.bgSessions) {
					if (matches(bg.session.sessionManager.getCwd(), path)) await this.killBackground(path);
				}
				for (const navigation of pending) {
					try { await navigation.opening; }
					catch (error) {
						if (error !== navigation.controller.signal.reason) throw error;
					}
				}
				for (const session of [...this.sessionControllers.keys()]) {
					if (matches(session.sessionManager.getCwd(), session.sessionFile)) await this.releaseSession(session);
				}
				await mutate();
			} finally {
				this.fileMutation = undefined;
				this.invalidateSessionList();
			}
		})();
		mutation.done = operation;
		await operation;
	}

	async archiveSession(path: string): Promise<void> {
		await this.mutateSessionFiles({ path }, () => {
			if (!existsSync(path)) return;
			const sessionsRoot = join(this.agentDir, "sessions");
			const rel = path.startsWith(sessionsRoot) ? path.slice(sessionsRoot.length + 1) : basename(path);
			const dest = join(this.archiveDir(), rel);
			mkdirSync(dirname(dest), { recursive: true });
			renameSync(path, dest);
		});
	}

	private async killBackground(path: string): Promise<void> {
		const entry = this.bgSessions.get(path);
		if (!entry) return;
		this.bgSessions.delete(path);
		entry.unsubscribe();
		this.emitBackground();
		await this.releaseSession(entry.session);
	}

	async deleteSession(path: string): Promise<void> {
		await this.mutateSessionFiles({ path }, () => {
			if (existsSync(path)) rmSync(path, { force: true });
		});
	}

	async deleteFolder(cwd: string): Promise<void> {
		await this.mutateSessionFiles({ cwd }, async () => {
			const infos = await SessionManager.listAll();
			const dirs = new Set<string>();
			for (const s of infos) {
				if (s.cwd !== cwd) continue;
				if (existsSync(s.path)) {
					dirs.add(dirname(s.path));
					rmSync(s.path, { force: true });
				}
				rmSync(`${s.path}.tasks.json`, { force: true });
			}
			for (const d of dirs) {
				if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
			}
		});
	}

	async renameSession(path: string, name: string): Promise<void> {
		this.assertSessionAvailable(undefined, path);
		const trimmed = name.trim();
		this.invalidateSessionList();
		if (!trimmed) return;
		if (this.session?.sessionFile === path) {
			this.assertSessionAvailable(this.session.sessionManager.getCwd(), path);
			this.session.setSessionName(trimmed);
			this.emitState();
			return;
		}
		const bg = this.bgSessions.get(path);
		if (bg) {
			this.assertSessionAvailable(bg.session.sessionManager.getCwd(), path);
			bg.session.setSessionName(trimmed);
			return;
		}
		const sm = SessionManager.open(path);
		this.assertSessionAvailable(sm.getCwd(), path);
		sm.appendSessionInfo(trimmed);
	}

	private invalidateSessionList(): void {
		this.sessionListCache = undefined;
	}

	async listSessions(): Promise<SessionListItem[]> {
		if (this.sessionListCache) return this.sessionListCache;
		if (!this.sessionListInflight) {
			if (!this.sessionIndexWorker) {
				this.sessionIndexWorker = new Worker(join(__dirname, "session-index-worker.js"), {
					workerData: { sessionDir: join(this.agentDir, "sessions") },
				});
				this.sessionIndexWorker.unref();
			}
			const worker = this.sessionIndexWorker;
			this.sessionListInflight = new Promise<SessionIndexResult>((resolve, reject) => {
				const cleanup = () => { worker.off("message", onMessage); worker.off("error", onError); };
				const onMessage = (result: SessionIndexResult | { error: string }) => {
					cleanup();
					if ("error" in result) { reject(new Error(result.error)); return; }
					if (!result.errors.length) this.sessionListCache = result.items;
					resolve(result);
				};
				const onError = (error: Error) => { cleanup(); this.sessionIndexWorker = undefined; reject(error); };
				worker.once("message", onMessage);
				worker.once("error", onError);
				worker.postMessage("scan");
			}).finally(() => { this.sessionListInflight = undefined; });
		}
		const result = await this.sessionListInflight;
		if (result.errors.length) this.onError?.(result.errors.join("\n"));
		return result.items;
	}

	// ------------------------------------------------------------ conversion

	private toUIMessages(messages: any[]): UIMessage[] {
		const out: UIMessage[] = [];
		for (const m of messages) {
			if (!m || typeof m !== "object") continue;
			if (m.role === "user") {
				out.push({ role: "user", content: m.content, timestamp: m.timestamp ?? 0 });
			} else if (m.role === "assistant") {
				const content = (m.content ?? []).filter(
					(c: any) => c.type === "text" || c.type === "thinking" || c.type === "toolCall",
				);
				out.push({
					role: "assistant",
					content,
					model: m.model,
					stopReason: m.stopReason,
					errorMessage: m.errorMessage,
					usage: m.usage
						? {
								input: m.usage.input,
								output: m.usage.output,
								cacheRead: m.usage.cacheRead,
								cacheWrite: m.usage.cacheWrite,
								totalTokens: m.usage.totalTokens,
							}
						: undefined,
					timestamp: m.timestamp ?? 0,
				});
			} else if (m.role === "toolResult") {
				out.push({
					role: "toolResult",
					toolCallId: m.toolCallId,
					toolName: m.toolName,
					content: (m.content ?? []).filter((c: any) => c.type === "text" || c.type === "image"),
					isError: !!m.isError,
					timestamp: m.timestamp ?? 0,
				});
			}
			// drop custom/bashExecution/etc. for v1
		}
		return out;
	}

	private computeContextPct(): number | undefined {
		if (!this.session?.model?.contextWindow) return undefined;
		if (this.contextCache?.sessionId === this.session.sessionId) return this.contextCache.value;
		// The SDK accounts for compaction boundaries, omitted failed attempts and
		// new tool output. A zero-usage error must not reset the counter to zero.
		const usage = this.session.getContextUsage();
		const value = usage?.percent == null ? undefined : Math.min(100, Math.round(usage.percent));
		this.contextCache = { sessionId: this.session.sessionId, value };
		return value;
	}

	getActiveState(): ActiveState | null {
		if (!this.session) return null;
		const m = this.session.model;
		const sdkRetrying = !!(this.session as any).isRetrying;
		const sdkRetryAttempt = Number((this.session as any).retryAttempt ?? 0);
		const guiRetrying = this.guiRetryTimers.has(this.session.sessionId);
		const guiRetryAttempt = this.guiRetryAttempt.get(this.session.sessionId) ?? 0;
		return {
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			sessionName: this.session.sessionName,
			cwd: this.activeCwd,
			model: m ? { provider: m.provider, id: m.id, name: m.name } : undefined,
			thinkingLevel: this.session.thinkingLevel as ThinkingLevel,
			isStreaming: this.session.isStreaming || this.session.isCompacting,
			isCompacting: this.session.isCompacting,
			isRetrying: sdkRetrying || guiRetrying,
			retryAttempt: Math.max(sdkRetryAttempt, guiRetryAttempt) || undefined,
			contextPct: this.computeContextPct(),
			runStartedAt: this.runStart.get(this.session.sessionId),
			lastRunMs: this.lastRunMs.get(this.session.sessionId),
		};
	}

	private markRunStart(session?: AgentSession): void {
		if (!session) return;
		if (!this.runStart.has(session.sessionId)) this.runStart.set(session.sessionId, Date.now());
	}

	private markRunEnd(session?: AgentSession): void {
		if (!session) return;
		const start = this.runStart.get(session.sessionId);
		if (start != null) {
			this.lastRunMs.set(session.sessionId, Date.now() - start);
			this.runStart.delete(session.sessionId);
		}
	}

	private clearGuiRetry(sessionId: string): void {
		const timer = this.guiRetryTimers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.guiRetryTimers.delete(sessionId);
		this.guiRetryAttempt.delete(sessionId);
	}

	/** Claude Code identity headers; empty for non-Anthropic models. */
	private anthropicClientHeaders(model: any): Record<string, string> {
		if (model?.provider !== "anthropic") return {};
		return { "user-agent": `claude-cli/${this.claudeCodeVersion}` };
	}

	/** Anthropic names the client version it wants; adopt it so the next try passes. */
	private adoptRequiredClaudeCodeVersion(message: any): boolean {
		const match = CLAUDE_CODE_VERSION_REQUIRED.exec(String(message?.errorMessage ?? ""));
		if (!match) return false;
		const required = match[1];
		if (required === this.claudeCodeVersion) return false;
		this.claudeCodeVersion = required;
		return true;
	}

	private lastAssistant(messages: any[]): any | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") return messages[i];
		}
		return undefined;
	}

	private scheduleGuiRetry(session: AgentSession): void {
		const sessionId = session.sessionId;
		if (this.cancelledRuns.has(sessionId) || this.guiRetryTimers.has(sessionId)) return;
		const last = this.lastAssistant(session.messages as any[]);
		if (this.adoptRequiredClaudeCodeVersion(last)) {
			this.onError?.(`Anthropic requires a newer Claude Code client; retrying as ${this.claudeCodeVersion}`);
			this.guiRetryAttempt.delete(sessionId);
			const timer = setTimeout(() => {
				this.guiRetryTimers.delete(sessionId);
				if (this.cancelledRuns.has(sessionId)) return;
				void session.agent.continue().catch(() => {});
			}, 250);
			this.guiRetryTimers.set(sessionId, timer);
			return;
		}
		// The current SDK already recovers transient provider errors. A second
		// network retry loop multiplies attempts and races persisted context.
		this.guiRetryAttempt.delete(sessionId);
	}

	getMessages(): UIMessage[] {
		if (!this.session) return [];
		return this.toUIMessages(this.session.messages);
	}

	// ------------------------------------------------------ session lifecycle

	private wireSession(): void {
		if (!this.session) return;
		const session = this.session;
		this.unsubscribe = session.subscribe((event) => {
			if (this.session !== session) return;
			switch (event.type) {
				case "message_start":
					// Clear a previous manual-stop latch only once the new user turn
					// reaches the ordered session event queue. This lets any stale
					// auto-retry event from the aborted turn be cancelled first.
					if ((event as any).message?.role === "user" && this.session) {
						this.cancelledRuns.delete(this.session.sessionId);
					}
					this.scheduleEmit();
					this.emitState();
					break;
				case "message_update":
					this.scheduleEmit();
					break;
				case "turn_end":
					this.scheduleEmit();
					this.emitState();
					break;
				case "message_end":
					this.contextCache = undefined;
					if ((event as any).message?.role === "assistant" && (event as any).message?.stopReason !== "error" && this.session) {
						this.clearGuiRetry(this.session.sessionId);
					}
					this.flushEmit();
					this.emitState();
					break;
				case "agent_end":
					// The SDK may still retry/compact/drain queued messages. Only the
					// settlement event means this conversation is finished.
					this.flushEmit();
					this.emitState();
					break;
				case "agent_settled": {
					this.invalidateSessionList();
					this.contextCache = undefined;
					this.onSessionUpdated?.(this.session?.sessionFile);
					this.markRunEnd(this.session);
					this.flushEmit();
					if (this.session) this.scheduleGuiRetry(this.session);
					const retryPending = !!this.session && (this.guiRetryTimers.has(this.session.sessionId) || !!(this.session as any).isRetrying);
					this.emitState();
					if (!retryPending) {
						this.scheduleAutoExtract();
						this.onRunComplete?.(this.session?.sessionFile);
					}
					break;
				}
				case "auto_retry_start": {
					const session = this.session;
					if (session && this.cancelledRuns.has(session.sessionId)) {
						// AgentSession emits auto_retry_start immediately before creating its
						// abort controller. Run in a microtask so abortRetry sees that controller.
						queueMicrotask(() => {
							if (!this.cancelledRuns.has(session.sessionId)) return;
							session.abortRetry();
							session.agent.abort();
							this.emitState();
						});
						break;
					}
					this.onError?.(`Auto-retry: ${event.errorMessage}`);
					this.emitState();
					break;
				}
				case "auto_retry_end":
					this.emitState();
					break;
				case "compaction_start":
				case "compaction_end":
					this.contextCache = undefined;
					if ((event as any).errorMessage) this.onError?.((event as any).errorMessage);
					this.flushEmit();
					this.emitState();
					break;
				default:
					break;
			}
		});
	}

	// Throttle streaming emits to ~16ms and send only the changed TAIL of the
	// transcript (not the whole thing) so long sessions stay cheap to stream.
	private scheduleEmit(): void {
		if (this.msgFlushTimer) return;
		this.msgFlushTimer = setTimeout(() => {
			this.msgFlushTimer = undefined;
			this.emitMessages();
			this.emitState();
		}, 16);
	}

	private flushEmit(): void {
		if (this.msgFlushTimer) {
			clearTimeout(this.msgFlushTimer);
			this.msgFlushTimer = undefined;
		}
		this.emitMessages();
	}

	private emitMessages(): void {
		if (!this.session) return;
		const messages = this.session.messages;
		if (messages.length < this.sentRawCount) {
			const ui = this.toUIMessages(messages);
			this.resetMessageCursor(ui.length);
			this.onMessages?.(ui, this.session.sessionId);
			return;
		}
		const from = Math.max(0, this.sentUiCount - this.sentTailUiCount);
		const tail = this.toUIMessages(messages.slice(Math.max(0, this.sentRawCount - 1)));
		this.sentUiCount = from + tail.length;
		this.sentRawCount = messages.length;
		this.sentTailUiCount = this.toUIMessages(messages.slice(-1)).length;
		this.onMessagesPatch?.(from, tail, this.session.sessionId);
	}

	private resetMessageCursor(uiCount: number): void {
		this.sentUiCount = uiCount;
		this.sentRawCount = this.session?.messages.length ?? 0;
		this.sentTailUiCount = this.toUIMessages(this.session?.messages.slice(-1) ?? []).length;
	}

	private emitState(): void {
		const s = this.getActiveState();
		if (!s) return;
		const key = JSON.stringify(s);
		if (key === this.lastStateKey) return;
		this.lastStateKey = key;
		this.onState?.(s);
	}

	private async disposeSession(): Promise<void> {
		const session = this.session;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (session) {
			this.clearGuiRetry(session.sessionId);
			this.cancelledRuns.delete(session.sessionId);
		}
		this.session = undefined;
		this.clearSessionUiState();
		if (session) await this.releaseSession(session);
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.closing = true;
		this.shutdownController.abort(new Error("The application is closing"));
		this.loginController?.abort();
		const pending = [...this.pendingNavigations];
		this.cancelNavigation();
		for (const navigation of pending) navigation.controller.abort(new Error("The application is closing"));
		for (const controller of this.sessionControllers.values()) controller.abort();
		this.shutdownPromise = (async () => {
			const results = await Promise.allSettled([
				...pending.map((navigation) => navigation.opening),
				this.disposeSession(),
				...[...this.bgSessions.keys()].map((path) => this.killBackground(path)),
				this.fileMutation?.done,
				this.providerWarmupPromise,
			]);
			const remaining = await Promise.allSettled([
				...[...this.sessionControllers.keys()].map((session) => this.releaseSession(session)),
				this.modelRuntimePromise.then((runtime) => runtime.settleCredentialWrites()),
			]);
			const errors = [...results, ...remaining].flatMap((result, index) => result.status === "rejected"
				? unresolvedCredentialErrors(result.reason).filter((error) => !(index < pending.length && error === pending[index].controller.signal.reason)) : []);
			errors.push(...this.shutdownErrors);
			if (errors.length) throw new AggregateError(errors, `Could not close all sessions: ${errors.map(String).join("; ")}`);
		})();
		return this.shutdownPromise;
	}

	private async runSessionOperation<T>(session: AgentSession, run: () => Promise<T>): Promise<T> {
		const signal = this.sessionControllers.get(session)!.signal;
		signal.throwIfAborted();
		let operations = this.sessionOperations.get(session);
		if (!operations) this.sessionOperations.set(session, operations = new Set());
		const operation = Promise.resolve().then(() => {
			signal.throwIfAborted();
			return run();
		});
		operations.add(operation);
		try {
			const result = await operation;
			signal.throwIfAborted();
			return result;
		} finally { operations.delete(operation); }
	}

	private releaseSession(session: AgentSession): Promise<void> {
		const releasing = this.releasingSessions.get(session);
		if (releasing) return releasing;
		this.sessionTasks.get(session)?.dispose();
		this.sessionTasks.delete(session);
		const controller = this.sessionControllers.get(session);
		controller?.abort(new Error("This session is closing"));
		const release = (async () => {
			const results = await Promise.allSettled([
				Promise.resolve().then(() => session.abort()),
				...(this.sessionOperations.get(session) ?? []),
			]);
			const errors = results.flatMap((result, index) => result.status === "rejected"
				&& !(index > 0 && controller?.signal.aborted && result.reason === controller.signal.reason) ? [result.reason] : []);
			this.sessionShutdownErrors.set(session, errors);
			try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
			catch (error) { errors.push(error); }
			finally { this.sessionShutdownErrors.delete(session); }
			try { session.dispose(); }
			catch (error) { errors.push(error); }
			try { await session.modelRuntime.settleCredentialWrites(); }
			catch (error) { errors.push(error); }
			finally { this.sessionControllers.delete(session); }
			if (errors.length === 1) throw errors[0];
			if (errors.length) throw new AggregateError(errors, `Could not release session: ${errors.map(String).join("; ")}`);
		})();
		this.releasingSessions.set(session, release);
		return release;
	}

	/** Reset the per-session UI bookkeeping WITHOUT touching the session object. */
	private clearSessionUiState(): void {
		this.contextCache = undefined;
		this.lastStateKey = "";
		this.resetMessageCursor(0);
		// A fresh attachment must emit the complete transcript once.
		this.sentRawCount = 0;
		this.sentTailUiCount = 0;
		if (this.msgFlushTimer) clearTimeout(this.msgFlushTimer);
		this.msgFlushTimer = undefined;
	}

	// --------------------------------------------- background (parallel) runs

	private emitBackground(): void {
		const list = [...this.bgSessions.entries()].map(([path, e]) => ({ path, cwd: e.cwd }));
		this.onBackground?.(list);
	}

	/**
	 * Leaving the current session: if it's mid-run, keep it alive in the
	 * background (so it finishes + saves); otherwise dispose it.
	 */
	private async leaveCurrent(): Promise<void> {
		if (!this.session) return;
		this.tasksFor()?.cancelScheduled();
		const file = this.session.sessionFile;
		if (!this.session.isIdle && file && !this.bgSessions.has(file)) {
			const session = this.session;
			const cwd = this.activeCwd;
			// drop the UI-coupled subscription; attach a minimal background one
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			const unsub = session.subscribe((event) => {
				if (event.type === "agent_settled") {
					this.invalidateSessionList();
					this.onSessionUpdated?.(file);
					this.markRunEnd(session);
					void this.finishBackground(file).catch((error) => this.onError?.(String(error)));
				}
			});
			this.bgSessions.set(file, { session, unsubscribe: unsub, cwd });
			this.session = undefined;
			this.clearSessionUiState();
			this.emitBackground();
		} else {
			await this.disposeSession();
		}
	}

	private async finishBackground(file: string): Promise<void> {
		const entry = this.bgSessions.get(file);
		if (!entry) return;
		this.bgSessions.delete(file);
		entry.unsubscribe();
		this.emitBackground();
		await this.releaseSession(entry.session);
		this.onRunComplete?.(file);
	}

	/** If `path` is running in the background, detach it and make it active. */
	private reattachBackground(path: string): boolean {
		const entry = this.bgSessions.get(path);
		if (!entry) return false;
		this.bgSessions.delete(path);
		entry.unsubscribe();
		this.session = entry.session;
		this.activeCwd = entry.cwd;
		this.wireSession();
		this.tasksFor();
		this.scheduleAutoExtract();
		const messages = this.getMessages();
		this.resetMessageCursor(messages.length);
		this.emitBackground();
		return true;
	}

	// ----------------------------------------------------------------- tasks
	//
	// Tasks are CONCEPTS (small projects / informal requests), not per-message.
	// A fast LLM summarizes the conversation into a short list of distinct tasks.
	// Status is set by the human only; we never auto-decide done/cancelled.

	private tasksFor(session = this.session): SessionTasks | undefined {
		if (!session) return undefined;
		let tasks = this.sessionTasks.get(session);
		if (!tasks) {
			tasks = new SessionTasks(session, (model) => this.anthropicClientHeaders(model),
				(next) => { if (this.session === session) this.onTasks?.(next, session.sessionId); },
				(message) => this.onError?.(message));
			this.sessionTasks.set(session, tasks);
		}
		return tasks;
	}

	getTasks(): Task[] { return this.tasksFor()?.get() ?? []; }

	private activeTasks(sessionId: string): SessionTasks {
		this.assertSessionAvailable();
		const session = this.session;
		if (!session || session.sessionId !== sessionId) throw new Error("The selected session has changed. Reopen it before updating tasks.");
		this.assertSessionAvailable(session.sessionManager.getCwd(), session.sessionFile);
		return this.tasksFor(session)!;
	}

	updateTask(task: Task, sessionId: string): Task[] { return this.activeTasks(sessionId).update(task); }

	deleteTask(id: string, sessionId: string): Task[] { return this.activeTasks(sessionId).delete(id); }

	async extractTasks(sessionId: string, force = true): Promise<{ ok: boolean; tasks?: Task[]; error?: string }> {
		return this.activeTasks(sessionId).extract(force);
	}

	private scheduleAutoExtract(): void {
		if (this.guiSettings.autoExtractTasks) this.tasksFor()?.schedule();
	}

	async getCommands(): Promise<CommandInfo[]> {
		if (!this.session) await this.warmExtensionProviders();
		const loader = this.session?.resourceLoader ?? this.catalogLoader;
		const out: CommandInfo[] = [...BUILTIN_COMMANDS];
		const ext = loader.getExtensions();
		for (const e of ext.extensions) {
			for (const [name, cmd] of e.commands) {
				out.push({ name, description: (cmd as any)?.description ?? "", source: "extension" });
			}
		}
		for (const p of loader.getPrompts().prompts) {
			out.push({ name: p.name, description: (p as any).description ?? "prompt template", source: "prompt" });
		}
		for (const s of loader.getSkills().skills) {
			out.push({ name: `skill:${s.name}`, description: s.description, source: "skill" });
		}
		return out;
	}

	readFile(path: string): string {
		try {
			return readFileSync(path, "utf8");
		} catch (err) {
			return `Could not read file: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	// AGENTS.md memory: per-folder (cwd) or global (~/.pi/agent). pi auto-loads it each session.
	private memoryPath(cwd?: string): string {
		return join(cwd && existsSync(cwd) ? cwd : this.agentDir, "AGENTS.md");
	}
	readMemory(cwd?: string): string {
		const p = this.memoryPath(cwd);
		try {
			return existsSync(p) ? readFileSync(p, "utf8") : "";
		} catch {
			return "";
		}
	}
	writeMemory(content: string, cwd?: string): void {
		const p = this.memoryPath(cwd);
		try {
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, content, "utf8");
		} catch {
			/* ignore */
		}
	}

	// ------------------------------------------------------------- accounts

	async getAccounts(): Promise<AccountInfo[]> {
		await this.warmExtensionProviders();
		const runtime = this.session?.modelRuntime ?? await this.runtime();
		return runtime
			.getProviders()
			.filter((p) => (p.auth?.oauth && p.id !== "github-copilot") || p.id === "deepseek" || p.id === "antigravity")
			.map((p) => ({ id: p.id, name: p.name ?? p.id,
				connected: p.id === "antigravity" ? hasRelayConfiguration() : runtime.hasConfiguredAuth(p.id),
				authType: p.id === "antigravity" ? "relay" as const : p.id === "deepseek" ? "api_key" as const : "oauth" as const }));
	}

	async deleteExtension(path: string): Promise<void> {
		try {
			if (existsSync(path)) rmSync(path, { force: true });
			const disabled = this.guiSettings?.disabledExtensions ?? [];
			if (disabled.includes(path)) {
				this.setGuiSettings({ disabledExtensions: disabled.filter((p) => p !== path) });
			}
			this.providerWarmupPromise = undefined;
		} catch {
			/* ignore */
		}
	}

	async setExtensionDisabled(path: string, disabled: boolean): Promise<ResourcesPayload> {
		const target = isAbsolute(path) ? resolve(path) : path;
		const current = (this.guiSettings?.disabledExtensions ?? []).filter((p) => (isAbsolute(p) ? resolve(p) : p) !== target);
		if (disabled) current.push(path);
		this.setGuiSettings({ disabledExtensions: current });
		this.providerWarmupPromise = undefined;
		const session = this.session;
		if (session && !session.isStreaming && !session.isCompacting) {
			await this.runSessionOperation(session, () => session.reload());
			this.emitState();
		}
		return this.getResources();
	}

	async deleteSkill(filePath: string): Promise<void> {
		try {
			const dir = dirname(filePath); // skill folder containing SKILL.md
			const skillsRoot = join(this.agentDir, "skills");
			if (dir.startsWith(skillsRoot) && dir !== skillsRoot && existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			} else if (existsSync(filePath)) {
				rmSync(filePath, { force: true });
			}
			this.providerWarmupPromise = undefined;
		} catch {
			/* ignore */
		}
	}

	getAntigravitySettings() {
		return this.antigravitySettings.get();
	}

	async saveAntigravitySettings(input: AntigravitySettingsInput): Promise<{ ok: boolean; error?: string; warning?: string }> {
		try {
			await this.antigravitySettings.save(input);
			const runtime = await this.runtime();
			await runtime.setRuntimeApiKey("antigravity", "heipang-relay");
			const refreshed = await runtime.refresh({ providers: ["antigravity"], allowNetwork: true, force: true, signal: this.shutdownController.signal });
			await Promise.all(this.liveSessions().map(async (session) => {
				await session.modelRuntime.setRuntimeApiKey("antigravity", "heipang-relay");
				await session.modelRuntime.refresh({ allowNetwork: false });
			}));
			const enabled = this.settings.getEnabledModels() ?? [];
			if (enabled.length > 0) {
				this.settings.setEnabledModels([...new Set([...enabled, ...runtime.getModels("antigravity").map((model) => `antigravity/${model.id}`)])]);
				await this.settings.flush();
			}
			const error = refreshed.errors.get("antigravity");
			return error ? { ok: true, warning: "Connected, but model refresh failed. Retry from Models → Antigravity." } : { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async loginAccount(id: string): Promise<{ ok: boolean; error?: string }> {
		if (this.closing) return { ok: false, error: "The application is closing" };
		if (id === "antigravity") return { ok: false, error: "Configure the relay URL and key in Accounts." };
		if (!this.oauthBridge) return { ok: false, error: "OAuth bridge unavailable" };
		if (this.loginController) return { ok: false, error: "Another sign-in is in progress. Complete or cancel it first." };
		const controller = new AbortController();
		this.loginController = controller;
		const bridge = this.oauthBridge;
		let authUrl = "";
		try {
			const session = this.session;
			const runtime = session?.modelRuntime ?? await this.runtime();
			const authType = id === "deepseek" ? "api_key" : "oauth";
			const sessionSignal = session && this.sessionControllers.get(session)?.signal;
			const loginSignal = AbortSignal.any([controller.signal, this.shutdownController.signal, ...(sessionSignal ? [sessionSignal] : [])]);
			await runtime.login(id, authType, {
				signal: loginSignal,
				notify: (event) => {
					if (event.type === "auth_url") {
						if (event.url) {
							authUrl = event.url;
							clipboard.writeText(event.url); // login URL to clipboard
						}
						bridge.openExternal(event.url);
					}
					if (event.type === "device_code" && event.verificationUri) {
						clipboard.writeText(event.verificationUri);
						bridge.openExternal(event.verificationUri);
					}
				},
				prompt: async (prompt: AuthPrompt) => {
					const signal = prompt.signal ? AbortSignal.any([prompt.signal, loginSignal]) : loginSignal;
					if (prompt.type === "select") {
						const choice = await bridge.requestInput("select", {
							message: prompt.message,
							options: prompt.options.map((o) => ({ id: o.id, label: o.label })),
						}, { signal });
						if (choice == null) throw new Error("Sign-in cancelled");
						return choice;
					}
					const kind = prompt.type === "manual_code" ? "code" : prompt.type === "secret" ? "secret" : "prompt";
					const isCallbackPaste = prompt.type === "text" && /localhost:51121|oauth-callback/.test(prompt.placeholder ?? "");
					// Show the login URL alongside the input (it is also in the clipboard and
					// already open in the browser), but keep the input empty for the callback URL.
					const message = isCallbackPaste && authUrl
						? `${prompt.message}\n\nLogin URL (also in clipboard, opened in browser):\n${authUrl}`
						: prompt.message;
					const input = await bridge.requestInput(kind, {
						message,
						placeholder: prompt.placeholder,
					}, { signal });
					if (input == null || !input.trim()) throw new Error("Sign-in cancelled");
					const value = input.trim();
					if (id === "deepseek" && prompt.type === "secret") {
						// Verify before ModelRuntime persists the credential. Never echo a
						// rejected key or raw server response into errors or logs.
						const response = await fetch("https://api.deepseek.com/models", {
							headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
							signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
						});
						if (!response.ok) throw new Error(`DeepSeek API key verification failed (HTTP ${response.status})`);
						const catalog: any = await response.json();
						const supported = new Set(runtime.getModels("deepseek").map((model) => model.id));
						if (!Array.isArray(catalog.data) || !catalog.data.some((model: any) => supported.has(model?.id))) {
							throw new Error("No supported DeepSeek models are available for this API key");
						}
					}
					return value;
				},
			});
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		} finally {
			controller.abort();
			this.loginController = undefined;
		}
	}

	async logoutAccount(id: string): Promise<void> {
		this.shutdownController.signal.throwIfAborted();
		if (id === "antigravity") {
			this.antigravitySettings.clear();
			await (await this.runtime()).removeRuntimeApiKey(id);
			await Promise.all(this.liveSessions().map((session) => session.modelRuntime.removeRuntimeApiKey(id)));
			return;
		}
		await (this.session?.modelRuntime ?? await this.runtime()).logout(id, { signal: this.shutdownController.signal });
	}

	// --------------------------------------------------------------- usage

	private decodeJwt(token: string): any {
		try {
			const parts = token.split(".");
			if (parts.length !== 3) return null;
			const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
			const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
			return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
		} catch {
			return null;
		}
	}

	/** Live usage for the active model's provider (Claude Max / ChatGPT Codex). */
	async getUsage(force = false): Promise<UsageInfo> {
		const provider = this.session?.model?.provider ?? this.settings.getDefaultProvider();
		if (!provider) return { error: "No active provider" };
		if (provider === "deepseek") return { provider, billing: "api" };
		if (provider !== "anthropic" && provider !== "openai-codex" && provider !== "antigravity") return { provider, error: "Usage not available for this provider" };

		// Serve fresh cache without touching the network (avoids 429 from frequent polling).
		const cached = this.usageCache.get(provider);
		if (!force && cached && Date.now() - cached.ts < Driver.USAGE_TTL) return cached.value;

		// Coalesce concurrent callers (mount + stream-end + /usage can fire together).
		const inflight = this.usageInflight.get(provider);
		if (inflight) return inflight;
		const p = this.fetchUsage(provider).finally(() => this.usageInflight.delete(provider));
		this.usageInflight.set(provider, p);
		return p;
	}

	private async fetchUsage(provider: string): Promise<UsageInfo> {
		// On failure, fall back to the last known-good value (even if stale) so a
		// transient 429/network error never wipes the displayed usage.
		const stale = (error: string): UsageInfo => {
			const c = this.usageCache.get(provider);
			return c ? c.value : { provider, error };
		};
		// Friendly text for the common case: the usage endpoint is rate-limited
		// (often because another pi/terminal is also polling it).
		const httpError = (status: number) =>
			status === 429 ? "rate limited — try again in a bit" : `HTTP ${status}`;
		const ok = (value: UsageInfo): UsageInfo => {
			this.usageCache.set(provider, { ts: Date.now(), value });
			return value;
		};
		try {
			const apiKey = await this.catalog.providerApiKey(provider);
			if (!apiKey) return { provider, error: "Not signed in" };
			if (provider === "anthropic") {
				const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
					headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}`, "anthropic-beta": "oauth-2025-04-20" },
					signal: AbortSignal.timeout(10000),
				});
				if (!res.ok) return stale(httpError(res.status));
				const d: any = await res.json();
				return ok({
					provider,
					fiveHour: d.five_hour ? { pct: d.five_hour.utilization, resetsAt: d.five_hour.resets_at } : undefined,
					sevenDay: d.seven_day ? { pct: d.seven_day.utilization, resetsAt: d.seven_day.resets_at } : undefined,
				});
			}
			if (provider === "antigravity") {
				const usage = await fetchAccountUsage(apiKey);
				const allBuckets = (usage.groups ?? []).flatMap((g) => g.buckets ?? []);
				const fiveHourBucket = allBuckets.find(
					(b) => /5.*h/i.test(b.displayName) || /5.*h/i.test(b.bucketId) || b.window === "18000s",
				);
				const sevenDayBucket = allBuckets.find(
					(b) => /week|7.*d/i.test(b.displayName) || /week|7.*d/i.test(b.bucketId) || b.window === "604800s",
				);
				return ok({
					provider,
					fiveHour: fiveHourBucket
						? {
								pct: Math.max(0, Math.min(100, Math.round((1 - (fiveHourBucket.remainingFraction ?? 0)) * 100))),
								resetsAt: fiveHourBucket.resetTime ?? null,
							}
						: undefined,
					sevenDay: sevenDayBucket
						? {
								pct: Math.max(0, Math.min(100, Math.round((1 - (sevenDayBucket.remainingFraction ?? 0)) * 100))),
								resetsAt: sevenDayBucket.resetTime ?? null,
							}
						: undefined,
				});
			}
			// openai-codex
			const auth = this.decodeJwt(apiKey)?.["https://api.openai.com/auth"];
			const accountId = auth?.chatgpt_account_id;
			if (!accountId) return { provider, error: "No account id" };
			const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
				headers: { Accept: "*/*", Authorization: `Bearer ${apiKey}`, "chatgpt-account-id": accountId, originator: "pi" },
				signal: AbortSignal.timeout(10000),
			});
			if (!res.ok) return stale(httpError(res.status));
			const d: any = await res.json();
			const primary = d.rate_limit?.primary_window;
			const secondary = d.rate_limit?.secondary_window;
			const windows = [primary, secondary].filter(Boolean);
			const seconds = (w: any): number | undefined =>
				typeof w?.limit_window_seconds === "number" ? w.limit_window_seconds : undefined;
			const toUsageWindow = (w: any) => ({
				pct: Number(w.used_percent) || 0,
				resetsAt: w.reset_at
					? new Date(Number(w.reset_at) * 1000).toISOString()
					: typeof w.reset_after_seconds === "number"
						? new Date(Date.now() + w.reset_after_seconds * 1000).toISOString()
						: null,
			});

			// Codex does not guarantee that primary means 5-hour and secondary
			// means 7-day. For some plans/models (including GPT-5.6 Sol), primary
			// is itself the 7-day window and secondary is null. Classify using the
			// duration returned by the API, with positional fallback for old payloads.
			const fiveHourRaw = windows.find((w: any) => {
				const duration = seconds(w);
				return duration != null && Math.abs(duration - 5 * 3600) <= 3600;
			}) ?? (seconds(primary) == null ? primary : undefined);
			const sevenDayRaw = windows.find((w: any) => {
				const duration = seconds(w);
				return duration != null && Math.abs(duration - 7 * 86400) <= 86400;
			}) ?? (seconds(secondary) == null ? secondary : undefined);
			return ok({
				provider,
				fiveHour: fiveHourRaw ? toUsageWindow(fiveHourRaw) : undefined,
				sevenDay: sevenDayRaw ? toUsageWindow(sevenDayRaw) : undefined,
			});
		} catch (err) {
			return stale(err instanceof Error ? err.message : String(err));
		}
	}

	async openSession(path: string): Promise<OpenSessionResult> {
		this.assertSessionAvailable(undefined, path);
		const key = sessionFileKey(path);
		if (this.session?.sessionFile && sessionFileKey(this.session.sessionFile) === key) {
			this.assertSessionAvailable(this.session.sessionManager.getCwd(), path);
			this.cancelNavigation();
			return { state: this.getActiveState()!, messages: this.getMessages() };
		}
		const background = [...this.bgSessions].find(([file]) => sessionFileKey(file) === key);
		if (background) {
			const [file, entry] = background;
			const cwd = entry.session.sessionManager.getCwd();
			this.assertSessionAvailable(cwd, path);
			const sequence = this.cancelNavigation();
			const controller = new AbortController();
			this.navigation = { cwd, path, controller };
			try {
				await this.leaveCurrent();
				if (sequence !== this.navigationSequence) throw controller.signal.reason;
				this.assertSessionAvailable(cwd, path);
				if (this.reattachBackground(file)) return { state: this.getActiveState()!, messages: this.getMessages() };
			} finally {
				if (sequence === this.navigationSequence) this.navigation = undefined;
			}
		}
		return this.navigate({ path });
	}

	private cancelNavigation(): number {
		this.navigation?.controller.abort(new Error("Session navigation was superseded"));
		this.navigation = undefined;
		return ++this.navigationSequence;
	}

	private async createSession(cwd: string, controller: AbortController, sessionManager?: SessionManager) {
		const { settingsManager, resourceLoader } = await loadSessionResources(
			cwd,
			this.agentDir,
			this.oauthBridge,
			controller.signal,
			() => this.guiSettings?.disabledExtensions ?? [],
		);
		const modelRuntime = await this.createModelRuntime();
		let session: AgentSession | undefined;
		try {
			controller.signal.throwIfAborted();
			const result = await createAgentSession({
				agentDir: this.agentDir, cwd, settingsManager, resourceLoader, sessionManager, modelRuntime,
			});
			session = result.session;
			this.sessionControllers.set(session, controller);
			controller.signal.throwIfAborted();
			this.installSessionGuards(session);
			await session.bindExtensions({
				mode: "rpc",
				uiContext: this.oauthBridge ? createExtensionUI(this.oauthBridge,
					(message) => { if (this.session === session) this.onError?.(message); }, controller.signal) : undefined,
				onError: (error) => {
					const message = `${error.extensionPath}: ${error.error}`;
					const shutdownErrors = this.sessionShutdownErrors.get(session!);
					if (error.event === "session_shutdown" && shutdownErrors) shutdownErrors.push(new Error(message));
					else if (this.closing) this.shutdownErrors.push(new Error(message));
					this.onError?.(message);
				},
			});
			return result;
		} catch (error) {
			try {
				if (session) await this.releaseSession(session);
				else await modelRuntime.settleCredentialWrites();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], `${String(error)}; session cleanup failed: ${String(cleanupError)}`);
			}
			throw error;
		}
	}

	private async navigate(target: { cwd: string } | { path: string }): Promise<OpenSessionResult> {
		const path = "path" in target ? target.path : undefined;
		const key = path === undefined ? undefined : sessionFileKey(path);
		const owners = key ? [...this.sessionControllers.keys()].filter((session) => session.sessionFile && sessionFileKey(session.sessionFile) === key) : [];
		const pending = key ? [...this.pendingNavigations].filter((previous) => previous.path && sessionFileKey(previous.path) === key) : [];
		const cwd = "cwd" in target ? target.cwd : owners[0]?.sessionManager.getCwd() ?? pending.find((previous) => previous.cwd)?.cwd;
		this.assertSessionAvailable(cwd, path);
		const releases = owners.flatMap((session) => {
			const release = this.releasingSessions.get(session);
			return release ? [release] : [];
		});
		const sequence = this.cancelNavigation();
		const controller = new AbortController();
		const navigation: SessionNavigation = { cwd, path, controller };
		this.navigation = navigation;
		this.pendingNavigations.add(navigation);
		const opening = (async () => {
			if (pending.length || releases.length) {
				await Promise.all([...releases, ...pending.map(async (previous) => {
					try { await previous.opening; }
					catch (error) { if (error !== previous.controller.signal.reason) throw error; }
				})]);
			}
			controller.signal.throwIfAborted();
			this.assertSessionAvailable(cwd, path);
			if (path !== undefined && !existsSync(path)) throw new Error(`Session file no longer exists: ${path}`);
			const manager = "path" in target ? SessionManager.open(target.path) : undefined;
			const projectCwd = "cwd" in target ? target.cwd : manager!.getCwd();
			navigation.cwd = projectCwd;
			this.assertSessionAvailable(projectCwd, path);
			const { session, modelFallbackMessage } = await this.createSession(projectCwd, controller, manager);
			try {
				if (sequence !== this.navigationSequence || controller.signal.aborted) throw controller.signal.reason;
				await this.leaveCurrent();
				if (sequence !== this.navigationSequence || controller.signal.aborted) throw controller.signal.reason;
				this.assertSessionAvailable(projectCwd, path);
			} catch (error) {
				try { await this.releaseSession(session); }
				catch (cleanupError) {
					throw new AggregateError([error, cleanupError], `${String(error)}; session cleanup failed: ${String(cleanupError)}`);
				}
				throw error;
			}
			this.session = session;
			this.activeCwd = projectCwd;
			this.wireSession();
			this.tasksFor();
			this.scheduleAutoExtract();
			this.invalidateSessionList();
			const messages = this.getMessages();
			this.resetMessageCursor(messages.length);
			return { state: this.getActiveState()!, messages, modelFallbackMessage };
		})();
		navigation.opening = opening;
		try {
			return await opening;
		} finally {
			this.pendingNavigations.delete(navigation);
			if (this.navigation === navigation) this.navigation = undefined;
		}
	}

	private installSessionGuards(session: AgentSession): void {
		const sessionSignal = this.sessionControllers.get(session)!.signal;
		const promptContext = new AsyncLocalStorage<AbortSignal>();
		const dispose = session.dispose.bind(session);
		session.dispose = () => {
			try { dispose(); }
			finally { promptContext.disable(); }
		};
		let promptController = new AbortController();
		const abort = session.abort.bind(session);
		session.abort = async () => {
			promptController.abort(new Error("The prompt was stopped"));
			promptController = new AbortController();
			const errors: unknown[] = [];
			try { session.clearQueue(); }
			catch (error) { errors.push(error); }
			try { await abort(); }
			catch (error) { errors.push(error); }
			if (errors.length === 1) throw errors[0];
			if (errors.length) throw new AggregateError(errors, `Could not stop session: ${errors.map(String).join("; ")}`);
		};
		const prompt = session.prompt.bind(session);
		session.prompt = async (...args) => {
			sessionSignal.throwIfAborted();
			const signal = promptContext.getStore() ?? AbortSignal.any([sessionSignal, promptController.signal]);
			if (signal.aborted) return;
			return this.runSessionOperation(session, () => promptContext.run(signal, async () => {
				if (!signal.aborted) await prompt(...args);
			}));
		};
		// The pinned SDK has no public cancellation boundary after input hooks or authentication.
		const preparation = session as unknown as Record<"_preparePrompt" | "_runInputHandlers", (...args: unknown[]) => Promise<unknown>>;
		for (const name of ["_preparePrompt", "_runInputHandlers"] as const) {
			const prepare = preparation[name].bind(session);
			preparation[name] = async (...args) => {
				const signal = promptContext.getStore();
				sessionSignal.throwIfAborted();
				if (signal?.aborted) return undefined;
				const result = await prepare(...args);
				sessionSignal.throwIfAborted();
				return signal?.aborted ? undefined : result;
			};
		}
		const previousTransform = session.agent.transformContext;
		session.agent.transformContext = async (messages, signal) => {
			const promptSignal = promptContext.getStore();
			const ownedSignal = AbortSignal.any([sessionSignal, ...(signal ? [signal] : []), ...(promptSignal ? [promptSignal] : [])]);
			ownedSignal.throwIfAborted();
			const transformed = previousTransform ? await previousTransform(messages, ownedSignal) : messages;
			ownedSignal.throwIfAborted();
			return guardManyImageContext(transformed);
		};

		// Provider SDK retries are opaque to AgentSession. In particular, the
		// Anthropic SDK sleeps for Retry-After without observing AbortSignal; a
		// five-hour usage-limit response can therefore make Stop wait for hours.
		// Let AgentSession perform retries instead: its backoff is abortable and is
		// already surfaced in the GUI.
		const previousStream = session.agent.streamFunction;
		session.agent.streamFunction = (model: any, context: any, options: any) => {
			sessionSignal.throwIfAborted();
			const promptSignal = promptContext.getStore();
			promptSignal?.throwIfAborted();
			const idleAbort = model.provider === "openai-codex" ? new AbortController() : undefined;
			const signal = AbortSignal.any([sessionSignal, ...(options?.signal ? [options.signal] : []),
				...(promptSignal ? [promptSignal] : []), ...(idleAbort ? [idleAbort.signal] : [])]);
			const requestOptions = {
				...options, signal, maxRetries: 0,
				// Idle timeouts, not a total duration limit: active long answers can
				// continue. A broken socket must not hold the session for 40 minutes.
				timeoutMs: model.provider === "openai-codex" ? 120_000 : options?.timeoutMs,
				websocketConnectTimeoutMs: model.provider === "openai-codex" ? 5_000 : options?.websocketConnectTimeoutMs,
				headers: { ...options?.headers, ...this.anthropicClientHeaders(model) },
			};
			return measuredStream(previousStream(model, context, requestOptions), model, requestOptions,
				join(this.agentDir, "heipang-request-timings.jsonl"), idleAbort, options?.signal);
		};
		// Also cap provider-requested backoff so a long Retry-After cannot pin the UI.
		session.agent.maxRetryDelayMs = 30_000;

		// pi has no PDF content type: attachments ride along as images, which every
		// provider rejects for application/pdf. Rewrite them on the way out.
		const previousPayload = session.agent.onPayload;
		session.agent.onPayload = async (payload: any, model: any) => {
			const upstream = previousPayload ? await previousPayload(payload, model) : undefined;
			const current = upstream ?? payload;
			return convertPdfAttachments(current, model?.api) ?? upstream;
		};
	}

	async newSession(cwd?: string): Promise<OpenSessionResult> {
		return this.navigate({ cwd: cwd && existsSync(cwd) ? cwd : homedir() });
	}

	async ensureSession(): Promise<void> {
		this.assertSessionAvailable();
		if (this.navigation?.opening) await this.navigation.opening;
		else if (!this.session) await this.newSession();
	}

	// ------------------------------------------------------------- messaging

	async sendMessage(text: string, images?: { data: string; mimeType: string; name?: string }[], expectedSessionId = this.session?.sessionId ?? null): Promise<void> {
		this.assertSessionAvailable();
		if (expectedSessionId !== (this.session?.sessionId ?? null)) throw new Error("The selected session has changed. Reopen it before sending.");
		await this.ensureSession();
		if (!this.session) throw new Error("No active session");
		if (expectedSessionId && expectedSessionId !== this.session.sessionId) throw new Error("The selected session has changed. Reopen it before sending.");
		this.assertSessionAvailable(this.session.sessionManager.getCwd(), this.session.sessionFile);
		if (this.session.model?.id === "deepseek-v4-pro" && images?.length) {
			throw new Error("DeepSeek V4 Pro is text-only. Use a vision-capable model for images or PDF attachments.");
		}
		this.clearGuiRetry(this.session.sessionId);
		const imgs = images?.length
			? images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType, name: i.name }))
			: undefined;
		const session = this.session;
		const signal = this.sessionControllers.get(session)!.signal;
		this.markRunStart(session);
		if (session.isStreaming) {
			await session.prompt(text, { streamingBehavior: "followUp", images: imgs });
		} else {
			void session.prompt(text, imgs ? { images: imgs } : undefined).catch((error) => {
				if (!signal.aborted || error !== signal.reason) this.onError?.(error instanceof Error ? error.message : String(error));
			});
		}
	}

	async abort(): Promise<void> {
		const session = this.session;
		if (!session) return;
		// Set the latch before aborting: agent_end/auto_retry_start may be emitted
		// during abort and must not resurrect the run.
		this.cancelledRuns.add(session.sessionId);
		this.clearGuiRetry(session.sessionId);
		session.abortRetry();
		await session.abort();
		// Covers a retry created by an agent_end handler racing with abort().
		session.abortRetry();
		this.markRunEnd(session);
		this.emitState();
	}

	async setModel(provider: string, id: string): Promise<ActiveState> {
		await this.ensureSession();
		const session = this.session;
		if (!session) throw new Error("No active session");
		this.assertSessionAvailable(session.sessionManager.getCwd(), session.sessionFile);
		const signal = this.sessionControllers.get(session)!.signal;
		signal.throwIfAborted();
		return this.runSessionOperation(session, async () => {
			const runtime = session.modelRuntime;
			await runtime.refresh({ allowNetwork: false, signal });
			signal.throwIfAborted();
			const model = runtime.getModel(provider, id) as AnyModel | undefined;
			if (!model) throw new Error(`Model not found: ${provider}/${id}`);
			if (provider === "deepseek" && !runtime.hasConfiguredAuth(provider)) {
				const connected = await this.loginAccount(provider);
				signal.throwIfAborted();
				if (!connected.ok) throw new Error(connected.error ?? "DeepSeek API key is required");
			}
			const previousThinking = session.thinkingLevel;
			await session.setModel(model);
			signal.throwIfAborted();
			if (provider === "deepseek" && !getSupportedThinkingLevels(model).includes(previousThinking as any)) {
				// DeepSeek's default is high. Do not silently turn Claude/GPT xhigh into
				// DeepSeek max, which is substantially more expensive in reasoning time.
				session.setThinkingLevel("high");
			}
			this.contextCache = undefined;
			this.emitState();
			return this.getActiveState()!;
		});
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<ActiveState> {
		await this.ensureSession();
		this.session!.setThinkingLevel(level);
		this.emitState();
		return this.getActiveState()!;
	}

}
