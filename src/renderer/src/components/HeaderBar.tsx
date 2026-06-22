import { useEffect, useState } from "react";
import type { ActiveState } from "../../../shared/types";
import { ListIcon } from "./icons";
import { PanelIcon } from "./Sidebar";

function fmtDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/**
 * Live "working time" for the current run. The real start timestamp comes from
 * the main process, so it keeps counting continuously even after you leave and
 * return to a still-running session. The 1s interval only runs while streaming
 * and only re-renders this tiny component — idle cost is zero.
 */
function WorkTimer({
	isStreaming,
	runStartedAt,
	lastRunMs,
}: {
	isStreaming: boolean;
	runStartedAt?: number;
	lastRunMs?: number;
}) {
	const [now, setNow] = useState(0);

	useEffect(() => {
		if (!isStreaming) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [isStreaming]);

	if (isStreaming && runStartedAt != null) {
		return <span className="hb-timer working" title="Time the current run has been working">Working for {fmtDuration(now - runStartedAt)}</span>;
	}
	if (!isStreaming && lastRunMs != null) {
		return <span className="hb-timer" title="Duration of the last run">Worked for {fmtDuration(lastRunMs)}</span>;
	}
	return null;
}

export function HeaderBar({
	state,
	title,
	folderLabel,
	sidebarCollapsed,
	rightPanelOpen,
	onExpandSidebar,
	onToggleRightPanel,
	onRenameActive,
}: {
	state: ActiveState | null;
	title: string;
	folderLabel: string;
	sidebarCollapsed: boolean;
	rightPanelOpen: boolean;
	onExpandSidebar: () => void;
	onToggleRightPanel: () => void;
	onRenameActive: (name: string) => void;
}) {
	const ctx = state?.contextPct;
	const ctxColor = ctx == null ? undefined : ctx >= 80 ? "#c0492f" : ctx >= 50 ? "#b8791a" : "#2f9e63";
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);
	useEffect(() => setDraft(title), [title]);

	const canRename = !!state;

	return (
		<div className="headerbar">
			{sidebarCollapsed && (
				<button className="btn btn-icon hb-expand" onClick={onExpandSidebar} title="Show sidebar" type="button">
					<PanelIcon />
				</button>
			)}
			<div className="hb-titles">
				{folderLabel && <span className="hb-folder">{folderLabel}</span>}
				{editing ? (
					<input
						className="hb-title-edit"
						value={draft}
						autoFocus
						onChange={(e) => setDraft(e.target.value)}
						onBlur={() => {
							setEditing(false);
							if (draft.trim() && draft !== title) onRenameActive(draft.trim());
							else setDraft(title);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") (e.target as HTMLInputElement).blur();
							if (e.key === "Escape") {
								setDraft(title);
								setEditing(false);
							}
						}}
					/>
				) : (
					<span className="hb-title-row">
						<span
							className={`hb-title${canRename ? " editable" : ""}`}
							onClick={() => canRename && setEditing(true)}
							title={canRename ? "Click to rename" : undefined}
						>
							{title || "New conversation"}
						</span>
						{ctx != null && (
							<span className="hb-ctx" style={{ color: ctxColor }} title="Context window used in this conversation. Start a new chat when it gets high.">
								{ctx}%
							</span>
						)}
					</span>
				)}
			</div>
			<div className="hb-actions">
				<WorkTimer isStreaming={!!state?.isStreaming} runStartedAt={state?.runStartedAt} lastRunMs={state?.lastRunMs} />
				<button
					className={`btn btn-icon${rightPanelOpen ? " on" : ""}`}
					onClick={onToggleRightPanel}
					title="Toggle tasks panel"
					type="button"
				>
					<ListIcon />
				</button>
			</div>
		</div>
	);
}
