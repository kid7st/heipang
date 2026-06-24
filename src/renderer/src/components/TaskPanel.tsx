import { useMemo, useState } from "react";
import type { ActiveState, ModelsPayload, Task, ThinkingLevel, UsageInfo } from "../../../shared/types";
import { BottomBar } from "./BottomBar";
import { ChevronRightIcon, CloseIcon, RefreshIcon } from "./icons";

function TaskRow({ task, onUpdate, onDelete }: { task: Task; onUpdate: (t: Task) => void; onDelete: (id: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState(task.title);
	const done = task.status === "done";

	// Click the circle = toggle done. It stays in the list (checked + struck through);
	// use the ✕ on the right to actually remove it.
	const toggle = () => onUpdate({ ...task, status: done ? "open" : "done" });

	return (
		<div className={`task-row${done ? " done" : ""}`}>
			<button
				className={`task-check${done ? " checked" : ""}`}
				onClick={toggle}
				title={done ? "Mark not done" : "Mark done"}
				type="button"
			>
				<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
					<path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</button>
			{editing ? (
				<input
					className="task-edit"
					value={title}
					autoFocus
					maxLength={20}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={() => {
						setEditing(false);
						if (title.trim() && title !== task.title) onUpdate({ ...task, title: title.trim() });
						else setTitle(task.title);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.target as HTMLInputElement).blur();
						if (e.key === "Escape") {
							setTitle(task.title);
							setEditing(false);
						}
					}}
				/>
			) : (
				<span className="task-title" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
					{task.title}
				</span>
			)}
			<button className="task-del" title="Remove" onClick={() => onDelete(task.id)} type="button">
				<CloseIcon size={12} />
			</button>
		</div>
	);
}

export function TaskPanel({
	tasks,
	extracting,
	models,
	state,
	usage,
	onUpdate,
	onDelete,
	onExtract,
	onClose,
	onSetModel,
	onSetThinking,
	onRefreshUsage,
}: {
	tasks: Task[];
	extracting: boolean;
	models: ModelsPayload | null;
	state: ActiveState | null;
	usage: UsageInfo | null;
	onUpdate: (t: Task) => void;
	onDelete: (id: string) => void;
	onExtract: () => void;
	onClose: () => void;
	onSetModel: (provider: string, id: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onRefreshUsage: () => void;
}) {
	const active = useMemo(
		() => tasks.filter((t) => t.status === "open" || t.status === "in_progress" || t.status === "done"),
		[tasks],
	);

	return (
		<div className="taskpanel">
			<div className="taskpanel-head">
				<span className="taskpanel-title">Tasks</span>
				<button className="btn btn-icon" onClick={onExtract} disabled={extracting} title="Re-summarize from the conversation" type="button">
					{extracting ? <span className="spinner" /> : <RefreshIcon />}
				</button>
				<button className="btn btn-icon" onClick={onClose} title="Hide" type="button">
					<ChevronRightIcon />
				</button>
			</div>

			<div className="task-list">
				{active.length === 0 && <div className="task-empty">No active tasks.{"\n"}Hit refresh to summarize the conversation.</div>}
				{active.map((t) => (
					<TaskRow key={t.id} task={t} onUpdate={onUpdate} onDelete={onDelete} />
				))}
			</div>

			<BottomBar
				models={models}
				state={state}
				usage={usage}
				onSetModel={onSetModel}
				onSetThinking={onSetThinking}
				onRefreshUsage={onRefreshUsage}
			/>
		</div>
	);
}
