import { useEffect, useState } from "react";
import { isPresetModel } from "../../../shared/model-selection";
import type { ModelsPayload, NewModelInput, RemoteModel } from "../../../shared/types";

/** Embeddable model management (rendered inside Settings → Models). */
export function ModelManager({
	models,
	onChanged,
}: {
	models: ModelsPayload;
	onChanged: (next: ModelsPayload) => void;
}) {
	const [remote, setRemote] = useState<RemoteModel[] | null>(null);
	const [remoteProvider, setRemoteProvider] = useState<"anthropic" | "openai-codex" | "antigravity">("anthropic");
	const [remoteSel, setRemoteSel] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [showAdd, setShowAdd] = useState(false);

	const [mId, setMId] = useState("");
	const [mName, setMName] = useState("");
	const [mProvider, setMProvider] = useState("anthropic");

	const enabledSet = new Set(models.enabled);
	const defKey = models.defaultProvider && models.defaultModel ? `${models.defaultProvider}/${models.defaultModel}` : "";

	const active = models.all.filter((m) => isPresetModel(m) || enabledSet.has(`${m.provider}/${m.id}`));

	const fetchRemote = async (provider: "anthropic" | "openai-codex" | "antigravity") => {
		setBusy(true);
		setErr(null);
		try {
			const res = provider === "openai-codex" ? await window.pi.fetchRemoteOpenAIModels()
				: provider === "antigravity" ? await window.pi.fetchRemoteAntigravityModels() : await window.pi.fetchRemoteModels();
			if (!res.ok) throw new Error(res.error || "Failed to fetch models");
			setRemoteProvider(provider);
			setRemote(res.models || []);
			setRemoteSel(new Set());
		} catch (error) {
			setErr(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	// Auto-pull the latest models when the Models tab opens, so recent models are
	// just there (Anthropic is a live account list; OpenAI merges the catalog).
	useEffect(() => {
		void fetchRemote("anthropic");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const refreshLatest = async () => {
		setBusy(true);
		setErr(null);
		try {
			const result = await window.pi.refreshModelCatalog();
			if (!result.ok) throw new Error(result.error || "Failed to refresh model catalog");
			await fetchRemote(remoteProvider);
		} catch (error) {
			setErr(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const addAndEnable = async (inputs: NewModelInput[]) => {
		await window.pi.addModels(inputs);
		const keys = inputs.map((i) => `${i.provider}/${i.id}`);
		const next = await window.pi.setEnabledModels([...new Set([...models.enabled, ...keys])]);
		onChanged(next);
		return next;
	};

	const addSelectedRemote = async () => {
		if (!remote) return;
		const picks = remote.filter((m) => remoteSel.has(m.id));
		if (picks.length === 0) return;
		setBusy(true);
		setErr(null);
		try {
			await addAndEnable(picks.map((model) => ({ provider: model.provider || remoteProvider, id: model.id })));
			setRemote((current) => current?.map((model) => remoteSel.has(model.id) ? { ...model, alreadyAdded: true } : model) ?? null);
			setRemoteSel(new Set());
		} catch (error) {
			setErr(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const addManual = async () => {
		if (!mId.trim()) return;
		setBusy(true);
		setErr(null);
		try {
			await addAndEnable([{ provider: mProvider, id: mId.trim(), name: mName.trim() || undefined }]);
			setMId("");
			setMName("");
			setShowAdd(false);
		} catch (error) {
			setErr(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const setDefault = async (provider: string, id: string) => onChanged(await window.pi.setDefaultModel(provider, id));

	const removeActive = async (key: string) => {
		const next = await window.pi.setEnabledModels(models.enabled.filter((e) => e !== key));
		onChanged(next);
	};

	return (
		<div className="models-tab">
			{err && <div className="modal-error">{err}</div>}

			<div className="section-title">Active models (shown in the chat dropdown)</div>
			<div className="card-grid">
				{active.length === 0 && <div className="setting-note">No active models. Add one below.</div>}
				{active.map((m) => {
					const key = `${m.provider}/${m.id}`;
					return (
						<div className="card model-card" key={key}>
							<div className="model-card-top">
								<span className="model-name">{m.name}</span>
								<button className={`star${defKey === key ? " on" : ""}`} onClick={() => setDefault(m.provider, m.id)} title="Set as default" type="button">
									★
								</button>
							</div>
							<div className="model-id">{key}</div>
							{!m.hasAuth && <span className="badge noauth">no auth</span>}
							{m.id === "deepseek-v4-pro" && <div className="setting-note">Text-only · Separate API billing</div>}
							{isPresetModel(m) ? (
								<span className="badge">Built-in</span>
							) : (
								<button className="btn btn-sm" onClick={() => removeActive(key)} type="button">
									Remove
								</button>
							)}
						</div>
					);
				})}
			</div>

			<div className="section-title" style={{ marginTop: 18 }}>
				Add models
				<button className="btn btn-sm" onClick={() => fetchRemote("anthropic")} disabled={busy} type="button">
					{busy ? "…" : "Fetch from Anthropic"}
				</button>
				<button className="btn btn-sm" onClick={() => fetchRemote("openai-codex")} disabled={busy} type="button">
					{busy ? "…" : "Fetch from OpenAI"}
				</button>
				<button className="btn btn-sm" onClick={() => fetchRemote("antigravity")} disabled={busy} type="button">
					{busy ? "…" : "Fetch from Antigravity"}
				</button>
				<button className="btn btn-sm" onClick={refreshLatest} disabled={busy} title="Re-pull the latest-models catalog now" type="button">
					{busy ? "…" : "Refresh latest"}
				</button>
				<button className="btn btn-sm" onClick={() => setShowAdd((s) => !s)} type="button">
					{showAdd ? "Cancel" : "Add by ID"}
				</button>
			</div>

			{showAdd && (
				<div className="manual-form">
					<select value={mProvider} onChange={(e) => setMProvider(e.target.value)}>
						<option value="anthropic">Claude (anthropic)</option>
						<option value="openai-codex">ChatGPT (openai-codex)</option>
						<option value="antigravity">Antigravity (antigravity)</option>
						<option value="deepseek">DeepSeek API (deepseek)</option>
					</select>
					<input
						placeholder={mProvider === "openai-codex" ? "model id (e.g. gpt-6.1-sol)" : mProvider === "deepseek" ? "deepseek-v4-pro" : mProvider === "antigravity" ? "gemini-2.5-pro" : "model id (e.g. claude-opus-5-5)"}
						value={mId}
						onChange={(e) => setMId(e.target.value)}
					/>
					<input placeholder="display name (optional)" value={mName} onChange={(e) => setMName(e.target.value)} />
					<button className="btn btn-send" onClick={addManual} disabled={busy || !mId.trim()} type="button">
						Add
					</button>
				</div>
			)}

			{remote && (
				<>
					<div className="model-table scroll">
						{remote.map((m) => (
							<label className="model-row remote" key={m.id}>
								<input
									type="checkbox"
									disabled={m.alreadyAdded}
									checked={remoteSel.has(m.id)}
									onChange={() => {
										setRemoteSel((s) => {
											const n = new Set(s);
											if (n.has(m.id)) n.delete(m.id);
											else n.add(m.id);
											return n;
										});
									}}
								/>
								<span className="model-name">{m.display_name}</span>
								<span className="model-id">{m.id}</span>
								{m.contextWindow ? <span className="model-date">{Math.round(m.contextWindow / 1000)}k ctx</span> : null}
								{m.created_at && <span className="model-date">{m.created_at.slice(0, 10)}</span>}
								{m.alreadyAdded && <span className="badge added">added</span>}
							</label>
						))}
					</div>
					<button className="btn btn-send" onClick={addSelectedRemote} disabled={busy || remoteSel.size === 0} type="button">
						Add selected ({remoteSel.size})
					</button>
				</>
			)}
		</div>
	);
}
