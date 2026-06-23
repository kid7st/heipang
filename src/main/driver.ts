import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	AgentSession,
	AuthStorage,
	calculateContextTokens,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { completeSimple, type Model } from "@mariozechner/pi-ai";
import type {
	AccountInfo,
	ActiveState,
	CommandInfo,
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
	WorkspaceInfo,
} from "../shared/types.js";

export interface OAuthBridge {
	openExternal: (url: string) => void;
	requestInput: (kind: string, payload: unknown) => Promise<string | undefined>;
}

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
	sidebarCollapsed: false,
};

const MAX_TASK_LEN = 20;
function capTitle(s: string): string {
	const t = s.trim().replace(/\s+/g, " ");
	return t.length > MAX_TASK_LEN ? t.slice(0, MAX_TASK_LEN) : t;
}

type AnyModel = Model<any>;

/**
 * Owns all pi SDK state in the main process. One driver per app.
 * Heavy work (parsing big session files, registry refresh) happens here so the
 * renderer never blocks.
 */
export class Driver {
	readonly agentDir: string;
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;
	private settings: SettingsManager;

	private resourceLoader: DefaultResourceLoader;
	private guiSettings: GuiSettings;

	private session?: AgentSession;
	private activeCwd = "";
	private unsubscribe?: () => void;

	// task state for the active session
	private savedTasks: Task[] = [];
	private taskCounter = 0;
	private extractTimer?: ReturnType<typeof setTimeout>;
	private extracting = false;
	private lastExtractUserCount = -1;
	oauthBridge?: OAuthBridge;

	private sentUiCount = 0;
	private msgFlushTimer?: ReturnType<typeof setTimeout>;

	// live-usage cache (the upstream usage endpoints rate-limit aggressively → 429)
	private usageCache = new Map<string, { ts: number; value: UsageInfo }>();
	private usageInflight = new Map<string, Promise<UsageInfo>>();
	private static readonly USAGE_TTL = 60_000;

	private onMessages?: (messages: UIMessage[]) => void;
	private onMessagesPatch?: (from: number, messages: UIMessage[]) => void;
	private onState?: (state: ActiveState) => void;
	private onTasks?: (tasks: Task[]) => void;
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

	constructor() {
		this.agentDir = getAgentDir();
		const authPath = join(this.agentDir, "auth.json");
		const modelsPath = join(this.agentDir, "models.json");
		this.authStorage = AuthStorage.create(authPath);
		this.modelRegistry = ModelRegistry.create(this.authStorage, modelsPath);
		this.settings = SettingsManager.create(homedir(), this.agentDir);
		this.resourceLoader = new DefaultResourceLoader({
			cwd: homedir(),
			agentDir: this.agentDir,
			settingsManager: this.settings,
		});
		this.guiSettings = this.loadGuiSettings();
	}

	setHandlers(handlers: {
		onMessages: (messages: UIMessage[]) => void;
		onMessagesPatch: (from: number, messages: UIMessage[]) => void;
		onState: (state: ActiveState) => void;
		onTasks: (tasks: Task[]) => void;
		onRunComplete: (path?: string) => void;
		onError: (message: string) => void;
		onBackground?: (sessions: { path: string; cwd: string }[]) => void;
	}): void {
		this.onMessages = handlers.onMessages;
		this.onMessagesPatch = handlers.onMessagesPatch;
		this.onState = handlers.onState;
		this.onTasks = handlers.onTasks;
		this.onRunComplete = handlers.onRunComplete;
		this.onError = handlers.onError;
		this.onBackground = handlers.onBackground;
	}

	// --------------------------------------------------------- resources/settings

	async getResources(): Promise<ResourcesPayload> {
		await this.resourceLoader.reload();
		const ext = this.resourceLoader.getExtensions();
		const skillsRes = this.resourceLoader.getSkills();
		const errByPath = new Map(ext.errors.map((e) => [e.path, e.error]));
		return {
			extensions: ext.extensions.map((e) => ({
				name: basename(e.path).replace(/\.[tj]s$/, ""),
				path: e.path,
				tools: [...e.tools.keys()],
				commands: [...e.commands.keys()],
				error: errByPath.get(e.path),
			})).concat(
				ext.errors
					.filter((er) => !ext.extensions.some((e) => e.path === er.path))
					.map((er) => ({ name: basename(er.path).replace(/\.[tj]s$/, ""), path: er.path, tools: [], commands: [], error: er.error })),
			),
			skills: skillsRes.skills.map((s) => ({ name: s.name, description: s.description, filePath: s.filePath })),
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
		return this.getPiSettings();
	}

	private guiSettingsPath(): string {
		return join(this.agentDir, ".pi-gui.json");
	}
	private loadGuiSettings(): GuiSettings {
		try {
			const raw = JSON.parse(readFileSync(this.guiSettingsPath(), "utf8"));
			return { ...DEFAULT_GUI_SETTINGS, ...raw };
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

	private modelToInfo(m: AnyModel): ModelInfo {
		return {
			provider: m.provider,
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			hasAuth: this.modelRegistry.hasConfiguredAuth(m),
		};
	}

	async listModels(): Promise<ModelsPayload> {
		await this.settings.reload();
		this.modelRegistry.refresh();
		const all = this.modelRegistry.getAll().map((m) => this.modelToInfo(m));
		const available = this.modelRegistry.getAvailable().map((m) => this.modelToInfo(m));
		return {
			all,
			available,
			enabled: this.settings.getEnabledModels() ?? [],
			defaultProvider: this.settings.getDefaultProvider(),
			defaultModel: this.settings.getDefaultModel(),
			defaultThinkingLevel: this.settings.getDefaultThinkingLevel(),
		};
	}

	private readModelsJson(): any {
		const p = join(this.agentDir, "models.json");
		if (!existsSync(p)) return { providers: {} };
		try {
			const data = JSON.parse(readFileSync(p, "utf8"));
			if (!data.providers) data.providers = {};
			return data;
		} catch {
			return { providers: {} };
		}
	}

	private writeModelsJson(data: any): void {
		const p = join(this.agentDir, "models.json");
		writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		this.modelRegistry.refresh();
	}

	async addModels(models: NewModelInput[]): Promise<ModelsPayload> {
		const data = this.readModelsJson();
		for (const m of models) {
			if (!data.providers[m.provider]) data.providers[m.provider] = { models: [] };
			const prov = data.providers[m.provider];
			if (!Array.isArray(prov.models)) prov.models = [];
			const idx = prov.models.findIndex((x: any) => x.id === m.id);
			const entry: any = {
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				input: ["text", "image"],
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			// Provider-specific wiring so new models work AND xhigh stays selectable.
			if (m.provider === "anthropic" && m.reasoning) {
				entry.thinkingLevelMap = { xhigh: "xhigh" };
			} else if (m.provider === "openai-codex") {
				entry.api = "openai-codex-responses";
				entry.baseUrl = "https://chatgpt.com/backend-api";
				if (m.reasoning) entry.thinkingLevelMap = { off: null, xhigh: "xhigh" };
			}
			if (idx >= 0) prov.models[idx] = { ...prov.models[idx], ...entry };
			else prov.models.push(entry);
		}
		this.writeModelsJson(data);
		return this.listModels();
	}

	async removeModel(provider: string, id: string): Promise<ModelsPayload> {
		const data = this.readModelsJson();
		const prov = data.providers?.[provider];
		if (prov?.models) {
			prov.models = prov.models.filter((x: any) => x.id !== id);
		}
		this.writeModelsJson(data);
		// also drop from enabled
		const enabled = (this.settings.getEnabledModels() ?? []).filter((e) => e !== `${provider}/${id}`);
		this.settings.setEnabledModels(enabled);
		await this.settings.flush();
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

	/** R2: hit Anthropic OAuth /v1/models to list account-available model IDs. */
	async fetchRemoteModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }> {
		try {
			const token = await this.authStorage.getApiKey("anthropic");
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
			const json = (await res.json()) as { data?: Array<{ id: string; display_name?: string; created_at?: string }> };
			const existing = new Set(this.modelRegistry.getAll().filter((m) => m.provider === "anthropic").map((m) => m.id));
			const models: RemoteModel[] = (json.data ?? []).map((d) => ({
				id: d.id,
				display_name: d.display_name ?? d.id,
				created_at: d.created_at,
				alreadyAdded: existing.has(d.id),
			}));
			return { ok: true, models };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	// -------------------------------------------------------------- sessions

	private archiveDir(): string {
		return join(this.agentDir, "sessions-archived");
	}

	async archiveSession(path: string): Promise<void> {
		if (!existsSync(path)) return;
		const sessionsRoot = join(this.agentDir, "sessions");
		const rel = path.startsWith(sessionsRoot) ? path.slice(sessionsRoot.length + 1) : basename(path);
		const dest = join(this.archiveDir(), rel);
		mkdirSync(dirname(dest), { recursive: true });
		renameSync(path, dest);
		if (this.session?.sessionFile === path) this.disposeSession();
		this.killBackground(path);
	}

	/** Stop + drop a background run (used when its session is deleted/archived). */
	private killBackground(path: string): void {
		const entry = this.bgSessions.get(path);
		if (!entry) return;
		this.bgSessions.delete(path);
		entry.unsubscribe();
		entry.session.abort().catch(() => {});
		entry.session.dispose();
		this.emitBackground();
	}

	async deleteSession(path: string): Promise<void> {
		if (existsSync(path)) rmSync(path, { force: true });
		if (this.session?.sessionFile === path) this.disposeSession();
		this.killBackground(path);
	}

	/** Delete every session belonging to a workspace (cwd), then prune the empty dir. */
	async deleteFolder(cwd: string): Promise<void> {
		const infos = await SessionManager.listAll();
		const dirs = new Set<string>();
		for (const s of infos) {
			if (s.cwd === cwd) {
				if (this.session?.sessionFile === s.path) this.disposeSession();
				this.killBackground(s.path);
				if (existsSync(s.path)) {
					dirs.add(dirname(s.path));
					rmSync(s.path, { force: true });
				}
				const sidecar = `${s.path}.tasks.json`;
				if (existsSync(sidecar)) rmSync(sidecar, { force: true });
			}
		}
		// prune now-empty workspace dirs
		for (const d of dirs) {
			try {
				if (existsSync(d) && readdirSync(d).length === 0) rmSync(d, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}

	async renameSession(path: string, name: string): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed) return;
		if (this.session?.sessionFile === path) {
			this.session.setSessionName(trimmed);
			this.emitState();
			return;
		}
		const bg = this.bgSessions.get(path);
		if (bg) {
			bg.session.setSessionName(trimmed);
			return;
		}
		try {
			const sm = SessionManager.open(path);
			sm.appendSessionInfo(trimmed);
		} catch {
			/* ignore */
		}
	}

	async listSessions(): Promise<SessionListItem[]> {
		const infos = await SessionManager.listAll();
		return infos.map((s) => ({
			path: s.path,
			id: s.id,
			cwd: s.cwd,
			name: s.name,
			created: s.created.getTime(),
			modified: s.modified.getTime(),
			messageCount: s.messageCount,
			firstMessage: s.firstMessage,
			allMessagesText: s.allMessagesText,
		}));
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
		const msgs = this.session.messages as any[];
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === "assistant" && msgs[i].usage) {
				const tokens = calculateContextTokens(msgs[i].usage);
				return Math.min(100, Math.round((tokens / this.session.model.contextWindow) * 100));
			}
		}
		return 0;
	}

	getActiveState(): ActiveState | null {
		if (!this.session) return null;
		const m = this.session.model;
		return {
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			sessionName: this.session.sessionName,
			cwd: this.activeCwd,
			model: m ? { provider: m.provider, id: m.id, name: m.name } : undefined,
			thinkingLevel: this.session.thinkingLevel as ThinkingLevel,
			isStreaming: this.session.isStreaming,
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

	getMessages(): UIMessage[] {
		if (!this.session) return [];
		return this.toUIMessages(this.session.messages);
	}

	// ------------------------------------------------------ session lifecycle

	private wireSession(): void {
		if (!this.session) return;
		this.unsubscribe = this.session.subscribe((event) => {
			switch (event.type) {
				case "message_start":
				case "message_update":
				case "turn_end":
					this.scheduleEmit();
					this.emitState();
					break;
				case "message_end":
					this.flushEmit();
					this.emitState();
					break;
				case "agent_end":
					this.markRunEnd(this.session);
					this.flushEmit();
					this.emitState();
					this.scheduleAutoExtract();
					this.onRunComplete?.(this.session?.sessionFile);
					break;
				case "auto_retry_start":
					this.onError?.(`Auto-retry: ${event.errorMessage}`);
					this.emitState();
					break;
				case "compaction_start":
				case "compaction_end":
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
		const ui = this.toUIMessages(this.session.messages);
		if (ui.length < this.sentUiCount) {
			this.sentUiCount = ui.length;
			this.onMessages?.(ui); // shrank (compaction/branch) — full resync
			return;
		}
		const from = Math.max(0, this.sentUiCount - 1);
		this.sentUiCount = ui.length;
		this.onMessagesPatch?.(from, ui.slice(from));
	}

	private emitState(): void {
		const s = this.getActiveState();
		if (s) this.onState?.(s);
	}

	private disposeSession(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session?.dispose();
		this.session = undefined;
		this.clearSessionUiState();
	}

	/** Reset the per-session UI bookkeeping WITHOUT touching the session object. */
	private clearSessionUiState(): void {
		this.savedTasks = [];
		this.taskCounter = 0;
		this.lastExtractUserCount = -1;
		this.sentUiCount = 0;
		if (this.extractTimer) clearTimeout(this.extractTimer);
		this.extractTimer = undefined;
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
	private leaveCurrent(): void {
		if (!this.session) return;
		const file = this.session.sessionFile;
		if (this.session.isStreaming && file && !this.bgSessions.has(file)) {
			const session = this.session;
			const cwd = this.activeCwd;
			// drop the UI-coupled subscription; attach a minimal background one
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			const unsub = session.subscribe((event) => {
				if (event.type === "agent_end") {
					this.markRunEnd(session);
					this.finishBackground(file);
				}
			});
			this.bgSessions.set(file, { session, unsubscribe: unsub, cwd });
			this.session = undefined;
			this.clearSessionUiState();
			this.emitBackground();
		} else {
			this.disposeSession();
		}
	}

	/** A background run finished: notify (green dot / desktop ping) and free it. */
	private finishBackground(file: string): void {
		const entry = this.bgSessions.get(file);
		if (!entry) return;
		this.bgSessions.delete(file);
		entry.unsubscribe();
		entry.session.dispose();
		this.onRunComplete?.(file);
		this.emitBackground();
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
		this.loadTasks();
		this.scheduleAutoExtract();
		const messages = this.getMessages();
		this.sentUiCount = messages.length;
		this.emitBackground();
		return true;
	}

	// ----------------------------------------------------------------- tasks
	//
	// Tasks are CONCEPTS (small projects / informal requests), not per-message.
	// A fast LLM summarizes the conversation into a short list of distinct tasks.
	// Status is set by the human only; we never auto-decide done/cancelled.

	private taskSidecar(): string | undefined {
		const f = this.session?.sessionFile;
		return f ? `${f}.tasks.json` : undefined;
	}

	private loadTasks(): void {
		this.savedTasks = [];
		this.taskCounter = 0;
		const p = this.taskSidecar();
		if (!p || !existsSync(p)) return;
		try {
			const raw = JSON.parse(readFileSync(p, "utf8"));
			if (Array.isArray(raw.tasks)) this.savedTasks = raw.tasks;
			if (typeof raw.counter === "number") this.taskCounter = raw.counter;
		} catch {
			/* ignore */
		}
		// migrate away old per-message tasks (id u*) and cap any long titles
		const before = this.savedTasks.length;
		this.savedTasks = this.savedTasks.filter((t) => !t.id.startsWith("u")).map((t) => ({ ...t, title: capTitle(t.title) }));
		if (this.savedTasks.length !== before) this.persistTasks();
	}

	private persistTasks(): void {
		const p = this.taskSidecar();
		if (!p) return;
		try {
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, `${JSON.stringify({ tasks: this.savedTasks, counter: this.taskCounter }, null, 2)}\n`, "utf8");
		} catch {
			/* ignore */
		}
	}

	getTasks(): Task[] {
		return [...this.savedTasks];
	}

	updateTask(task: Task): Task[] {
		const idx = this.savedTasks.findIndex((t) => t.id === task.id);
		if (idx >= 0) this.savedTasks[idx] = { ...this.savedTasks[idx], ...task, updatedAt: Date.now() };
		this.persistTasks();
		return this.getTasks();
	}

	deleteTask(id: string): Task[] {
		this.savedTasks = this.savedTasks.filter((t) => t.id !== id);
		this.persistTasks();
		return this.getTasks();
	}

	private scheduleAutoExtract(): void {
		if (!this.guiSettings.autoExtractTasks) return;
		if (this.extractTimer) clearTimeout(this.extractTimer);
		this.extractTimer = setTimeout(() => {
			this.extractTasks(false)
				.then((r) => {
					if (r.ok && r.tasks) this.onTasks?.(r.tasks);
				})
				.catch(() => {});
		}, 1500);
	}

	private pickExtractionModel(): Model<any> | undefined {
		const avail = this.modelRegistry.getAvailable();
		const haikus = avail.filter((m) => m.provider === "anthropic" && m.id.includes("haiku"));
		// Prefer a CURRENT haiku (4.x). The old claude-3-5-haiku-* is end-of-life and
		// silently returns empty content, which made task extraction produce nothing.
		const haiku =
			haikus.find((m) => /haiku-4/.test(m.id)) || haikus.find((m) => m.id === "claude-3-5-haiku-latest");
		if (haiku) return haiku;
		if (this.session?.model) return this.session.model; // fall back to the active model (works fine)
		return avail[0];
	}

	private norm(s: string): string {
		return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
	}

	/** Summarize the conversation into concept-level tasks via a fast LLM. */
	async extractTasks(force = true): Promise<{ ok: boolean; tasks?: Task[]; error?: string }> {
		if (!this.session) return { ok: false, error: "No active session" };
		if (this.extracting) return { ok: true, tasks: this.getTasks() };
		const sid = this.session.sessionId;
		const msgs = this.session.messages as any[];
		// Token guard: auto-runs only when a NEW user turn appeared since last extraction.
		const userCount = msgs.filter((m) => m.role === "user").length;
		if (!force && userCount === this.lastExtractUserCount) return { ok: true, tasks: this.getTasks() };
		const model = this.pickExtractionModel();
		if (!model) return { ok: false, error: "No model available for extraction" };

		const lines: string[] = [];
		for (const m of msgs) {
			if (m.role === "user") {
				const t = typeof m.content === "string" ? m.content : (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
				if (t.trim()) lines.push(`USER: ${t.trim().slice(0, 600)}`);
			} else if (m.role === "assistant") {
				const t = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
				if (t.trim()) lines.push(`ASSISTANT: ${t.trim().slice(0, 300)}`);
			}
		}
		if (lines.length === 0) return { ok: true, tasks: this.getTasks() };
		let transcript = "";
		for (let i = lines.length - 1; i >= 0; i--) {
			if (transcript.length + lines[i].length > 16000) break;
			transcript = `${lines[i]}\n${transcript}`;
		}

		const existingOpen = this.savedTasks.filter((t) => t.status === "open").map((t) => t.title);
		const sys =
			"You extract a short reminder list of distinct TASKS (small projects or informal requests the user raised) from a conversation. " +
			"Group multiple turns about the same thing into ONE task. Each task title MUST be an ultra-short reminder of at most 20 characters (count CJK characters as 1 each), a noun phrase in the user's own language, NOT a sentence or quote. " +
			"Example good titles: '图片归类', '加外链', 'fix login bug'. Ignore chit-chat and clarifications. Return STRICT JSON only: {\"tasks\":[\"title\", ...]}. No prose.";
		const user =
			(existingOpen.length
				? `Existing open tasks (reuse wording if the same task still applies):\n${existingOpen.map((t) => `- ${t}`).join("\n")}\n\n`
				: "") + `Conversation:\n${transcript}`;

		this.extracting = true;
		try {
			const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return { ok: false, error: auth.error };
			const result = await completeSimple(
				model,
				{ systemPrompt: sys, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1024 },
			);
			const text = (result.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
			// Bail out if the user switched sessions while we were summarizing, so we
			// never write/show one session's tasks under another.
			if (!this.session || this.session.sessionId !== sid) return { ok: false, error: "session changed" };
			this.lastExtractUserCount = userCount;
			const titles = this.parseTaskTitles(text);
			if (titles.length === 0) return { ok: true, tasks: this.getTasks() };
			this.reconcileTasks(titles);
			return { ok: true, tasks: this.getTasks() };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		} finally {
			this.extracting = false;
		}
	}

	private parseTaskTitles(text: string): string[] {
		let jsonStr = text.trim();
		const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fence) jsonStr = fence[1].trim();
		const brace = jsonStr.indexOf("{");
		const lastBrace = jsonStr.lastIndexOf("}");
		if (brace >= 0 && lastBrace > brace) jsonStr = jsonStr.slice(brace, lastBrace + 1);
		try {
			const parsed = JSON.parse(jsonStr);
			const arr = Array.isArray(parsed) ? parsed : parsed.tasks;
			if (!Array.isArray(arr)) return [];
			return arr
				.map((x) => (typeof x === "string" ? x : x?.title))
				.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
				.map((s) => capTitle(s));
		} catch {
			return [];
		}
	}

	/** Rebuild the OPEN frontier from extracted titles; preserve human decisions + manual tasks. */
	private reconcileTasks(titles: string[]): void {
		const now = Date.now();
		const preserved = this.savedTasks.filter((t) => t.status !== "open" || t.sourceIndex === -1);
		const preservedNorms = new Set(preserved.map((t) => this.norm(t.title)));
		const openByNorm = new Map(
			this.savedTasks.filter((t) => t.status === "open" && t.sourceIndex !== -1).map((t) => [this.norm(t.title), t]),
		);
		const next: Task[] = [...preserved];
		const seen = new Set<string>();
		for (const title of titles) {
			const n = this.norm(title);
			if (!n || seen.has(n) || preservedNorms.has(n)) continue;
			seen.add(n);
			const existing = openByNorm.get(n);
			if (existing) next.push(existing);
			else next.push({ id: `a${++this.taskCounter}`, title: capTitle(title), status: "open", sourceIndex: 0, createdAt: now, updatedAt: now });
		}
		this.savedTasks = next;
		this.persistTasks();
	}

	// ------------------------------------------------------ commands / workspaces

	async getCommands(): Promise<CommandInfo[]> {
		await this.resourceLoader.reload();
		const out: CommandInfo[] = [...BUILTIN_COMMANDS];
		const ext = this.resourceLoader.getExtensions();
		for (const e of ext.extensions) {
			for (const [name, cmd] of e.commands) {
				out.push({ name, description: (cmd as any)?.description ?? "", source: "extension" });
			}
		}
		for (const p of this.resourceLoader.getPrompts().prompts) {
			out.push({ name: p.name, description: (p as any).description ?? "prompt template", source: "prompt" });
		}
		for (const s of this.resourceLoader.getSkills().skills) {
			out.push({ name: `skill:${s.name}`, description: s.description, source: "skill" });
		}
		return out;
	}

	async listWorkspaces(): Promise<WorkspaceInfo[]> {
		const infos = await SessionManager.listAll();
		const map = new Map<string, WorkspaceInfo>();
		for (const s of infos) {
			if (!s.cwd) continue;
			const cur = map.get(s.cwd);
			const lu = s.modified.getTime();
			if (!cur) map.set(s.cwd, { cwd: s.cwd, name: basename(s.cwd) || s.cwd, lastUsed: lu });
			else if (lu > cur.lastUsed) cur.lastUsed = lu;
		}
		return [...map.values()].sort((a, b) => b.lastUsed - a.lastUsed);
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
		const providers = this.authStorage.getOAuthProviders();
		return providers
			.filter((p) => p.id !== "github-copilot") // not used here
			.map((p) => ({ id: p.id, name: p.name, connected: this.authStorage.hasAuth(p.id) }));
	}

	async deleteExtension(path: string): Promise<void> {
		try {
			if (existsSync(path)) rmSync(path, { force: true });
			await this.resourceLoader.reload();
		} catch {
			/* ignore */
		}
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
			await this.resourceLoader.reload();
		} catch {
			/* ignore */
		}
	}

	async loginAccount(id: string): Promise<{ ok: boolean; error?: string }> {
		if (!this.oauthBridge) return { ok: false, error: "OAuth bridge unavailable" };
		const bridge = this.oauthBridge;
		try {
			await this.authStorage.login(id, {
				onAuth: (info) => bridge.openExternal(info.url),
				onPrompt: async (prompt) => (await bridge.requestInput("prompt", prompt)) ?? "",
				onManualCodeInput: async () => (await bridge.requestInput("code", { message: "Paste the authorization code" })) ?? "",
				onSelect: async (prompt) => bridge.requestInput("select", prompt),
				onProgress: () => {},
			});
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	logoutAccount(id: string): void {
		this.authStorage.logout(id);
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
	async getUsage(): Promise<UsageInfo> {
		const provider = this.session?.model?.provider ?? this.settings.getDefaultProvider();
		if (!provider) return { error: "No active provider" };
		if (provider !== "anthropic" && provider !== "openai-codex") return { provider, error: "Usage not available for this provider" };

		// Serve fresh cache without touching the network (avoids 429 from frequent polling).
		const cached = this.usageCache.get(provider);
		if (cached && Date.now() - cached.ts < Driver.USAGE_TTL) return cached.value;

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
			const apiKey = await this.authStorage.getApiKey(provider);
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
			const p = d.rate_limit?.primary_window;
			const s = d.rate_limit?.secondary_window;
			return ok({
				provider,
				fiveHour: p ? { pct: p.used_percent, resetsAt: p.reset_at ? new Date(p.reset_at * 1000).toISOString() : null } : undefined,
				sevenDay: s ? { pct: s.used_percent, resetsAt: s.reset_at ? new Date(s.reset_at * 1000).toISOString() : null } : undefined,
			});
		} catch (err) {
			return stale(err instanceof Error ? err.message : String(err));
		}
	}

	async openSession(path: string): Promise<OpenSessionResult> {
		// Returning to a session that's still running in the background: re-attach
		// to the live run instead of reloading a stale copy from disk.
		if (this.bgSessions.has(path)) {
			this.leaveCurrent();
			if (this.reattachBackground(path)) {
				return { state: this.getActiveState()!, messages: this.getMessages() };
			}
		}
		this.leaveCurrent();
		const sessionManager = SessionManager.open(path);
		const { session, modelFallbackMessage } = await createAgentSession({
			agentDir: this.agentDir,
			cwd: sessionManager.getCwd(),
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			settingsManager: this.settings,
			resourceLoader: this.resourceLoader,
			sessionManager,
		});
		this.session = session;
		this.activeCwd = sessionManager.getCwd();
		this.wireSession();
		this.loadTasks();
		this.scheduleAutoExtract();
		const messages = this.getMessages();
		this.sentUiCount = messages.length;
		return { state: this.getActiveState()!, messages, modelFallbackMessage };
	}

	async newSession(cwd?: string): Promise<OpenSessionResult> {
		this.leaveCurrent();
		const workdir = cwd && existsSync(cwd) ? cwd : homedir();
		const { session, modelFallbackMessage } = await createAgentSession({
			agentDir: this.agentDir,
			cwd: workdir,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			settingsManager: this.settings,
			resourceLoader: this.resourceLoader,
		});
		this.session = session;
		this.activeCwd = workdir;
		this.wireSession();
		this.loadTasks();
		const messages = this.getMessages();
		this.sentUiCount = messages.length;
		return { state: this.getActiveState()!, messages, modelFallbackMessage };
	}

	async ensureSession(): Promise<void> {
		if (!this.session) await this.newSession();
	}

	// ------------------------------------------------------------- messaging

	async sendMessage(text: string, images?: { data: string; mimeType: string }[]): Promise<void> {
		await this.ensureSession();
		if (!this.session) throw new Error("No active session");
		const imgs = images?.length
			? images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))
			: undefined;
		this.markRunStart(this.session);
		if (this.session.isStreaming) {
			await this.session.prompt(text, { streamingBehavior: "followUp", images: imgs });
		} else {
			// fire and forget; events drive UI. Catch to surface errors.
			this.session.prompt(text, imgs ? { images: imgs } : undefined).catch((err) => {
				this.onError?.(err instanceof Error ? err.message : String(err));
			});
		}
	}

	async abort(): Promise<void> {
		await this.session?.abort();
		this.markRunEnd(this.session);
		this.emitState();
	}

	async setModel(provider: string, id: string): Promise<ActiveState> {
		await this.ensureSession();
		const model = this.modelRegistry.find(provider, id);
		if (!model) throw new Error(`Model not found: ${provider}/${id}`);
		await this.session!.setModel(model);
		this.emitState();
		return this.getActiveState()!;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<ActiveState> {
		await this.ensureSession();
		this.session!.setThinkingLevel(level);
		this.emitState();
		return this.getActiveState()!;
	}
}
