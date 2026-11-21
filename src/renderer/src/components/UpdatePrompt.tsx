import type { UpdateState } from "../../../shared/types";
import { Markdown } from "./Markdown";
import { CloseIcon } from "./icons";

export function UpdateBanner({
	updateState,
	dismissed,
	skippedVersion,
	onInstall,
	onShowNotes,
	onDismiss,
	onSkip,
	onRetry,
}: {
	updateState: UpdateState | null;
	dismissed: boolean;
	skippedVersion?: string;
	onInstall: () => void;
	onShowNotes: () => void;
	onDismiss: () => void;
	onSkip: (version: string) => void;
	onRetry: () => void;
}) {
	if (!updateState) return null;
	const { status, latest, pct, error, manual, url } = updateState;

	if (status === "installing") {
		return (
			<div className="upd-banner" role="status">
				<span className="spinner sm" />
				<span className="upd-banner-text">Installing {latest ? `v${latest}` : "update"}, restarting HEIPANG…</span>
			</div>
		);
	}

	if (dismissed) return null;

	if (status === "downloading") {
		if (!manual) return null;
		return (
			<div className="upd-banner" role="status">
				<span className="upd-banner-text">Downloading {latest ? `v${latest}` : "update"}… {pct ?? 0}%</span>
				<div className="upd-banner-bar">
					<div className="upd-bar-fill" style={{ width: `${pct ?? 0}%` }} />
				</div>
				<button className="btn btn-sm" onClick={onDismiss} type="button">Hide</button>
			</div>
		);
	}

	if (status === "downloaded" && latest && url) {
		return (
			<div className="upd-banner ready" role="status">
				<span className="upd-banner-text">
					<strong>v{latest}</strong> is downloaded and ready to install
				</span>
				<div className="upd-banner-actions">
					{updateState.notes && (
						<button className="btn btn-sm" onClick={onShowNotes} type="button">Release notes</button>
					)}
					<button className="btn btn-sm btn-send" onClick={onInstall} type="button">Restart &amp; update</button>
					<button className="btn btn-sm" onClick={onDismiss} type="button">Later</button>
				</div>
			</div>
		);
	}

	if (status === "available" && latest && url && latest !== skippedVersion) {
		return (
			<div className="upd-banner" role="status">
				<span className="upd-banner-text">
					New version <strong>v{latest}</strong> is available
				</span>
				<div className="upd-banner-actions">
					{updateState.notes && (
						<button className="btn btn-sm" onClick={onShowNotes} type="button">Release notes</button>
					)}
					<button className="btn btn-sm btn-send" onClick={onInstall} type="button">Download &amp; update</button>
					<button className="btn btn-sm" onClick={() => onSkip(latest)} type="button">Skip</button>
					<button className="btn btn-sm" onClick={onDismiss} type="button">Later</button>
				</div>
			</div>
		);
	}

	if (status === "error" && manual && error) {
		return (
			<div className="upd-banner error" role="alert">
				<span className="upd-banner-text">Update failed: {error}</span>
				<div className="upd-banner-actions">
					<button className="btn btn-sm" onClick={onRetry} type="button">Retry</button>
					<button className="btn btn-sm" onClick={onDismiss} type="button">Dismiss</button>
				</div>
			</div>
		);
	}

	return null;
}

export function UpdateNotesModal({
	updateState,
	onClose,
	onInstall,
	onSkip,
}: {
	updateState: UpdateState;
	onClose: () => void;
	onInstall: () => void;
	onSkip: (version: string) => void;
}) {
	const { status, current, latest, channel, notes, pct, url, error } = updateState;
	const ready = status === "downloaded";
	const downloading = status === "downloading";
	const installing = status === "installing";

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal upd-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>{ready ? `Update ready · v${latest}` : latest ? `New version · v${latest}` : "Software update"}</h2>
					<button className="btn btn-icon" onClick={onClose} type="button">
						<CloseIcon />
					</button>
				</div>
				<div className="upd-meta">
					<span>Current: v{current}</span>
					{latest && <span>New: v{latest}</span>}
					{channel && <span className="upd-channel">{channel}</span>}
				</div>
				{error && (
					<div className="modal-error" role="alert">{error}</div>
				)}
				<div className="upd-notes">
					{notes ? <Markdown text={notes} /> : <div className="setting-note" style={{ margin: 0 }}>No release notes provided.</div>}
				</div>
				{downloading && (
					<div className="upd-progress">
						<div className="setting-note" style={{ margin: 0 }}>Downloading v{latest}… {pct ?? 0}%</div>
						<div className="upd-bar">
							<div className="upd-bar-fill" style={{ width: `${pct ?? 0}%` }} />
						</div>
					</div>
				)}
				{installing && (
					<div className="setting-note" style={{ margin: "8px 0 0" }}>Installing v{latest}, restarting…</div>
				)}
				<div className="request-actions">
					{status === "available" && latest && (
						<button className="btn" onClick={() => { onSkip(latest); onClose(); }} type="button">
							Skip this version
						</button>
					)}
					<button className="btn" onClick={onClose} type="button">
						{downloading || installing ? "Hide" : "Later"}
					</button>
					{url && !downloading && !installing && (
						<button className="btn btn-send" onClick={onInstall} type="button">
							{ready ? "Restart & update" : "Download & update"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
