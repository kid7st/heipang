import { useEffect, useState } from "react";
import type { AccountInfo, GuiSettings, ModelsPayload, PiSettings, ResourcesPayload, ThinkingLevel } from "../../../shared/types";
import { CloseIcon } from "./icons";
import { ModelManager } from "./ModelManager";

type Tab = "general" | "models" | "accounts" | "extensions" | "skills";
const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function ContentViewer({ title, path, onClose }: { title: string; path: string; onClose: () => void }) {
	const [content, setContent] = useState("Loading…");
	useEffect(() => {
		window.pi.readFile(path).then(setContent);
	}, [path]);
	return (
		<div className="modal-backdrop nested" onClick={onClose}>
			<div className="modal viewer-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>{title}</h2>
					<button className="btn btn-icon" onClick={onClose} type="button">
						<CloseIcon />
					</button>
				</div>
				<pre className="viewer-content">{content}</pre>
			</div>
		</div>
	);
}

export function SettingsModal({
	onClose,
	guiSettings,
	onGuiChange,
	models,
	onModelsChange,
	onEditGlobalMemory,
	initialTab = "general",
}: {
	onClose: () => void;
	guiSettings: GuiSettings;
	onGuiChange: (g: GuiSettings) => void;
	models: ModelsPayload | null;
	onModelsChange: (m: ModelsPayload) => void;
	onEditGlobalMemory: () => void;
	initialTab?: Tab;
}) {
	const [tab, setTab] = useState<Tab>(initialTab);
	const [pi, setPi] = useState<PiSettings | null>(null);
	const [res, setRes] = useState<ResourcesPayload | null>(null);
	const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
	const [busyAccount, setBusyAccount] = useState<string | null>(null);
	const [viewer, setViewer] = useState<{ title: string; path: string } | null>(null);

	const loadAccounts = () => window.pi.getAccounts().then(setAccounts);

	useEffect(() => {
		window.pi.getPiSettings().then(setPi);
		window.pi.getResources().then(setRes);
		loadAccounts();
	}, []);

	const updatePi = async (partial: Partial<PiSettings>) => setPi(await window.pi.setPiSettings(partial));
	const updateGui = async (partial: Partial<GuiSettings>) => onGuiChange(await window.pi.setGuiSettings(partial));

	const delExtension = async (path: string, name: string) => {
		if (!confirm(`Delete extension "${name}"? This removes the file from ~/.pi/agent/extensions.`)) return;
		await window.pi.deleteExtension(path);
		setRes(await window.pi.getResources());
	};
	const delSkill = async (filePath: string, name: string) => {
		if (!confirm(`Delete skill "${name}"? This removes its folder from ~/.pi/agent/skills.`)) return;
		await window.pi.deleteSkill(filePath);
		setRes(await window.pi.getResources());
	};
	const connect = async (id: string) => {
		setBusyAccount(id);
		const r = await window.pi.loginAccount(id);
		setBusyAccount(null);
		if (!r.ok && r.error) alert(`Sign-in failed: ${r.error}`);
		loadAccounts();
	};
	const disconnect = async (id: string) => {
		if (!confirm(`Sign out of ${id}?`)) return;
		await window.pi.logoutAccount(id);
		loadAccounts();
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>Settings</h2>
					<button className="btn btn-icon" onClick={onClose} type="button">
						<CloseIcon />
					</button>
				</div>

				<div className="tabs">
					{(["general", "models", "accounts", "extensions", "skills"] as Tab[]).map((t) => (
						<button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)} type="button">
							{t[0].toUpperCase() + t.slice(1)}
						</button>
					))}
				</div>

				{tab === "general" && (
					<div className="tab-body card-grid">
						<div className="card">
							<div className="card-label">Default thinking level</div>
							<select
								value={pi?.defaultThinkingLevel ?? "xhigh"}
								onChange={(e) => updatePi({ defaultThinkingLevel: e.target.value as ThinkingLevel })}
							>
								{THINKING.map((t) => (
									<option key={t} value={t}>
										{t}
									</option>
								))}
							</select>
						</div>
						<div className="card">
							<div className="card-label">Steering mode</div>
							<select value={pi?.steeringMode ?? "all"} onChange={(e) => updatePi({ steeringMode: e.target.value as any })}>
								<option value="all">all</option>
								<option value="one-at-a-time">one-at-a-time</option>
							</select>
						</div>
						<div className="card">
							<div className="card-label">Follow-up mode</div>
							<select value={pi?.followUpMode ?? "all"} onChange={(e) => updatePi({ followUpMode: e.target.value as any })}>
								<option value="all">all</option>
								<option value="one-at-a-time">one-at-a-time</option>
							</select>
						</div>
						<div className="card">
							<div className="card-label">Auto-detect tasks</div>
							<label className="card-toggle">
								<input
									type="checkbox"
									checked={guiSettings.autoExtractTasks}
									onChange={(e) => updateGui({ autoExtractTasks: e.target.checked })}
								/>
								summarize tasks after each turn
							</label>
						</div>
						<div className="card">
							<div className="card-label">Global memory</div>
							<div className="setting-note" style={{ margin: 0 }}>Notes fed to the agent in every conversation.</div>
							<button className="btn btn-sm" style={{ marginLeft: 0 }} onClick={onEditGlobalMemory} type="button">
								Edit global memory
							</button>
						</div>
					</div>
				)}

				{tab === "models" && (
					<div className="tab-body">
						{models ? <ModelManager models={models} onChanged={onModelsChange} /> : <div className="setting-note">Loading…</div>}
					</div>
				)}

				{tab === "accounts" && (
					<div className="tab-body card-grid">
						{!accounts && <div className="setting-note">Loading…</div>}
						{accounts?.map((a) => (
							<div className="card account-card" key={a.id}>
								<div className="account-top">
									<span className="account-name">{a.name}</span>
									<span className={`account-status${a.connected ? " on" : ""}`}>
										<span className="status-dot" />
										{a.connected ? "connected" : "not signed in"}
									</span>
								</div>
								<div className="account-id">{a.id}</div>
								{a.connected ? (
									<button className="btn" onClick={() => disconnect(a.id)} type="button">
										Sign out
									</button>
								) : (
									<button className="btn btn-send" onClick={() => connect(a.id)} disabled={busyAccount === a.id} type="button">
										{busyAccount === a.id ? "Waiting for browser…" : "Sign in"}
									</button>
								)}
							</div>
						))}
						<div className="setting-note">Sign in opens your browser. Needed to use your Claude / ChatGPT coding plans on this machine.</div>
					</div>
				)}

				{tab === "extensions" && (
					<div className="tab-body">
						<div className="section-title">
							Extensions
							<button className="btn btn-sm" onClick={() => res && window.pi.openPath(res.extensionsDir)} type="button">
								Open folder
							</button>
						</div>
						<div className="card-grid">
							{!res && <div className="setting-note">Loading…</div>}
							{res?.extensions.map((e) => (
								<div className={`card res-card${e.error ? " has-error" : ""}`} key={e.path} onClick={() => setViewer({ title: e.name, path: e.path })}>
									<button className="card-x" title="Delete" onClick={(ev) => { ev.stopPropagation(); delExtension(e.path, e.name); }} type="button">
										×
									</button>
									<div className="res-name">{e.name}</div>
									{e.error ? (
										<div className="res-error">error — click to view</div>
									) : (
										<div className="res-tags">
											{e.tools.length > 0 && <span className="res-tag">tools {e.tools.length}</span>}
											{e.commands.length > 0 && <span className="res-tag">cmds {e.commands.length}</span>}
											{e.tools.length === 0 && e.commands.length === 0 && <span className="res-tag dim">hooks</span>}
										</div>
									)}
								</div>
							))}
						</div>
						<div className="setting-note">Drop a .ts file into the folder, then reopen Settings.</div>
					</div>
				)}

				{tab === "skills" && (
					<div className="tab-body">
						<div className="section-title">
							Skills
							<button className="btn btn-sm" onClick={() => res && window.pi.openPath(res.skillsDir)} type="button">
								Open folder
							</button>
						</div>
						<div className="card-grid">
							{!res && <div className="setting-note">Loading…</div>}
							{res?.skills.length === 0 && <div className="setting-note">No skills found.</div>}
							{res?.skills.map((s) => (
								<div className="card res-card" key={s.filePath} onClick={() => setViewer({ title: s.name, path: s.filePath })}>
									<button className="card-x" title="Delete" onClick={(ev) => { ev.stopPropagation(); delSkill(s.filePath, s.name); }} type="button">
										×
									</button>
									<div className="res-name">{s.name}</div>
									<div className="res-tag dim">click to view</div>
								</div>
							))}
						</div>
						<div className="setting-note">Add a skill folder with a SKILL.md, then reopen Settings.</div>
					</div>
				)}
			</div>
			{viewer && <ContentViewer title={viewer.title} path={viewer.path} onClose={() => setViewer(null)} />}
		</div>
	);
}
