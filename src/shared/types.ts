// Shared IPC contract types between main and renderer.
// Kept dependency-free so both sides can import without pulling in the SDK.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}
export interface ImageContent {
	// Kept as "image" for compatibility with pi's current attachment channel.
	// application/pdf is also carried here and patched into Anthropic's document
	// block by scripts/patch-pi-pdf.mjs.
	type: "image";
	data: string;
	mimeType: string;
	name?: string;
}
export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type AssistantBlock = TextContent | ThinkingContent | ToolCallContent;

export interface UIUserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}
export interface UIAssistantMessage {
	role: "assistant";
	content: AssistantBlock[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: UIUsage;
	timestamp: number;
}
export interface UIToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	timestamp: number;
}

export type UIMessage = UIUserMessage | UIAssistantMessage | UIToolResultMessage;

export interface UIUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface ImageAttachment {
	data: string; // raw base64, no data: prefix
	mimeType: string;
	name?: string;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow?: number;
	maxTokens?: number;
	hasAuth: boolean;
}

export interface ModelsPayload {
	all: ModelInfo[];
	available: ModelInfo[];
	enabled: string[]; // "provider/id"
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
}

export interface RemoteModel {
	id: string;
	display_name: string;
	created_at?: string;
	alreadyAdded: boolean;
	// Populated by the OpenAI fetch so selected models keep their catalog wiring.
	provider?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export interface NewModelInput {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

export interface SessionListItem {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: number;
	modified: number;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	// Renderer-only placeholder for a just-created session that has not shown up
	// in SessionManager.listAll() yet.
	synthetic?: boolean;
}

export type TaskStatus = "open" | "in_progress" | "done" | "declined" | "cancelled";

export interface Task {
	id: string;
	title: string;
	status: TaskStatus;
	sourceIndex: number; // index of the user message that spawned it, or -1 for manual
	createdAt: number;
	updatedAt: number;
}

export interface ExtensionItem {
	name: string;
	path: string;
	tools: string[];
	commands: string[];
	error?: string;
}

export interface SkillItem {
	name: string;
	description: string;
	filePath: string;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
}

export interface ResourcesPayload {
	extensions: ExtensionItem[];
	skills: SkillItem[];
	skillDiagnostics: ResourceDiagnostic[];
	extensionsDir: string;
	skillsDir: string;
}

export interface CommandInfo {
	name: string;
	description: string;
	source: "builtin" | "extension" | "prompt" | "skill";
}

export interface AccountInfo {
	id: string;
	name: string;
	connected: boolean;
}

export interface WorkspaceInfo {
	cwd: string;
	name: string;
	lastUsed: number;
}

export interface PiSettings {
	defaultThinkingLevel?: ThinkingLevel;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
}

export interface GuiSettings {
	autoExtractTasks: boolean;
	rightPanelOpen: boolean;
	workspaceNames: Record<string, string>;
	folderOrder: string[];
	sidebarWidth: number;
	rightPanelWidth: number;
	sidebarCollapsed: boolean;
	voicenoteWorkspace?: string; // where Meta Vincent reads recordings (default ~/Documents/meetings)
}

// -------------------------------------------------------- Meta Vincent

export type MetaStatus = "pending" | "processed" | "snoozed" | "hidden";

export interface MetaRec {
	recId: string;
	title: string;
	date: string; // YYYY-MM-DD
	time: string; // HH:MM
	notePath: string;
	status: MetaStatus;
	summary?: string; // for processed: "2 to-do · 1 idea"
	projectName?: string; // display name it was sorted into
	memory: string[]; // decisions -> Memory candidates
	todo: string[]; // action_items -> To-do candidates
	ideas: string[]; // open_questions -> Ideas candidates
}

export interface MetaProject {
	cwd: string;
	name: string;
	count: number; // inbox items sorted into it
}

export interface MetaSrc {
	recId: string;
	title: string;
	date: string;
	time: string;
	notePath: string;
}

export interface MetaInboxItem {
	text: string;
	done?: boolean;
	started?: boolean;
	src: MetaSrc;
}

export interface MetaProjectInbox {
	todo: MetaInboxItem[];
	idea: MetaInboxItem[];
	memory: MetaInboxItem[];
}

export interface MetaClassification {
	cwd?: string; // suggested project cwd, or undefined for no match
	projectName?: string;
	ideaCwds: (string | undefined)[]; // per open_question: suggested project cwd, or undefined (=> Ideas pool)
}

export interface MetaSummary {
	pending: number;
	ideas: number;
	inboxByCwd: Record<string, number>;
}

export interface MetaConfirmPayload {
	cwd: string; // target project cwd ("" if only ideas to pool)
	projectName: string;
	memory: string[];
	todo: string[];
	ideas: { text: string; cwd?: string }[]; // cwd undefined => Ideas pool
	summary: string;
}

export interface UpdateCheck {
	current: string; // installed version
	latest?: string; // remote version
	hasUpdate: boolean;
	notes?: string;
	url?: string; // platform installer url
	error?: string;
}

export interface UsageInfo {
	provider?: string;
	fiveHour?: { pct: number; resetsAt: string | null };
	sevenDay?: { pct: number; resetsAt: string | null };
	error?: string;
}

export interface ActiveState {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: { provider: string; id: string; name: string };
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isRetrying?: boolean;
	retryAttempt?: number;
	contextPct?: number; // % of the model's context window currently used
	runStartedAt?: number; // epoch ms when the current run started (survives leaving/returning)
	lastRunMs?: number; // duration of the most recent finished run
}

export interface OpenSessionResult {
	state: ActiveState;
	messages: UIMessage[];
	modelFallbackMessage?: string;
}

// Streaming events forwarded to the renderer.
export type StreamEvent =
	| { type: "messages"; messages: UIMessage[] } // full snapshot (on open / structural change)
	| { type: "patch"; from: number; messages: UIMessage[] } // incremental tail during streaming
	| { type: "state"; state: ActiveState }
	| { type: "tasks"; tasks: Task[] }
	| { type: "sessionUpdated"; path?: string } // a message was persisted; refresh the sidebar list
	| { type: "sessionDone"; path?: string }
	| { type: "background"; sessions: { path: string; cwd: string }[] } // sessions still running in the background
	| { type: "updateProgress"; phase: "download" | "install" | "relaunch" | "error"; pct?: number; message?: string }
	| { type: "error"; message: string };

export interface PiApi {
	// models
	listModels(): Promise<ModelsPayload>;
	addModels(models: NewModelInput[]): Promise<ModelsPayload>;
	removeModel(provider: string, id: string): Promise<ModelsPayload>;
	fetchRemoteModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }>;
	fetchRemoteOpenAIModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }>;
	setEnabledModels(enabled: string[]): Promise<ModelsPayload>;
	setDefaultModel(provider: string, id: string): Promise<ModelsPayload>;
	// sessions
	listSessions(): Promise<SessionListItem[]>;
	openSession(path: string): Promise<OpenSessionResult>;
	newSession(cwd?: string): Promise<OpenSessionResult>;
	// conversation
	sendMessage(text: string, images?: ImageAttachment[]): Promise<void>;
	abort(): Promise<void>;
	setModel(provider: string, id: string): Promise<ActiveState>;
	setThinkingLevel(level: ThinkingLevel): Promise<ActiveState>;
	getActiveState(): Promise<ActiveState | null>;
	getMessages(): Promise<UIMessage[]>;
	// events
	onEvent(cb: (e: StreamEvent) => void): () => void;
	// sessions mgmt
	archiveSession(path: string): Promise<void>;
	deleteSession(path: string): Promise<void>;
	deleteFolder(cwd: string): Promise<void>;
	renameSession(path: string, name: string): Promise<void>;
	// tasks
	getTasks(): Promise<Task[]>;
	updateTask(task: Task): Promise<Task[]>;
	deleteTask(id: string): Promise<Task[]>;
	extractTasks(): Promise<{ ok: boolean; tasks?: Task[]; error?: string }>;
	// commands / workspaces / accounts
	getCommands(): Promise<CommandInfo[]>;
	listWorkspaces(): Promise<WorkspaceInfo[]>;
	getAccounts(): Promise<AccountInfo[]>;
	loginAccount(id: string): Promise<{ ok: boolean; error?: string }>;
	logoutAccount(id: string): Promise<void>;
	getUsage(): Promise<UsageInfo>;
	readFile(path: string): Promise<string>;
	readMemory(cwd?: string): Promise<string>;
	writeMemory(content: string, cwd?: string): Promise<void>;
	deleteExtension(path: string): Promise<void>;
	deleteSkill(filePath: string): Promise<void>;
	onRequest(cb: (req: { id: string; kind: string; payload: any }) => void): () => void;
	respondRequest(id: string, value: string | undefined): void;
	// resources & settings
	getResources(): Promise<ResourcesPayload>;
	getPiSettings(): Promise<PiSettings>;
	setPiSettings(partial: Partial<PiSettings>): Promise<PiSettings>;
	getGuiSettings(): Promise<GuiSettings>;
	setGuiSettings(partial: Partial<GuiSettings>): Promise<GuiSettings>;
	openPath(path: string): Promise<void>;
	// updates
	getVersion(): Promise<string>;
	checkForUpdate(): Promise<UpdateCheck>;
	installUpdate(url: string): Promise<void>;
	// meta vincent
	metaListRecordings(): Promise<MetaRec[]>;
	metaGetSummary(): Promise<MetaSummary>;
	metaSetStatus(recId: string, status: MetaStatus): Promise<void>;
	metaUndo(recId: string): Promise<void>;
	metaClassify(recId: string): Promise<MetaClassification>;
	metaConfirmSort(recId: string, payload: MetaConfirmPayload): Promise<void>;
	metaListProjects(): Promise<MetaProject[]>;
	metaGetInbox(cwd: string): Promise<MetaProjectInbox>;
	metaInboxAction(
		cwd: string,
		action: "toggleTodo" | "deleteTodo" | "deleteIdea" | "deleteMemory" | "ideaToPool" | "markStarted",
		index: number,
	): Promise<MetaProjectInbox>;
	metaListIdeas(): Promise<MetaInboxItem[]>;
	metaIdeaAction(action: "delete" | "fileToProject", index: number, cwd?: string): Promise<MetaInboxItem[]>;
	metaGetConfig(): Promise<{ workspace: string }>;
	metaSetWorkspace(path: string): Promise<{ workspace: string }>;
	metaExportHtml(html: string, name: string): Promise<{ ok: boolean; error?: string }>;
	metaExportPng(html: string, name: string): Promise<{ ok: boolean; error?: string }>;
	metaShareLink(html: string): Promise<{ ok: boolean; url?: string; error?: string }>;
	// misc
	pickDirectory(): Promise<string | undefined>;
	getHome(): Promise<string>;
}

declare global {
	interface Window {
		pi: PiApi;
	}
}
