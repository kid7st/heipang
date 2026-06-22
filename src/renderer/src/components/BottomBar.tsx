import { useState } from "react";
import type { ActiveState, ModelsPayload, ThinkingLevel, UsageInfo } from "../../../shared/types";

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function resetLabel(iso: string | null | undefined): string {
	if (!iso) return "";
	const diff = new Date(iso).getTime() - Date.now();
	if (diff <= 0) return "now";
	const h = Math.floor(diff / 3600000);
	const m = Math.floor((diff % 3600000) / 60000);
	if (h >= 24) return `${Math.floor(h / 24)}d`;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

function UsagePill({ usage, onRefresh }: { usage: UsageInfo | null; onRefresh: () => void }) {
	const [open, setOpen] = useState(false);
	const pct = usage?.fiveHour?.pct;
	const label = !usage ? "usage" : usage.error ? "usage ⚠" : `5h ${pct != null ? `${pct.toFixed(0)}%` : "—"}`;
	return (
		<div className="usage-pill-wrap">
			<button
				className="usage-pill"
				onClick={() => {
					onRefresh();
					setOpen((o) => !o);
				}}
				title="Usage — click to refresh"
				type="button"
			>
				{label}
			</button>
			{open && (
				<div className="usage-pop up">
					{!usage ? (
						<div className="usage-err">Loading… click again</div>
					) : usage.error ? (
						<div className="usage-err">{usage.error}</div>
					) : (
						<>
							{usage.fiveHour && (
								<div className="usage-line">
									<span>5-hour</span>
									<span>
										{usage.fiveHour.pct.toFixed(0)}% used · resets in {resetLabel(usage.fiveHour.resetsAt)}
									</span>
								</div>
							)}
							{usage.sevenDay && (
								<div className="usage-line">
									<span>7-day</span>
									<span>
										{usage.sevenDay.pct.toFixed(0)}% used · resets in {resetLabel(usage.sevenDay.resetsAt)}
									</span>
								</div>
							)}
							<div className="usage-prov">{usage.provider}</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}

export function BottomBar({
	models,
	state,
	usage,
	onSetModel,
	onSetThinking,
	onRefreshUsage,
}: {
	models: ModelsPayload | null;
	state: ActiveState | null;
	usage: UsageInfo | null;
	onSetModel: (provider: string, id: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onRefreshUsage: () => void;
}) {
	const enabledSet = new Set(models?.enabled ?? []);
	const pool = (models?.available ?? []).filter((m) =>
		enabledSet.size > 0 ? enabledSet.has(`${m.provider}/${m.id}`) : true,
	);
	const current = state?.model ? `${state.model.provider}/${state.model.id}` : "";

	return (
		<div className="bottombar">
			<select
				className="model-select"
				value={current}
				onChange={(e) => {
					const [provider, ...rest] = e.target.value.split("/");
					onSetModel(provider, rest.join("/"));
				}}
			>
				{current && !pool.some((m) => `${m.provider}/${m.id}` === current) && state?.model && (
					<option value={current}>{state.model.name}</option>
				)}
				{pool.map((m) => (
					<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
						{m.name}
					</option>
				))}
			</select>

			<select
				className="thinking-select"
				value={state?.thinkingLevel ?? "off"}
				onChange={(e) => onSetThinking(e.target.value as ThinkingLevel)}
				disabled={!state?.model}
				title="Thinking level"
			>
				{THINKING.map((t) => (
					<option key={t} value={t}>
						{t}
					</option>
				))}
			</select>

			<div className="spacer" />

			{state?.contextPct != null && (
				<span className="ctx-pill" title="How much of this conversation's context window is used. Start a new chat when it gets high.">
					ctx {state.contextPct}%
				</span>
			)}
			<UsagePill usage={usage} onRefresh={onRefreshUsage} />
		</div>
	);
}
