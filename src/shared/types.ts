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
	type: "image";
	data: string;
	mimeType: string;
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

export interface ResourcesPayload {
	extensions: ExtensionItem[];
	skills: SkillItem[];
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
	sidebarCollapsed: boolean;
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
	contextPct?: number; // % of the model's context window currently used
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
	| { type: "sessionDone"; path?: string }
	| { type: "background"; sessions: { path: string; cwd: string }[] } // sessions still running in the background
	| { type: "error"; message: string };

export interface PiApi {
	// models
	listModels(): Promise<ModelsPayload>;
	addModels(models: NewModelInput[]): Promise<ModelsPayload>;
	removeModel(provider: string, id: string): Promise<ModelsPayload>;
	fetchRemoteModels(): Promise<{ ok: boolean; models?: RemoteModel[]; error?: string }>;
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
	// misc
	pickDirectory(): Promise<string | undefined>;
	getHome(): Promise<string>;
}

declare global {
	interface Window {
		pi: PiApi;
	}
}
