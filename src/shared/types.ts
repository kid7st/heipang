// Shared IPC contract types between main and renderer.
// Kept dependency-free so both sides can import without pulling in the SDK.

// "max" was added by pi 0.85 and is supported by the Claude 5 family.
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
	// block by the outgoing payload hook in src/main/provider-compat.ts.
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
	thinkingLevels?: ThinkingLevel[];
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
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
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
	disabled?: boolean;
	builtin?: boolean;
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
	authType?: "oauth" | "api_key" | "relay";
}

export interface AntigravitySettings {
	relayUrl: string;
	hasKey: boolean;
	error?: string;
}

export interface AntigravitySettingsInput {
	relayUrl: string;
	relayKey: string;
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
	disabledExtensions: string[];
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
	billing?: "api";
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
	isCompacting?: boolean;
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
	| { type: "messages"; messages: UIMessage[]; sessionId: string } // full snapshot (on open / structural change)
	| { type: "patch"; from: number; messages: UIMessage[]; sessionId: string } // incremental tail during streaming
	| { type: "state"; state: ActiveState }
	| { type: "tasks"; tasks: Task[]; sessionId: string }
	| { type: "sessionUpdated"; path?: string } // a message was persisted; refresh the sidebar list
	| { type: "sessionDone"; path?: string }
	| { type: "background"; sessions: { path: string; cwd: string }[] } // sessions still running in the background
	| { type: "updateProgress"; phase: "download" | "install" | "relaunch" | "error"; pct?: number; message?: string }
	| { type: "error"; message: string };

export interface InputRequest {
	id: string;
	kind: "select" | "code" | "secret" | "prompt";
	payload: {
		message: string;
		title?: string;
		placeholder?: string;
		options?: { id: string; label: string }[];
	};
}

export interface PiApi {
	// models
	listModels(): Promise<ModelsPayload>;
	addModels(models: NewModelInput[]): Promise<ModelsPayload>;
	fetchRemoteModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }>;
	fetchRemoteOpenAIModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }>;
	fetchRemoteAntigravityModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }>;
	refreshModelCatalog(): Promise<{ ok: boolean; count?: number; error?: string }>;
	setEnabledModels(enabled: string[]): Promise<ModelsPayload>;
	setDefaultModel(provider: string, id: string): Promise<ModelsPayload>;
	// sessions
	listSessions(): Promise<SessionListItem[]>;
	openSession(path: string): Promise<OpenSessionResult>;
	newSession(cwd?: string): Promise<OpenSessionResult>;
	// conversation
	sendMessage(text: string, images: ImageAttachment[] | undefined, sessionId: string | null): Promise<void>;
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
	updateTask(task: Task, sessionId: string): Promise<Task[]>;
	deleteTask(id: string, sessionId: string): Promise<Task[]>;
	extractTasks(sessionId: string): Promise<{ ok: boolean; tasks?: Task[]; error?: string }>;
	// commands / workspaces / accounts
	getCommands(): Promise<CommandInfo[]>;
	getAccounts(): Promise<AccountInfo[]>;
	getAntigravitySettings(): Promise<AntigravitySettings>;
	saveAntigravitySettings(input: AntigravitySettingsInput): Promise<{ ok: boolean; error?: string; warning?: string }>;
	loginAccount(id: string): Promise<{ ok: boolean; error?: string }>;
	logoutAccount(id: string): Promise<void>;
	getUsage(force?: boolean): Promise<UsageInfo>;
	readFile(path: string): Promise<string>;
	readMemory(cwd?: string): Promise<string>;
	writeMemory(content: string, cwd?: string): Promise<void>;
	deleteExtension(path: string): Promise<void>;
	setExtensionDisabled(path: string, disabled: boolean): Promise<ResourcesPayload>;
	deleteSkill(filePath: string): Promise<void>;
	onRequest(cb: (req: InputRequest) => void): () => void;
	onRequestDismiss(cb: (id: string) => void): () => void;
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
	// misc
	pickDirectory(): Promise<string | undefined>;
	getHome(): Promise<string>;
}

declare global {
	interface Window {
		pi: PiApi;
	}
}
