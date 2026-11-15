import { useEffect, useState } from "react";

export function AntigravityAccount({ connected, onChanged }: { connected: boolean; onChanged: () => Promise<void> }) {
	const [url, setUrl] = useState("");
	const [key, setKey] = useState("");
	const [hasKey, setHasKey] = useState(false);
	const [busy, setBusy] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");

	const load = async () => {
		try {
			const settings = await window.pi.getAntigravitySettings();
			setUrl(settings.relayUrl);
			setHasKey(settings.hasKey);
			setLoaded(true);
			setError("");
		} catch (error) {
			setError(String(error));
		}
	};
	useEffect(() => { void load(); }, []);

	const save = async () => {
		setBusy(true);
		setError("");
		setMessage("");
		try {
			const result = await window.pi.saveAntigravitySettings({ relayUrl: url, relayKey: key });
			if (!result.ok) throw new Error(result.error ?? "Connection failed.");
			setKey("");
			await load();
			await onChanged();
			setMessage(result.warning ?? "Connected. Antigravity models are now available in the model selector.");
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const disconnect = async () => {
		if (!confirm("Remove the saved Antigravity relay connection?")) return;
		setBusy(true);
		setError("");
		setMessage("");
		try {
			await window.pi.logoutAccount("antigravity");
			setKey("");
			await load();
			await onChanged();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form className="card account-card antigravity-account" onSubmit={(event) => { event.preventDefault(); void save(); }}>
			<div className="account-top">
				<span className="account-name">Antigravity</span>
				<span className={`account-status${connected ? " on" : ""}`}><span className="status-dot" />{connected ? "connected" : "not configured"}</span>
			</div>
			<label className="card-label" htmlFor="antigravity-relay-url">Relay URL (ANTIGRAVITY_RELAY_URL)</label>
			<input id="antigravity-relay-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-relay.fly.dev" disabled={busy || !loaded} required />
			<label className="card-label" htmlFor="antigravity-relay-key">Relay key (ANTIGRAVITY_RELAY_KEY)</label>
			<input id="antigravity-relay-key" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={hasKey ? "Key saved; leave blank to keep it" : "Enter relay key"} disabled={busy || !loaded} required={!hasKey} />
			<div className="setting-note">Google sign-in is managed by your relay. The relay key is stored encrypted on this computer.</div>
			<div className="antigravity-actions">
				<button className="btn btn-send" disabled={busy || !loaded} type="submit">{busy ? "Verifying connection and loading models…" : error ? "Retry connection" : "Save and connect"}</button>
				{hasKey && <button className="btn" onClick={() => void disconnect()} disabled={busy} type="button">Disconnect</button>}
				{!loaded && error && <button className="btn" onClick={() => void load()} type="button">Retry loading settings</button>}
			</div>
			{error && <div className="antigravity-error" role="alert">{error}</div>}
			{message && <div role="status">{message}</div>}
		</form>
	);
}
