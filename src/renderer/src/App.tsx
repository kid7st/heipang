import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ActiveState,
	CommandInfo,
	GuiSettings,
	ModelsPayload,
	SessionListItem,
	Task,
	ThinkingLevel,
	UIMessage,
	UsageInfo,
} from "../../shared/types";
import { Composer } from "./components/Composer";
import { HeaderBar } from "./components/HeaderBar";
import { MemoryEditor } from "./components/MemoryEditor";
import { MessageList } from "./components/MessageList";
import { PromptModal, type PromptSpec } from "./components/PromptModal";
import { RequestDialog, type PendingRequest } from "./components/RequestDialog";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { TaskPanel } from "./components/TaskPanel";

function baseName(p: string): string {
	if (!p) return "";
	const parts = p.replace(/\/$/, "").split("/");
	return parts[parts.length - 1] || p;
}

export default function App() {
	const [models, setModels] = useState<ModelsPayload | null>(null);
	const [state, setState] = useState<ActiveState | null>(null);
	const [messages, setMessages] = useState<UIMessage[]>([]);
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [commands, setCommands] = useState<CommandInfo[]>([]);
	const [usage, setUsage] = useState<UsageInfo | null>(null);
	const [gui, setGui] = useState<GuiSettings>({
		autoExtractTasks: true,
		rightPanelOpen: true,
		workspaceNames: {},
		folderOrder: [],
		sidebarWidth: 280,
		sidebarCollapsed: false,
	});
	const [sbWidth, setSbWidth] = useState(280);
	const [convLoading, setConvLoading] = useState(false);
	const [extracting, setExtracting] = useState(false);
	const [settingsTab, setSettingsTab] = useState<"general" | "models" | "accounts" | "extensions" | "skills" | null>(null);
	const [request, setRequest] = useState<PendingRequest | null>(null);
	const [unread, setUnread] = useState<Set<string>>(new Set());
	const [memory, setMemory] = useState<{ cwd?: string; label: string } | null>(null);
	const [promptSpec, setPromptSpec] = useState<PromptSpec | null>(null);
	const [toast, setToast] = useState<string | null>(null);

	const activeFileRef = useRef<string | undefined>(undefined);
	activeFileRef.current = state?.sessionFile;

	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flash = useCallback((msg: string) => {
		setToast(msg);
		if (toastTimer.current) clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(null), 5000);
	}, []);

	const refreshSessions = useCallback(async () => {
		setSessions(await window.pi.listSessions());
	}, []);
	const refreshUsage = useCallback(() => {
		window.pi.getUsage().then(setUsage).catch(() => {});
	}, []);

	useEffect(() => {
		(async () => {
			const [m, st, msgs, g, t, cmds] = await Promise.all([
				window.pi.listModels(),
				window.pi.getActiveState(),
				window.pi.getMessages(),
				window.pi.getGuiSettings(),
				window.pi.getTasks(),
				window.pi.getCommands(),
			]);
			setModels(m);
			setState(st);
			setMessages(msgs);
			setGui(g);
			setSbWidth(g.sidebarWidth);
			setTasks(t);
			setCommands(cmds);
		})();
		refreshSessions();
		refreshUsage();
	}, [refreshSessions, refreshUsage]);

	useEffect(() => {
		return window.pi.onEvent((e) => {
			switch (e.type) {
				case "messages":
					setMessages(e.messages);
					break;
				case "patch":
					setMessages((prev) => prev.slice(0, e.from).concat(e.messages));
					break;
				case "state":
					setState(e.state);
					break;
				case "tasks":
					setTasks(e.tasks);
					break;
				case "sessionDone":
					if (e.path && (e.path !== activeFileRef.current || !document.hasFocus())) {
						const p = e.path;
						setUnread((prev) => new Set(prev).add(p));
					}
					break;
				case "error":
					flash(e.message);
					break;
				default:
					break;
			}
		});
	}, [flash]);

	useEffect(() => window.pi.onRequest((req) => setRequest(req)), []);

	const streaming = !!state?.isStreaming;
	useEffect(() => {
		if (!streaming) refreshUsage();
	}, [streaming, refreshUsage]);

	const onSend = useCallback(
		async (text: string, images: { data: string; mimeType: string }[]) => {
			const hadSession = !!state;
			await window.pi.sendMessage(text, images);
			if (!hadSession) {
				setState(await window.pi.getActiveState());
				refreshSessions();
			}
		},
		[state, refreshSessions],
	);

	const loadInto = useCallback(
		async (loader: () => Promise<{ state: ActiveState; messages: UIMessage[]; modelFallbackMessage?: string }>) => {
			setConvLoading(true);
			setMessages([]);
			try {
				const res = await loader();
				setState(res.state);
				setMessages(res.messages);
				setTasks(await window.pi.getTasks());
				refreshUsage();
				if (res.modelFallbackMessage) flash(res.modelFallbackMessage);
			} catch (err) {
				flash(err instanceof Error ? err.message : String(err));
			} finally {
				setConvLoading(false);
			}
		},
		[flash, refreshUsage],
	);

	const onNew = useCallback(async () => {
		const dir = await window.pi.pickDirectory();
		if (!dir) return;
		await loadInto(() => window.pi.newSession(dir));
		refreshSessions();
	}, [loadInto, refreshSessions]);

	const onOpen = useCallback(
		(s: SessionListItem) => {
			setUnread((prev) => {
				if (!prev.has(s.path)) return prev;
				const n = new Set(prev);
				n.delete(s.path);
				return n;
			});
			if (s.path === state?.sessionFile) return;
			return loadInto(() => window.pi.openSession(s.path));
		},
		[state?.sessionFile, loadInto],
	);

	const clearIfActive = (path: string) => {
		if (path === state?.sessionFile) {
			setState(null);
			setMessages([]);
			setTasks([]);
		}
	};

	const onArchiveSession = useCallback(
		async (s: SessionListItem) => {
			if (!confirm(`Archive this session?\n\n${s.name || s.firstMessage}`)) return;
			await window.pi.archiveSession(s.path);
			clearIfActive(s.path);
			refreshSessions();
		},
		[state?.sessionFile, refreshSessions],
	);
	const onDeleteSession = useCallback(
		async (s: SessionListItem) => {
			if (!confirm(`Permanently delete this session? This cannot be undone.\n\n${s.name || s.firstMessage}`)) return;
			await window.pi.deleteSession(s.path);
			clearIfActive(s.path);
			refreshSessions();
		},
		[state?.sessionFile, refreshSessions],
	);
	const onDeleteFolder = useCallback(
		async (f: { cwd: string; name: string; count: number }) => {
			if (!confirm(`Permanently delete folder "${f.name}" and all ${f.count} session(s)? This cannot be undone.`)) return;
			await window.pi.deleteFolder(f.cwd);
			refreshSessions();
		},
		[refreshSessions],
	);
	const onOpenFolder = useCallback((cwd: string) => window.pi.openPath(cwd), []);
	const onRenameFolder = useCallback(
		(cwd: string, current: string) => {
			setPromptSpec({
				title: "Rename folder",
				label: "Display label only — your real folder on disk is not touched.",
				value: current,
				onSubmit: async (name) => {
					setGui(await window.pi.setGuiSettings({ workspaceNames: { ...gui.workspaceNames, [cwd]: name } }));
				},
			});
		},
		[gui.workspaceNames],
	);
	const onRenameSession = useCallback(
		(s: SessionListItem) => {
			setPromptSpec({
				title: "Rename conversation",
				value: s.name || s.firstMessage || "",
				onSubmit: async (name) => {
					await window.pi.renameSession(s.path, name);
					refreshSessions();
				},
			});
		},
		[refreshSessions],
	);
	const onRenameActive = useCallback(
		async (name: string) => {
			if (!state?.sessionFile) return;
			await window.pi.renameSession(state.sessionFile, name);
			setState((s) => (s ? { ...s, sessionName: name } : s));
			refreshSessions();
		},
		[state?.sessionFile, refreshSessions],
	);

	const onSetModel = useCallback(async (provider: string, id: string) => {
		setState(await window.pi.setModel(provider, id));
		window.pi.getUsage().then(setUsage).catch(() => {});
	}, []);
	const onSetThinking = useCallback(async (level: ThinkingLevel) => {
		setState(await window.pi.setThinkingLevel(level));
	}, []);

	const toggleRightPanel = useCallback(async () => {
		setGui(await window.pi.setGuiSettings({ rightPanelOpen: !gui.rightPanelOpen }));
	}, [gui.rightPanelOpen]);
	const setCollapsed = useCallback(
		async (v: boolean) => setGui(await window.pi.setGuiSettings({ sidebarCollapsed: v })),
		[],
	);

	const onExtractTasks = useCallback(async () => {
		setExtracting(true);
		try {
			const r = await window.pi.extractTasks();
			if (r.ok && r.tasks) setTasks(r.tasks);
			else if (!r.ok && r.error) flash(r.error);
		} finally {
			setExtracting(false);
		}
	}, [flash]);

	// sidebar resize
	const dragging = useRef(false);
	const startResize = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			dragging.current = true;
			const onMove = (ev: MouseEvent) => {
				if (!dragging.current) return;
				setSbWidth(Math.min(520, Math.max(180, ev.clientX)));
			};
			const onUp = () => {
				dragging.current = false;
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				setSbWidth((w) => {
					window.pi.setGuiSettings({ sidebarWidth: w }).then(setGui);
					return w;
				});
			};
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
		},
		[],
	);

	const streamingCwd = state?.isStreaming ? state.cwd : undefined;
	const activeSession = sessions.find((s) => s.path === state?.sessionFile);
	const title = state?.sessionName || activeSession?.name || activeSession?.firstMessage || "";
	const folderLabel = state ? gui.workspaceNames[state.cwd] || baseName(state.cwd) : "";

	const cols = gui.sidebarCollapsed
		? `1fr${gui.rightPanelOpen ? " 320px" : ""}`
		: `${sbWidth}px 6px 1fr${gui.rightPanelOpen ? " 320px" : ""}`;

	const onNewInFolder = useCallback(
		async (cwd: string) => {
			await loadInto(() => window.pi.newSession(cwd));
			refreshSessions();
		},
		[loadInto, refreshSessions],
	);

	return (
		<div className="app" style={{ gridTemplateColumns: cols }}>
			{!gui.sidebarCollapsed && (
				<>
					<Sidebar
						sessions={sessions}
						activeFile={state?.sessionFile}
						streamingCwd={streamingCwd}
						workspaceNames={gui.workspaceNames}
						onNew={onNew}
						onOpen={onOpen}
						onArchiveSession={onArchiveSession}
						onDeleteSession={onDeleteSession}
						onDeleteFolder={onDeleteFolder}
						onOpenFolder={onOpenFolder}
						onRenameFolder={onRenameFolder}
						onRenameSession={onRenameSession}
						onNewInFolder={onNewInFolder}
						onEditMemory={(cwd, name) => setMemory({ cwd, label: name })}
						unread={unread}
						activeStreamingFile={state?.isStreaming ? state.sessionFile : undefined}
						folderOrder={gui.folderOrder}
						onReorderFolders={async (order) => setGui(await window.pi.setGuiSettings({ folderOrder: order }))}
						onSettings={() => setSettingsTab("general")}
						onCollapseSidebar={() => setCollapsed(true)}
					/>
					<div className="resizer" onMouseDown={startResize} />
				</>
			)}
			<div className="main">
				<HeaderBar
					state={state}
					title={title}
					folderLabel={folderLabel}
					sidebarCollapsed={gui.sidebarCollapsed}
					rightPanelOpen={gui.rightPanelOpen}
					onExpandSidebar={() => setCollapsed(false)}
					onToggleRightPanel={toggleRightPanel}
					onRenameActive={onRenameActive}
				/>
				<div className="conv">
					{convLoading ? (
						<div className="conv-loading">Loading conversation…</div>
					) : (
						<MessageList messages={messages} streaming={!!state?.isStreaming} />
					)}
				</div>
				<Composer
					commands={commands}
					onSend={onSend}
					onStop={() => window.pi.abort()}
					streaming={!!state?.isStreaming}
					disabled={convLoading}
				/>
			</div>

			{gui.rightPanelOpen && (
				<TaskPanel
					tasks={tasks}
					extracting={extracting}
					models={models}
					state={state}
					usage={usage}
					onUpdate={async (t) => setTasks(await window.pi.updateTask(t))}
					onDelete={async (id) => setTasks(await window.pi.deleteTask(id))}
					onExtract={onExtractTasks}
					onClose={toggleRightPanel}
					onSetModel={onSetModel}
					onSetThinking={onSetThinking}
					onRefreshUsage={refreshUsage}
				/>
			)}

			{settingsTab && (
				<SettingsModal
					initialTab={settingsTab}
					onClose={() => setSettingsTab(null)}
					guiSettings={gui}
					onGuiChange={setGui}
					models={models}
					onModelsChange={setModels}
					onEditGlobalMemory={() => setMemory({ label: "all conversations" })}
				/>
			)}
			{memory && <MemoryEditor cwd={memory.cwd} label={memory.label} onClose={() => setMemory(null)} />}
			{promptSpec && <PromptModal spec={promptSpec} onClose={() => setPromptSpec(null)} />}
			{request && <RequestDialog req={request} onClose={() => setRequest(null)} />}

			{toast && (
				<div className="toast" onClick={() => setToast(null)}>
					{toast}
				</div>
			)}
		</div>
	);
}
