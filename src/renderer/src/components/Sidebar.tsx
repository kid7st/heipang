import { useEffect, useMemo, useState } from "react";
import { VList } from "virtua";
import type { SessionListItem } from "../../../shared/types";

function Svg({ children }: { children: React.ReactNode }) {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			{children}
		</svg>
	);
}
export function PanelIcon() {
	return (
		<Svg>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<path d="M9 3v18" />
		</Svg>
	);
}
const IconPlus = () => (
	<Svg>
		<path d="M12 5v14M5 12h14" />
	</Svg>
);
const IconFolder = () => (
	<Svg>
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	</Svg>
);
const IconRename = () => (
	<Svg>
		<path d="M12 20h9" />
		<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
	</Svg>
);
const IconArchive = () => (
	<Svg>
		<rect x="3" y="4" width="18" height="4" rx="1" />
		<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
	</Svg>
);
const IconTrash = () => (
	<Svg>
		<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
	</Svg>
);
const IconMemory = () => (
	<Svg>
		<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
		<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
	</Svg>
);

interface FolderMenu {
	cwd: string;
	name: string;
	count: number;
	x: number;
	y: number;
}
interface SessionMenu {
	session: SessionListItem;
	x: number;
	y: number;
}

function relTime(ms: number): string {
	const d = Date.now() - ms;
	const m = Math.floor(d / 60000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const days = Math.floor(h / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(ms).toLocaleDateString();
}

function baseName(cwd: string): string {
	if (!cwd) return "(no folder)";
	const parts = cwd.replace(/\/$/, "").split("/");
	return parts[parts.length - 1] || cwd;
}

interface Folder {
	cwd: string;
	name: string;
	sessions: SessionListItem[];
	latest: number;
}

type Row =
	| { kind: "folder"; folder: Folder }
	| { kind: "session"; session: SessionListItem };

const LS_KEY = "pi.sidebar.collapsed";

function loadCollapsed(): Set<string> {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (raw) return new Set(JSON.parse(raw));
	} catch {
		/* ignore */
	}
	return new Set();
}

export function Sidebar({
	sessions,
	activeFile,
	streamingCwd,
	workspaceNames,
	onNew,
	onOpen,
	onArchiveSession,
	onDeleteSession,
	onDeleteFolder,
	onOpenFolder,
	onRenameFolder,
	onRenameSession,
	onNewInFolder,
	onEditMemory,
	unread,
	activeStreamingFile,
	onSettings,
	onCollapseSidebar,
}: {
	sessions: SessionListItem[];
	activeFile?: string;
	streamingCwd?: string;
	workspaceNames: Record<string, string>;
	onNew: () => void;
	onOpen: (s: SessionListItem) => void;
	onArchiveSession: (s: SessionListItem) => void;
	onDeleteSession: (s: SessionListItem) => void;
	onDeleteFolder: (f: { cwd: string; name: string; count: number }) => void;
	onOpenFolder: (cwd: string) => void;
	onRenameFolder: (cwd: string, current: string) => void;
	onRenameSession: (s: SessionListItem) => void;
	onNewInFolder: (cwd: string) => void;
	onEditMemory: (cwd: string, name: string) => void;
	unread: Set<string>;
	activeStreamingFile?: string;
	onSettings: () => void;
	onCollapseSidebar: () => void;
}) {
	const [q, setQ] = useState("");
	const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
	const [menu, setMenu] = useState<FolderMenu | null>(null);
	const [smenu, setSmenu] = useState<SessionMenu | null>(null);

	useEffect(() => {
		try {
			localStorage.setItem(LS_KEY, JSON.stringify([...collapsed]));
		} catch {
			/* ignore */
		}
	}, [collapsed]);

	const folders = useMemo<Folder[]>(() => {
		const needle = q.trim().toLowerCase();
		const map = new Map<string, Folder>();
		for (const s of sessions) {
			if (needle) {
				const hit =
					(s.name || "").toLowerCase().includes(needle) ||
					s.firstMessage.toLowerCase().includes(needle) ||
					s.cwd.toLowerCase().includes(needle) ||
					s.allMessagesText.toLowerCase().includes(needle);
				if (!hit) continue;
			}
			let f = map.get(s.cwd);
			if (!f) {
				f = { cwd: s.cwd, name: workspaceNames[s.cwd] || baseName(s.cwd), sessions: [], latest: 0 };
				map.set(s.cwd, f);
			}
			f.sessions.push(s);
			if (s.modified > f.latest) f.latest = s.modified;
		}
		const arr = [...map.values()];
		for (const f of arr) f.sessions.sort((a, b) => b.modified - a.modified);
		arr.sort((a, b) => b.latest - a.latest);
		return arr;
	}, [sessions, q]);

	const searching = q.trim().length > 0;
	const activeCwd = useMemo(
		() => sessions.find((s) => s.path === activeFile)?.cwd,
		[sessions, activeFile],
	);

	const isCollapsed = (cwd: string) => {
		if (searching) return false; // expand all while searching
		return collapsed.has(cwd);
	};

	const rows = useMemo<Row[]>(() => {
		const out: Row[] = [];
		for (const f of folders) {
			out.push({ kind: "folder", folder: f });
			if (!isCollapsed(f.cwd)) {
				for (const s of f.sessions) out.push({ kind: "session", session: s });
			}
		}
		return out;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folders, collapsed, searching, activeCwd]);

	useEffect(() => {
		if (!menu && !smenu) return;
		const close = () => {
			setMenu(null);
			setSmenu(null);
		};
		window.addEventListener("click", close);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("resize", close);
		};
	}, [menu, smenu]);

	const toggle = (cwd: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(cwd)) next.delete(cwd);
			else next.add(cwd);
			return next;
		});
	};

	return (
		<div className="sidebar">
			<div className="sidebar-top">
				<button className="btn btn-new" onClick={onNew} type="button">
					+ New
				</button>
				<button className="btn btn-icon" onClick={onCollapseSidebar} title="Hide sidebar" type="button">
					<PanelIcon />
				</button>
			</div>
			<input
				className="sidebar-search"
				placeholder="Search sessions…"
				value={q}
				onChange={(e) => setQ(e.target.value)}
			/>
			<VList className="session-list" data={rows}>
				{(row) => {
					if (row.kind === "folder") {
						const f = row.folder;
						const open = !isCollapsed(f.cwd);
						const active = !!streamingCwd && f.cwd === streamingCwd;
						return (
							<div className="folder-row" key={`f:${f.cwd}`}>
								<button className="folder-head" onClick={() => toggle(f.cwd)} title={f.cwd || "(no folder)"} type="button">
									<span className="chev">{open ? "▾" : "▸"}</span>
									<span className="folder-name">{f.name}</span>
									{active && <span className="spinner" title="task running" />}
								</button>
								<button
									className="row-action"
									title="Folder actions"
									onClick={(e) => {
										e.stopPropagation();
										const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
										setMenu({ cwd: f.cwd, name: f.name, count: f.sessions.length, x: r.right, y: r.bottom });
									}}
									type="button"
								>
									⋯
								</button>
							</div>
						);
					}
					const s = row.session;
					return (
						<div className={`session-row${s.path === activeFile ? " active" : ""}`} key={`s:${s.path}`}>
							<button className="session-item" onClick={() => onOpen(s)} type="button">
								<div className="session-title">
									{s.path === activeStreamingFile ? (
										<span className="spinner sm" title="working" />
									) : (
										unread.has(s.path) && <span className="unread-dot" title="finished" />
									)}
									{s.name || s.firstMessage || "(empty)"}
								</div>
								<div className="session-meta">
									<span className="session-time">{relTime(s.modified)}</span>
								</div>
							</button>
							<div className="row-actions">
								<button
									className="row-action"
									title="Session actions"
									onClick={(e) => {
										e.stopPropagation();
										const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
										setSmenu({ session: s, x: r.right, y: r.bottom });
									}}
									type="button"
								>
									⋯
								</button>
							</div>
						</div>
					);
				}}
			</VList>

			<div className="sidebar-footer">
				<button className="btn btn-icon" onClick={onSettings} title="Settings" type="button">
					⚙︎
				</button>
			</div>

			{menu && (
				<div className="folder-menu" style={{ top: menu.y + 4, left: Math.max(8, menu.x - 160) }} onClick={(e) => e.stopPropagation()}>
					<button className="folder-menu-item" onClick={() => { onNewInFolder(menu.cwd); setMenu(null); }} type="button">
						<IconPlus /> New session here
					</button>
					<button className="folder-menu-item" onClick={() => { onOpenFolder(menu.cwd); setMenu(null); }} type="button">
						<IconFolder /> Open folder
					</button>
					<button className="folder-menu-item" onClick={() => { onEditMemory(menu.cwd, menu.name); setMenu(null); }} type="button">
						<IconMemory /> Edit memory
					</button>
					<button className="folder-menu-item" onClick={() => { onRenameFolder(menu.cwd, menu.name); setMenu(null); }} type="button">
						<IconRename /> Rename
					</button>
					<button className="folder-menu-item danger" onClick={() => { onDeleteFolder({ cwd: menu.cwd, name: menu.name, count: menu.count }); setMenu(null); }} type="button">
						<IconTrash /> Delete
					</button>
				</div>
			)}
			{smenu && (
				<div className="folder-menu" style={{ top: smenu.y + 4, left: Math.max(8, smenu.x - 160) }} onClick={(e) => e.stopPropagation()}>
					<button className="folder-menu-item" onClick={() => { onRenameSession(smenu.session); setSmenu(null); }} type="button">
						<IconRename /> Rename
					</button>
					<button className="folder-menu-item" onClick={() => { onArchiveSession(smenu.session); setSmenu(null); }} type="button">
						<IconArchive /> Archive
					</button>
					<button className="folder-menu-item danger" onClick={() => { onDeleteSession(smenu.session); setSmenu(null); }} type="button">
						<IconTrash /> Delete
					</button>
				</div>
			)}
		</div>
	);
}
