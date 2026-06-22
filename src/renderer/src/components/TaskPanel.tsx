import { useMemo, useState } from "react";
import type { ActiveState, ModelsPayload, Task, TaskStatus, ThinkingLevel, UsageInfo } from "../../../shared/types";
import { BottomBar } from "./BottomBar";

const STATUS_LABEL: Record<TaskStatus, string> = {
	open: "Open",
	in_progress: "Doing",
	done: "Done",
	declined: "Declined",
	cancelled: "Cancelled",
};
const STATUS_ORDER: TaskStatus[] = ["open", "in_progress", "done", "declined", "cancelled"];

function TaskRow({ task, onUpdate, onDelete }: { task: Task; onUpdate: (t: Task) => void; onDelete: (id: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState(task.title);

	return (
		<div className={`task-row status-${task.status}`}>
			<select
				className={`task-dot status-${task.status}`}
				value={task.status}
				onChange={(e) => onUpdate({ ...task, status: e.target.value as TaskStatus })}
				title="Set status"
			>
				{STATUS_ORDER.map((s) => (
					<option key={s} value={s}>
						{STATUS_LABEL[s]}
					</option>
				))}
			</select>
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
			<button className="task-del" title="Delete" onClick={() => onDelete(task.id)} type="button">
				✕
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
	const [showDone, setShowDone] = useState(false);

	const { active, done } = useMemo(() => {
		const a: Task[] = [];
		const d: Task[] = [];
		for (const t of tasks) {
			if (t.status === "open" || t.status === "in_progress") a.push(t);
			else d.push(t);
		}
		return { active: a, done: d };
	}, [tasks]);

	return (
		<div className="taskpanel">
			<div className="taskpanel-head">
				<span className="taskpanel-title">Tasks</span>
				<button className="btn btn-icon" onClick={onExtract} disabled={extracting} title="Re-summarize from the conversation" type="button">
					{extracting ? <span className="spinner" /> : "⟳"}
				</button>
				<button className="btn btn-icon" onClick={onClose} title="Hide" type="button">
					⟩
				</button>
			</div>

			<div className="task-list">
				{active.length === 0 && <div className="task-empty">No active tasks.{"\n"}Hit ⟳ to summarize the conversation.</div>}
				{active.map((t) => (
					<TaskRow key={t.id} task={t} onUpdate={onUpdate} onDelete={onDelete} />
				))}

				{done.length > 0 && (
					<button className="task-done-toggle" onClick={() => setShowDone((s) => !s)} type="button">
						{showDone ? "▾" : "▸"} Finished / closed ({done.length})
					</button>
				)}
				{showDone && done.map((t) => <TaskRow key={t.id} task={t} onUpdate={onUpdate} onDelete={onDelete} />)}
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
