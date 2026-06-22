import { useEffect, useState } from "react";
import type { ActiveState } from "../../../shared/types";
import { PanelIcon } from "./Sidebar";

export function HeaderBar({
	state,
	title,
	folderLabel,
	sidebarCollapsed,
	rightPanelOpen,
	onExpandSidebar,
	onToggleRightPanel,
	onSettings,
	onRenameActive,
}: {
	state: ActiveState | null;
	title: string;
	folderLabel: string;
	sidebarCollapsed: boolean;
	rightPanelOpen: boolean;
	onExpandSidebar: () => void;
	onToggleRightPanel: () => void;
	onSettings: () => void;
	onRenameActive: (name: string) => void;
}) {
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
					<span
						className={`hb-title${canRename ? " editable" : ""}`}
						onClick={() => canRename && setEditing(true)}
						title={canRename ? "Click to rename" : undefined}
					>
						{title || "New conversation"}
					</span>
				)}
			</div>
			<div className="hb-actions">
				<button
					className={`btn btn-icon${rightPanelOpen ? " on" : ""}`}
					onClick={onToggleRightPanel}
					title="Toggle tasks panel"
					type="button"
				>
					☰
				</button>
				<button className="btn btn-icon" onClick={onSettings} title="Settings" type="button">
					⚙︎
				</button>
			</div>
		</div>
	);
}
