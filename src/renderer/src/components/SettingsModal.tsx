import { useEffect, useState } from "react";
import { AntigravityAccount } from "./AntigravityAccount";
import type {
	AccountInfo,
	GuiSettings,
	ModelsPayload,
	PiSettings,
	ResourcesPayload,
	ThinkingLevel,
	UpdateState,
} from "../../../shared/types";
import { CloseIcon } from "./icons";
import { Markdown } from "./Markdown";
import { ModelManager } from "./ModelManager";

function formatCheckedAt(ts?: number): string {
	if (!ts) return "";
	const diffMin = Math.floor((Date.now() - ts) / 60_000);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function UpdateCard({
	updateState,
	guiSettings,
	onUpdateGui,
	onCheckUpdate,
	onInstallUpdate,
}: {
	updateState: UpdateState | null;
	guiSettings: GuiSettings;
	onUpdateGui: (partial: Partial<GuiSettings>) => void;
	onCheckUpdate: () => Promise<void>;
	onInstallUpdate: () => void;
}) {
	const [fallbackVersion, setFallbackVersion] = useState("");
	const [checkingLocal, setCheckingLocal] = useState(false);

	useEffect(() => {
		if (!updateState?.current) {
			window.pi.getVersion().then(setFallbackVersion).catch(() => {});
		}
	}, [updateState?.current]);

	const current = updateState?.current || fallbackVersion;
	const status = updateState?.status ?? "idle";
	const checking = checkingLocal || status === "checking";
	const downloading = status === "downloading";
	const installing = status === "installing";
	const hasUpdate = (status === "available" || status === "downloaded") && !!updateState?.url && !!updateState?.latest;
	const skipped = hasUpdate && guiSettings.skippedUpdateVersion === updateState?.latest;

	const handleCheck = async () => {
		setCheckingLocal(true);
		try {
			await onCheckUpdate();
		} finally {
			setCheckingLocal(false);
		}
	};

	return (
		<div className="card upd-card">
			<div className="upd-card-head">
				<div>
					<div className="card-label">Software update</div>
					<div className="setting-note" style={{ margin: "4px 0 0" }}>
						Current version v{current || "…"}
						{updateState?.channel ? ` (${updateState.channel})` : ""}
						{updateState?.checkedAt ? ` · Checked ${formatCheckedAt(updateState.checkedAt)}` : ""}
					</div>
				</div>
				<div className="upd-card-actions">
					<button
						className="btn btn-sm"
						onClick={handleCheck}
						disabled={checking || downloading || installing}
						type="button"
					>
						{checking ? "Checking…" : "Check for update"}
					</button>
					{hasUpdate && (
						<button className="btn btn-sm btn-send" onClick={onInstallUpdate} type="button">
							{status === "downloaded" ? "Restart & update" : "Download & update"}
						</button>
					)}
				</div>
			</div>

			<div className="upd-toggles">
				<label className="card-toggle">
					<input
						type="checkbox"
						checked={guiSettings.autoCheckUpdates}
						onChange={(e) => onUpdateGui({ autoCheckUpdates: e.target.checked })}
					/>
					Automatically check for updates
				</label>
				<label className="card-toggle">
					<input
						type="checkbox"
						checked={guiSettings.autoDownloadUpdates}
						disabled={!guiSettings.autoCheckUpdates}
						onChange={(e) => onUpdateGui({ autoDownloadUpdates: e.target.checked })}
					/>
					Automatically download updates in background
				</label>
			</div>

			{downloading && (
				<div className="setting-note" style={{ margin: 0 }}>
					Downloading v{updateState?.latest}… {updateState?.pct ?? 0}%
					<div className="upd-bar">
						<div className="upd-bar-fill" style={{ width: `${updateState?.pct ?? 0}%` }} />
					</div>
				</div>
			)}
			{installing && (
				<div className="setting-note" style={{ margin: 0 }}>
					Installing v{updateState?.latest}, restarting…
				</div>
			)}
			{status === "error" && updateState?.error && (
				<div className="setting-note" style={{ margin: 0, color: "#b23a2e" }}>
					Update failed: {updateState.error}
				</div>
			)}
			{status === "not-available" && updateState?.manual && (
				<div className="setting-note" style={{ margin: 0 }}>
					You're on the latest version.
				</div>
			)}
			{hasUpdate && (
				<div className="upd-card-available">
					<div className="setting-note" style={{ margin: 0, color: "#155e3a", fontWeight: 600 }}>
						{status === "downloaded"
							? `v${updateState?.latest} is downloaded and ready to install`
							: `Update available · v${updateState?.latest}`}
						{skipped ? " (skipped)" : ""}
					</div>
					{updateState?.notes && (
						<div className="upd-notes-preview">
							<Markdown text={updateState.notes} />
						</div>
					)}
				</div>
			)}
		</div>
	);
}

type Tab = "general" | "models" | "accounts" | "extensions" | "skills";
const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function fileLabel(path?: string): string {
	if (!path) return "Skill warning";
	const parts = path.replace(/\/$/, "").split(/[\\/]/);
	return parts[parts.length - 2] || parts[parts.length - 1] || path;
}

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
	onExtensionsChange,
	onEditGlobalMemory,
	initialTab = "general",
	updateState,
	onCheckUpdate,
	onInstallUpdate,
}: {
	onClose: () => void;
	guiSettings: GuiSettings;
	onGuiChange: (g: GuiSettings) => void;
	models: ModelsPayload | null;
	onModelsChange: (m: ModelsPayload) => void;
	onExtensionsChange?: () => void;
	onEditGlobalMemory: () => void;
	initialTab?: Tab;
	updateState: UpdateState | null;
	onCheckUpdate: () => Promise<void>;
	onInstallUpdate: () => void;
}) {
	const [tab, setTab] = useState<Tab>(initialTab);
	const [pi, setPi] = useState<PiSettings | null>(null);
	const [res, setRes] = useState<ResourcesPayload | null>(null);
	const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
	const [busyAccount, setBusyAccount] = useState<{ id: string; label: string } | null>(null);
	const [accountError, setAccountError] = useState<{ id: string; message: string } | null>(null);
	const [busyExtension, setBusyExtension] = useState<string | null>(null);
	const [extError, setExtError] = useState<string | null>(null);
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
		onExtensionsChange?.();
	};
	const toggleExtension = async (path: string, disabled: boolean) => {
		setBusyExtension(path);
		setExtError(null);
		try {
			setRes(await window.pi.setExtensionDisabled(path, disabled));
			onExtensionsChange?.();
		} catch (error) {
			setExtError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusyExtension(null);
		}
	};
	const delSkill = async (filePath: string, name: string) => {
		if (!confirm(`Delete skill "${name}"? This removes its folder from ~/.pi/agent/skills.`)) return;
		await window.pi.deleteSkill(filePath);
		setRes(await window.pi.getResources());
	};
	const changeAccount = async ({ id, name, connected, authType }: AccountInfo) => {
		if (connected && !confirm(`Sign out of ${name}?`)) return;
		setBusyAccount({ id, label: connected ? "Signing out…" : authType === "api_key" ? "Connecting…" : "Waiting for browser…" });
		setAccountError(null);
		try {
			if (connected) await window.pi.logoutAccount(id);
			else {
				const result = await window.pi.loginAccount(id);
				if (!result.ok) throw new Error(result.error ?? "Sign-in failed");
			}
			await loadAccounts();
			onModelsChange(await window.pi.listModels());
		} catch (error) {
			setAccountError({ id, message: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusyAccount(null);
		}
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
						<UpdateCard
							updateState={updateState}
							guiSettings={guiSettings}
							onUpdateGui={updateGui}
							onCheckUpdate={onCheckUpdate}
							onInstallUpdate={onInstallUpdate}
						/>
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
						{accounts?.map((a) => a.id === "antigravity" ? (
							<AntigravityAccount key={a.id} connected={a.connected} onChanged={async () => {
								await loadAccounts();
								onModelsChange(await window.pi.listModels());
							}} />
						) : (
							<div className="card account-card" key={a.id}>
								<div className="account-top">
									<span className="account-name">{a.name}</span>
									<span className={`account-status${a.connected ? " on" : ""}`}>
										<span className="status-dot" />
										{a.connected ? "connected" : "not signed in"}
									</span>
								</div>
								<div className="account-id">{a.id === "google" ? "Google AI Studio API key" : a.id}</div>
								<button className={`btn${a.connected ? "" : " btn-send"}`} onClick={() => changeAccount(a)} disabled={busyAccount !== null} type="button">
									{busyAccount?.id === a.id ? busyAccount.label : a.connected ? "Sign out" : a.authType === "api_key" ? "Add API key" : "Sign in"}
								</button>
								{accountError?.id === a.id && <div className="account-error" role="alert">{accountError.message}</div>}
							</div>
						))}
						<div className="setting-note">Claude / ChatGPT use browser sign-in. Antigravity uses a relay URL and key. DeepSeek uses its own API key and prepaid API balance.</div>
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
						{extError && <div className="setting-note" style={{ color: "#b23a2e", marginBottom: 8 }}>{extError}</div>}
						<div className="card-grid">
							{!res && <div className="setting-note">Loading…</div>}
							{res?.extensions.map((e) => (
								<div className={`card res-card${e.error ? " has-error" : ""}${e.disabled ? " is-disabled" : ""}`} key={e.path} onClick={() => setViewer({ title: e.name, path: e.path })}>
									{!e.builtin && (
										<button className="card-x" title="Delete" onClick={(ev) => { ev.stopPropagation(); delExtension(e.path, e.name); }} type="button">
											×
										</button>
									)}
									<div className="res-name">{e.name}</div>
									{e.disabled ? (
										<div className="res-tags"><span className="res-tag dim">disabled in HEIPANG</span></div>
									) : e.error ? (
										<div className="res-error">error — click to view</div>
									) : (
										<div className="res-tags">
											{e.tools.length > 0 && <span className="res-tag">tools {e.tools.length}</span>}
											{e.commands.length > 0 && <span className="res-tag">cmds {e.commands.length}</span>}
											{e.tools.length === 0 && e.commands.length === 0 && <span className="res-tag dim">hooks</span>}
										</div>
									)}
									{!e.builtin && (
										<div className="res-actions" onClick={(ev) => ev.stopPropagation()}>
											<button
												className="btn btn-sm"
												disabled={busyExtension === e.path}
												onClick={() => toggleExtension(e.path, !e.disabled)}
												type="button"
											>
												{busyExtension === e.path ? "Updating…" : e.disabled ? "Enable" : "Disable"}
											</button>
										</div>
									)}
								</div>
							))}
						</div>
						<div className="setting-note">Drop a .ts file into the folder, then reopen Settings. Disabling only turns an extension off in HEIPANG without affecting pi CLI.</div>
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
							{res?.skillDiagnostics.map((d, i) => (
								<div
									className="card res-card has-error"
									key={`${d.path || "skill-diagnostic"}:${i}`}
									onClick={() => d.path && setViewer({ title: fileLabel(d.path), path: d.path })}
								>
									<div className="res-name">{fileLabel(d.path)}</div>
									<div className="res-error">{d.type}: {d.message}</div>
								</div>
							))}
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
