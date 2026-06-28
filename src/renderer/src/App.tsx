import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import heipangBg from "./assets/heipang-bg.png";
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

function compactText(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function messagePlainText(m: UIMessage): string {
	if (m.role === "user") {
		if (typeof m.content === "string") return compactText(m.content);
		return compactText(m.content.map((c) => (c.type === "text" ? c.text : "")).join(" "));
	}
	return compactText(m.content.map((c) => (c.type === "text" ? c.text : "")).join(" "));
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
		rightPanelWidth: 320,
		sidebarCollapsed: false,
	});
	const [sbWidth, setSbWidth] = useState(280);
	const [rightWidth, setRightWidth] = useState(320);
	const [convLoading, setConvLoading] = useState(false);
	const [extracting, setExtracting] = useState(false);
	const [settingsTab, setSettingsTab] = useState<"general" | "models" | "accounts" | "extensions" | "skills" | null>(null);
	const [request, setRequest] = useState<PendingRequest | null>(null);
	const [unread, setUnread] = useState<Set<string>>(new Set());
	const [bgRunning, setBgRunning] = useState<{ path: string; cwd: string }[]>([]);
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
	const sessionRefreshTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
	const queueRefreshSessions = useCallback(
		(delays: number[] = [0, 700, 2000, 5000]) => {
			for (const timer of sessionRefreshTimers.current) clearTimeout(timer);
			sessionRefreshTimers.current = [];
			for (const delay of delays) {
				const timer = setTimeout(() => {
					sessionRefreshTimers.current = sessionRefreshTimers.current.filter((t) => t !== timer);
					refreshSessions();
				}, delay);
				sessionRefreshTimers.current.push(timer);
			}
		},
		[refreshSessions],
	);
	useEffect(() => () => {
		for (const timer of sessionRefreshTimers.current) clearTimeout(timer);
		sessionRefreshTimers.current = [];
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
			setRightWidth(g.rightPanelWidth ?? 320);
			setTasks(t);
			setCommands(cmds);
		})();
		queueRefreshSessions();
		refreshUsage();
	}, [queueRefreshSessions, refreshUsage]);

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
				case "sessionUpdated":
					queueRefreshSessions();
					break;
				case "sessionDone":
					queueRefreshSessions();
					if (e.path && (e.path !== activeFileRef.current || !document.hasFocus())) {
						const p = e.path;
						setUnread((prev) => new Set(prev).add(p));
					}
					break;
				case "background":
					setBgRunning(e.sessions);
					break;
				case "error":
					flash(e.message);
					break;
				default:
					break;
			}
		});
	}, [flash, queueRefreshSessions]);

	useEffect(() => window.pi.onRequest((req) => setRequest(req)), []);

	// Copy as PLAIN TEXT only (no bubble/code background or other HTML formatting
	// leaks into the clipboard). Links are kept as readable text + URL.
	useEffect(() => {
		const onCopy = (e: ClipboardEvent) => {
			const sel = window.getSelection();
			// textarea/input selections aren't in window.getSelection() → leave default
			if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !e.clipboardData) return;
			const holder = document.createElement("div");
			for (let i = 0; i < sel.rangeCount; i++) holder.appendChild(sel.getRangeAt(i).cloneContents());
			holder.querySelectorAll("a").forEach((a) => {
				const href = a.getAttribute("href") || "";
				const text = (a.textContent || "").trim();
				let rep = text;
				if (href && /^(https?:|mailto:)/i.test(href) && href !== text) rep = text ? `${text} (${href})` : href;
				else if (href && !text) rep = href;
				a.replaceWith(document.createTextNode(rep));
			});
			// innerText (vs textContent) preserves visual line breaks; needs to be in the DOM
			holder.style.cssText = "position:fixed;left:-99999px;top:0;white-space:pre-wrap;";
			document.body.appendChild(holder);
			const text = holder.innerText;
			document.body.removeChild(holder);
			e.preventDefault();
			e.clipboardData.setData("text/plain", text); // only plain text, no text/html
		};
		document.addEventListener("copy", onCopy, true);
		return () => document.removeEventListener("copy", onCopy, true);
	}, []);

	const streaming = !!state?.isStreaming;
	useEffect(() => {
		if (!streaming) refreshUsage();
	}, [streaming, refreshUsage]);

	const showUsage = useCallback(async () => {
		const u = await window.pi.getUsage();
		setUsage(u);
		if (u.error) {
			flash(`Usage: ${u.error}`);
			return;
		}
		const fmt = (b?: { pct: number; resetsAt: string | null }) => {
			if (!b) return null;
			const d = b.resetsAt ? new Date(b.resetsAt).getTime() - Date.now() : 0;
			const h = Math.max(0, Math.floor(d / 3600000));
			const m = Math.max(0, Math.floor((d % 3600000) / 60000));
			const reset = b.resetsAt ? ` (resets in ${h >= 24 ? `${Math.floor(h / 24)}d` : h > 0 ? `${h}h${m}m` : `${m}m`})` : "";
			return `${b.pct.toFixed(0)}%${reset}`;
		};
		const parts: string[] = [];
		if (u.fiveHour) parts.push(`5h ${fmt(u.fiveHour)}`);
		if (u.sevenDay) parts.push(`7d ${fmt(u.sevenDay)}`);
		flash(`${u.provider} usage — ${parts.join(" · ") || "no data"}`);
	}, [flash]);

	const onSend = useCallback(
		async (text: string, images: { data: string; mimeType: string; name?: string }[]) => {
			const cmd = text.trim();
			// Usage commands are TUI-only in pi; handle them natively in the GUI instead.
			if (cmd === "/usage" || cmd.startsWith("/usage-widget-status")) {
				showUsage();
				return;
			}
			const hadSession = !!state;
			await window.pi.sendMessage(text, images);
			queueRefreshSessions();
			if (!hadSession) setState(await window.pi.getActiveState());
		},
		[state, queueRefreshSessions, showUsage],
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
		queueRefreshSessions();
	}, [loadInto, queueRefreshSessions]);

	const onOpen = useCallback(
		(s: SessionListItem) => {
			setUnread((prev) => {
				if (!prev.has(s.path)) return prev;
				const n = new Set(prev);
				n.delete(s.path);
				return n;
			});
			const currentPath = state?.sessionFile ?? (state ? `synthetic:${state.sessionId}` : undefined);
			if (s.synthetic || s.path === currentPath) return;
			return loadInto(() => window.pi.openSession(s.path));
		},
		[state, loadInto],
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

	// right (tasks) panel resize
	const draggingR = useRef(false);
	const startRightResize = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		draggingR.current = true;
		const onMove = (ev: MouseEvent) => {
			if (!draggingR.current) return;
			setRightWidth(Math.min(600, Math.max(240, window.innerWidth - ev.clientX)));
		};
		const onUp = () => {
			draggingR.current = false;
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			setRightWidth((w) => {
				window.pi.setGuiSettings({ rightPanelWidth: w }).then(setGui);
				return w;
			});
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}, []);

	const activePath = state?.sessionFile ?? (state ? `synthetic:${state.sessionId}` : undefined);
	const displayedSessions = useMemo<SessionListItem[]>(() => {
		if (!state || !activePath) return sessions;
		if (sessions.some((s) => s.path === activePath || s.id === state.sessionId)) return sessions;
		const texts = messages.map(messagePlainText).filter(Boolean);
		const lastMessageAt = messages.reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
		const now = Date.now();
		const synthetic: SessionListItem = {
			path: activePath,
			id: state.sessionId,
			cwd: state.cwd,
			name: state.sessionName,
			created: state.runStartedAt ?? now,
			modified: Math.max(lastMessageAt, state.runStartedAt ?? 0, now),
			messageCount: messages.length,
			firstMessage: texts[0] || "New session",
			allMessagesText: texts.join("\n"),
			synthetic: true,
		};
		return [synthetic, ...sessions];
	}, [activePath, messages, sessions, state]);

	const runningFiles = new Set(bgRunning.map((b) => b.path));
	if (state?.isStreaming && activePath) runningFiles.add(activePath);
	const runningCwds = new Set(bgRunning.map((b) => b.cwd));
	if (state?.isStreaming) runningCwds.add(state.cwd);
	const activeSession = displayedSessions.find((s) => s.path === activePath || (state?.sessionFile && s.path === state.sessionFile));
	const title = state?.sessionName || activeSession?.name || activeSession?.firstMessage || "";
	const folderLabel = state ? gui.workspaceNames[state.cwd] || baseName(state.cwd) : "";

	const rightCol = gui.rightPanelOpen ? ` ${rightWidth}px` : "";
	const cols = gui.sidebarCollapsed ? `1fr${rightCol}` : `${sbWidth}px 1fr${rightCol}`;

	const onNewInFolder = useCallback(
		async (cwd: string) => {
			await loadInto(() => window.pi.newSession(cwd));
			queueRefreshSessions();
		},
		[loadInto, queueRefreshSessions],
	);

	return (
		<div className="app" style={{ gridTemplateColumns: cols }}>
			{!gui.sidebarCollapsed && (
				<Sidebar
					sessions={displayedSessions}
					activeFile={activePath}
					runningCwds={runningCwds}
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
					runningFiles={runningFiles}
					folderOrder={gui.folderOrder}
					onReorderFolders={async (order) => setGui(await window.pi.setGuiSettings({ folderOrder: order }))}
					onSettings={() => setSettingsTab("general")}
					onCollapseSidebar={() => setCollapsed(true)}
				/>
			)}
			{!gui.sidebarCollapsed && (
				<div className="resizer" style={{ left: sbWidth - 4 }} onMouseDown={startResize} />
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
				<div
					className="conv"
					style={{ ["--heipang-bg" as string]: `url(${heipangBg})` }}
				>
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
					sessionKey={state?.sessionFile ?? state?.sessionId ?? "new"}
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
			{gui.rightPanelOpen && (
				<div className="resizer" style={{ right: rightWidth - 4 }} onMouseDown={startRightResize} />
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
