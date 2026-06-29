import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetaClassification, MetaInboxItem, MetaProject, MetaProjectInbox, MetaRec, MetaStatus } from "../../../shared/types";
import {
	ArrowRightIcon,
	CheckIcon,
	ChevronRightIcon,
	CloseIcon,
	MicIcon,
	PauseIcon,
	TargetIcon,
	TrashIcon,
	UndoIcon,
	WarnIcon,
} from "./icons";

type MetaTab = "pending" | "processed" | "ideas";

function trim(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Collect the full bundled CSS so an exported card looks pixel-identical.
function pageCss(): string {
	let out = "";
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			for (const rule of Array.from(sheet.cssRules)) out += `${rule.cssText}\n`;
		} catch {
			/* cross-origin sheet, skip */
		}
	}
	return out;
}

function safeName(s: string): string {
	return s.replace(/[\\/:*?"<>|\n\r\t]/g, "-").slice(0, 40) || "card";
}

interface Props {
	flash: (m: string) => void;
	onStartTodo: (cwd: string, seed: string) => void;
	onOpenConfig: () => void;
	onChanged: () => void;
	refreshKey: number;
}

export function MetaVincent({ flash, onStartTodo, onOpenConfig, onChanged, refreshKey }: Props) {
	const [tab, setTab] = useState<MetaTab>("pending");
	const [statusFilter, setStatusFilter] = useState<MetaStatus>("pending");
	const [recs, setRecs] = useState<MetaRec[]>([]);
	const [projects, setProjects] = useState<MetaProject[]>([]);
	const [ideas, setIdeas] = useState<MetaInboxItem[]>([]);
	const [inboxCwd, setInboxCwd] = useState<string | null>(null);
	const [inbox, setInbox] = useState<MetaProjectInbox>({ todo: [], idea: [], memory: [] });
	const [ideaSel, setIdeaSel] = useState<Record<number, string>>({});

	// Sort modal state
	const [modalRec, setModalRec] = useState<MetaRec | null>(null);
	const [cls, setCls] = useState<MetaClassification | null>(null);
	const [clsLoading, setClsLoading] = useState(false);
	const [projSel, setProjSel] = useState("");
	const [memChecked, setMemChecked] = useState<Set<number>>(new Set());
	const [todoChecked, setTodoChecked] = useState<Set<number>>(new Set());
	const [ideaChecked, setIdeaChecked] = useState<Set<number>>(new Set());
	const [ideaDest, setIdeaDest] = useState<Record<number, string>>({});
	const modalRef = useRef<HTMLDivElement | null>(null);

	const loadRecs = useCallback(async () => {
		setRecs(await window.pi.metaListRecordings());
	}, []);
	const loadProjects = useCallback(async () => {
		setProjects(await window.pi.metaListProjects());
	}, []);
	const loadIdeas = useCallback(async () => {
		setIdeas(await window.pi.metaListIdeas());
	}, []);

	useEffect(() => {
		loadRecs();
		loadProjects();
		loadIdeas();
	}, [loadRecs, loadProjects, loadIdeas, refreshKey]);

	const counts = useMemo(() => {
		const c = { pending: 0, processed: 0, snoozed: 0, hidden: 0 };
		for (const r of recs) c[r.status]++;
		return c;
	}, [recs]);

	// Processed: pick a project with inbox items
	const projWithItems = useMemo(() => projects.filter((p) => p.count > 0), [projects]);
	useEffect(() => {
		if (tab !== "processed") return;
		if (!projWithItems.length) {
			setInboxCwd(null);
			return;
		}
		if (!inboxCwd || !projWithItems.some((p) => p.cwd === inboxCwd)) setInboxCwd(projWithItems[0].cwd);
	}, [tab, projWithItems, inboxCwd]);
	useEffect(() => {
		if (tab === "processed" && inboxCwd) window.pi.metaGetInbox(inboxCwd).then(setInbox);
	}, [tab, inboxCwd, refreshKey]);

	const refreshAfterChange = useCallback(() => {
		loadRecs();
		loadProjects();
		loadIdeas();
		if (inboxCwd) window.pi.metaGetInbox(inboxCwd).then(setInbox);
		onChanged();
	}, [loadRecs, loadProjects, loadIdeas, inboxCwd, onChanged]);

	const openNote = (path: string) => {
		if (path) window.pi.openPath(path);
	};

	// ---- card actions ----
	const setStatus = async (recId: string, status: MetaStatus, msg: string) => {
		await window.pi.metaSetStatus(recId, status);
		flash(msg);
		refreshAfterChange();
	};
	const undo = async (recId: string) => {
		await window.pi.metaUndo(recId);
		flash("Undone");
		refreshAfterChange();
	};

	// ---- sort modal ----
	const openSort = async (rec: MetaRec) => {
		setModalRec(rec);
		setCls(null);
		setProjSel("");
		setMemChecked(new Set());
		setTodoChecked(new Set(rec.todo.map((_t, i) => i)));
		setIdeaChecked(new Set(rec.ideas.map((_t, i) => i)));
		setIdeaDest({});
		setClsLoading(true);
		try {
			const c = await window.pi.metaClassify(rec.recId);
			setCls(c);
			setProjSel(c.cwd ?? "");
			const dest: Record<number, string> = {};
			c.ideaCwds.forEach((cwd, i) => {
				dest[i] = cwd ?? "";
			});
			setIdeaDest(dest);
		} catch {
			setCls({ ideaCwds: rec.ideas.map(() => undefined) });
		} finally {
			setClsLoading(false);
		}
	};
	const closeSort = () => {
		setModalRec(null);
		setCls(null);
	};

	const toggleSet = (set: Set<number>, setFn: (s: Set<number>) => void, i: number) => {
		const n = new Set(set);
		if (n.has(i)) n.delete(i);
		else n.add(i);
		setFn(n);
	};

	const confirmSort = async () => {
		if (!modalRec) return;
		const rec = modalRec;
		const memory = [...memChecked].sort((a, b) => a - b).map((i) => rec.memory[i]);
		const todo = [...todoChecked].sort((a, b) => a - b).map((i) => rec.todo[i]);
		const ideaList = [...ideaChecked].sort((a, b) => a - b).map((i) => ({ text: rec.ideas[i], cwd: ideaDest[i] || undefined }));
		if ((memory.length || todo.length) && !projSel) {
			flash("Pick a project for memory / to-do first");
			return;
		}
		if (!memory.length && !todo.length && !ideaList.length) {
			flash("Nothing selected");
			return;
		}
		const parts: string[] = [];
		if (memory.length) parts.push(`${memory.length} memory`);
		if (todo.length) parts.push(`${todo.length} to-do`);
		if (ideaList.length) parts.push(`${ideaList.length} ideas`);
		const projectName = projects.find((p) => p.cwd === projSel)?.name ?? "";
		await window.pi.metaConfirmSort(rec.recId, {
			cwd: projSel,
			projectName,
			memory,
			todo,
			ideas: ideaList,
			summary: parts.join(" · "),
		});
		closeSort();
		flash("Sorted");
		refreshAfterChange();
	};

	// ---- share / export (clone the real Sort card 1:1) ----
	const buildCardHtml = (): string | null => {
		const modal = modalRef.current;
		if (!modal) return null;
		const clone = modal.cloneNode(true) as HTMLElement;
		const li = modal.querySelectorAll("input");
		const ci = clone.querySelectorAll("input");
		li.forEach((el, i) => {
			const c = ci[i] as HTMLInputElement | undefined;
			if (!c) return;
			if ((el as HTMLInputElement).checked) c.setAttribute("checked", "checked");
			else c.removeAttribute("checked");
		});
		const ls = modal.querySelectorAll("select");
		const cs = clone.querySelectorAll("select");
		ls.forEach((el, i) => {
			const c = cs[i] as HTMLSelectElement | undefined;
			if (!c) return;
			const opts = c.querySelectorAll("option");
			opts.forEach((o) => o.removeAttribute("selected"));
			const sel = opts[(el as HTMLSelectElement).selectedIndex];
			if (sel) sel.setAttribute("selected", "selected");
		});
		clone.querySelector(".mv-sharebar")?.remove();
		return `<!doctype html><html><head><meta charset="utf-8"><title>${
			modalRec ? modalRec.title : "card"
		}</title><style>${pageCss()}</style></head><body style="margin:0;background:#cfd6cf;display:flex;justify-content:center;padding:28px 16px"><div style="width:600px;max-width:100%">${clone.outerHTML}</div></body></html>`;
	};

	const exportHtml = async () => {
		const html = buildCardHtml();
		if (!html || !modalRec) return;
		const r = await window.pi.metaExportHtml(html, safeName(modalRec.title));
		if (r.ok) flash("HTML exported (exact copy)");
		else if (r.error) flash(r.error);
	};
	const exportPng = async () => {
		const html = buildCardHtml();
		if (!html || !modalRec) return;
		flash("Rendering PNG…");
		const r = await window.pi.metaExportPng(html, safeName(modalRec.title));
		if (r.ok) flash("PNG exported");
		else if (r.error) flash(r.error);
	};
	const copyLink = async () => {
		const html = buildCardHtml();
		if (!html) return;
		flash("Uploading…");
		const r = await window.pi.metaShareLink(html);
		if (r.ok && r.url) {
			try {
				await navigator.clipboard.writeText(r.url);
			} catch {
				/* ignore */
			}
			flash("Link copied to clipboard");
		} else if (r.error) flash(r.error);
	};

	const willSort = useMemo(() => {
		const parts: string[] = [];
		if (memChecked.size) parts.push(`${memChecked.size} memory`);
		if (todoChecked.size) parts.push(`${todoChecked.size} to-do`);
		if (ideaChecked.size) parts.push(`${ideaChecked.size} ideas`);
		return parts.length ? `Will sort: ${parts.join(" · ")}` : "Nothing selected";
	}, [memChecked, todoChecked, ideaChecked]);

	// ---------------------------------------------------------------- render
	const srcLine = (notePath: string, label: string) => (
		<span className="src" onClick={() => openNote(notePath)} title="Open the recording note">
			<MicIcon size={11} />
			{label}
		</span>
	);

	const boardRows = recs.filter((r) => r.status === statusFilter);

	return (
		<div className="mv">
			<div className="mv-header">
				<div className="t">
					<span className="f">Meta Vincent</span>
					<span className="ti">Sort daily recordings into projects</span>
				</div>
				<button className="mv-cfg" onClick={onOpenConfig} type="button">
					Recordings folder…
				</button>
			</div>
			<div className="mv-scroll">
				<div className="mv-subnav">
					<button className={tab === "pending" ? "on" : ""} onClick={() => setTab("pending")} type="button">
						Pending<span className="nb">{counts.pending}</span>
					</button>
					<button className={tab === "processed" ? "on" : ""} onClick={() => setTab("processed")} type="button">
						Processed
					</button>
					<button className={tab === "ideas" ? "on" : ""} onClick={() => setTab("ideas")} type="button">
						Ideas<span className="nb">{ideas.length}</span>
					</button>
					<span className="grow" />
					{tab === "pending" && (
						<select className="mv-statussel" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as MetaStatus)}>
							<option value="pending">Pending ({counts.pending})</option>
							<option value="snoozed">Snoozed ({counts.snoozed})</option>
							<option value="hidden">Hidden ({counts.hidden})</option>
						</select>
					)}
				</div>

				{tab === "pending" && (
					<Board
						rows={boardRows}
						statusFilter={statusFilter}
						onOpenNote={openNote}
						onSort={openSort}
						onSnooze={(id) => setStatus(id, "snoozed", "Snoozed")}
						onHide={(id) => setStatus(id, "hidden", "Hidden (file kept)")}
						onUndo={undo}
					/>
				)}

				{tab === "processed" &&
					(projWithItems.length === 0 ? (
						<div className="mv-empty">
							<div className="ei">📥</div>
							<p>Nothing sorted into projects yet. Sort a few from Pending.</p>
						</div>
					) : (
						<>
							<div className="mv-projbar">
								<span className="lab">Project</span>
								<select className="mv-select" value={inboxCwd ?? ""} onChange={(e) => setInboxCwd(e.target.value)}>
									{projWithItems.map((p) => (
										<option key={p.cwd} value={p.cwd}>
											{p.name} ({p.count})
										</option>
									))}
								</select>
							</div>
							<Section title="To-do" dot="todo" count={inbox.todo.length}>
								{inbox.todo.length === 0 ? (
									<div className="mv-none">No to-dos</div>
								) : (
									inbox.todo.map((x, i) => (
										<div className={`mv-item${x.done ? " done" : ""}`} key={`t${i}`}>
											<input
												type="checkbox"
												checked={!!x.done}
												onChange={async () => setInbox(await window.pi.metaInboxAction(inboxCwd!, "toggleTodo", i))}
											/>
											<div className="body">
												<div className="tt">{x.text}</div>
												{srcLine(x.src.notePath, `${x.src.date} ${x.src.time} · ${trim(x.src.title, 26)}`)}
											</div>
											<div className="ops">
												{x.started ? (
													<span className="mv-chip opened">→ session opened</span>
												) : (
													<button
														className="mv-sbtn"
														style={{ padding: "3px 9px", fontSize: 11.5 }}
														onClick={async () => {
															await window.pi.metaInboxAction(inboxCwd!, "markStarted", i);
															onStartTodo(inboxCwd!, x.text);
														}}
														type="button"
													>
														<ArrowRightIcon size={13} />
														Start
													</button>
												)}
												<button
													className="mv-iconbtn"
													title="Delete"
													onClick={async () => setInbox(await window.pi.metaInboxAction(inboxCwd!, "deleteTodo", i))}
													type="button"
												>
													<TrashIcon />
												</button>
											</div>
										</div>
									))
								)}
							</Section>
							<Section title="Ideas" dot="idea" count={inbox.idea.length}>
								{inbox.idea.length === 0 ? (
									<div className="mv-none">No ideas</div>
								) : (
									inbox.idea.map((x, i) => (
										<div className="mv-item" key={`i${i}`}>
											<span className="mv-tagdot idea" style={{ marginTop: 5 }} />
											<div className="body">
												<div className="tt">{x.text}</div>
												{srcLine(x.src.notePath, `${x.src.date} ${x.src.time} · ${trim(x.src.title, 26)}`)}
											</div>
											<div className="ops">
												<button
													className="mv-iconbtn"
													title="Move to Ideas pool"
													onClick={async () => {
														setInbox(await window.pi.metaInboxAction(inboxCwd!, "ideaToPool", i));
														loadIdeas();
														onChanged();
													}}
													type="button"
												>
													<UndoIcon />
												</button>
												<button
													className="mv-iconbtn"
													title="Delete"
													onClick={async () => setInbox(await window.pi.metaInboxAction(inboxCwd!, "deleteIdea", i))}
													type="button"
												>
													<TrashIcon />
												</button>
											</div>
										</div>
									))
								)}
							</Section>
							<Section title="Memory (AGENTS.md)" dot="mem" count={inbox.memory.length}>
								{inbox.memory.length === 0 ? (
									<div className="mv-none">None (check “Memory” while sorting to add here)</div>
								) : (
									<div className="mv-agents">
										<div className="mv-agln base">## Memory from recordings</div>
										{inbox.memory.map((x, i) => (
											<div className="mv-agln" key={`m${i}`}>
												<span>- {x.text}</span>
												<button
													className="mv-iconbtn"
													title="Delete (also removes the line from AGENTS.md)"
													onClick={async () => {
														setInbox(await window.pi.metaInboxAction(inboxCwd!, "deleteMemory", i));
														onChanged();
													}}
													type="button"
												>
													<TrashIcon />
												</button>
											</div>
										))}
									</div>
								)}
							</Section>
						</>
					))}

				{tab === "ideas" &&
					(ideas.length === 0 ? (
						<div className="mv-empty">
							<div className="ei">💡</div>
							<p>No ideas yet. Sorted ideas land here by default.</p>
						</div>
					) : (
						<div className="mv-section" style={{ marginTop: 16 }}>
							{ideas.map((x, i) => (
								<div className="mv-item" key={`l${i}`}>
									<span className="mv-tagdot idea" style={{ marginTop: 5 }} />
									<div className="body">
										<div className="tt">{x.text}</div>
										{srcLine(x.src.notePath, `${x.src.date} ${x.src.time} · ${trim(x.src.title, 26)}`)}
									</div>
									<div className="ops">
										<select
											className="mv-select mv-mini"
											value={ideaSel[i] ?? ""}
											onChange={(e) => setIdeaSel((s) => ({ ...s, [i]: e.target.value }))}
										>
											<option value="">File to project…</option>
											{projects.map((p) => (
												<option key={p.cwd} value={p.cwd}>
													{p.name}
												</option>
											))}
										</select>
										<button
											className="mv-iconbtn"
											title="File to selected project"
											onClick={async () => {
												const dest = ideaSel[i];
												if (!dest) {
													flash("Pick a project first");
													return;
												}
												setIdeas(await window.pi.metaIdeaAction("fileToProject", i, dest));
												setIdeaSel({});
												loadProjects();
												onChanged();
												flash("Filed to project");
											}}
											type="button"
										>
											<ArrowRightIcon />
										</button>
										<button
											className="mv-iconbtn"
											title="Delete"
											onClick={async () => setIdeas(await window.pi.metaIdeaAction("delete", i))}
											type="button"
										>
											<TrashIcon />
										</button>
									</div>
								</div>
							))}
						</div>
					))}
			</div>

			{modalRec && (
				<div className="mv-scrim" onClick={(e) => e.target === e.currentTarget && closeSort()}>
					<div className="mv-modal" ref={modalRef}>
						<div className="mv-mhead">
							<div>
								<div className="ti">
									{modalRec.date} {modalRec.time}
								</div>
								<h2>{modalRec.title}</h2>
							</div>
							<button className="x" onClick={closeSort} type="button">
								<CloseIcon />
							</button>
						</div>
						<div className="mv-mbody">
							<div className="mv-sharebar">
								<span className="sl">Share this breakdown</span>
								<button className="mv-sbtn xs" onClick={exportPng} type="button">
									PNG
								</button>
								<button className="mv-sbtn xs" onClick={exportHtml} type="button">
									HTML
								</button>
								<button className="mv-sbtn xs" onClick={copyLink} type="button">
									Copy link
								</button>
							</div>
							<div className={`mv-judge ${clsLoading ? "nomatch" : projSel ? "match" : "nomatch"}`}>
								<span className="ic">{!clsLoading && projSel ? <TargetIcon /> : <WarnIcon />}</span>
								<span className="lab">Suggested project</span>
								<select className="mv-select" value={projSel} onChange={(e) => setProjSel(e.target.value)} disabled={clsLoading}>
									<option value="">{clsLoading ? "matching…" : "— no match, pick one —"}</option>
									{projects.map((p) => (
										<option key={p.cwd} value={p.cwd}>
											{p.name}
										</option>
									))}
								</select>
							</div>

							<Bucket title="Memory" count={`${modalRec.memory.length} candidates · off by default; only the foundational`} dest="mem" destLabel="→ AGENTS.md">
								{modalRec.memory.length === 0 ? (
									<div className="mv-none2">(none in this recording)</div>
								) : (
									modalRec.memory.map((t, i) => (
										<label className={`mv-atom${memChecked.has(i) ? "" : " off"}`} key={`bm${i}`}>
											<input type="checkbox" checked={memChecked.has(i)} onChange={() => toggleSet(memChecked, setMemChecked, i)} />
											<span className="txt">{t}</span>
										</label>
									))
								)}
							</Bucket>

							<Bucket title="To-do" count={`${modalRec.todo.length} items`} dest="task" destLabel="→ project inbox">
								{modalRec.todo.length === 0 ? (
									<div className="mv-none2">(none in this recording)</div>
								) : (
									modalRec.todo.map((t, i) => (
										<label className={`mv-atom${todoChecked.has(i) ? "" : " off"}`} key={`bt${i}`}>
											<input type="checkbox" checked={todoChecked.has(i)} onChange={() => toggleSet(todoChecked, setTodoChecked, i)} />
											<span className="txt">{t}</span>
										</label>
									))
								)}
							</Bucket>

							<Bucket title="Ideas" count={`${modalRec.ideas.length} items`} dest="idea" destLabel="→ Ideas by default · or a project">
								{modalRec.ideas.length === 0 ? (
									<div className="mv-none2">(none in this recording)</div>
								) : (
									modalRec.ideas.map((t, i) => (
										<label className={`mv-atom${ideaChecked.has(i) ? "" : " off"}`} key={`bi${i}`}>
											<input type="checkbox" checked={ideaChecked.has(i)} onChange={() => toggleSet(ideaChecked, setIdeaChecked, i)} />
											<span className="txt">{t}</span>
											<select
												className="mv-select mv-mini"
												value={ideaDest[i] ?? ""}
												onClick={(e) => e.preventDefault()}
												onChange={(e) => setIdeaDest((d) => ({ ...d, [i]: e.target.value }))}
											>
												<option value="">Ideas{!ideaDest[i] ? " (suggested)" : ""}</option>
												{projects.map((p) => (
													<option key={p.cwd} value={p.cwd}>
														{p.name}
														{cls?.ideaCwds[i] === p.cwd ? " (suggested)" : ""}
													</option>
												))}
											</select>
										</label>
									))
								)}
							</Bucket>

							<div className="mv-mnote">
								Memory (AGENTS.md) only keeps things the agent should always know and that rarely change — usually empty. Confirm only appends; it never rewrites your AGENTS.md.
							</div>
						</div>
						<div className="mv-mfoot">
							<button
								className="mv-sbtn"
								onClick={() => {
									setStatus(modalRec.recId, "snoozed", "Snoozed");
									closeSort();
								}}
								type="button"
							>
								<PauseIcon /> Snooze instead
							</button>
							<span className="cntline">{willSort}</span>
							<span className="spacer" />
							<button className="mv-sbtn" onClick={closeSort} type="button">
								Cancel
							</button>
							<button className="mv-sbtn primary" onClick={confirmSort} type="button">
								<CheckIcon /> Confirm
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function Board({
	rows,
	statusFilter,
	onOpenNote,
	onSort,
	onSnooze,
	onHide,
	onUndo,
}: {
	rows: MetaRec[];
	statusFilter: MetaStatus;
	onOpenNote: (p: string) => void;
	onSort: (r: MetaRec) => void;
	onSnooze: (id: string) => void;
	onHide: (id: string) => void;
	onUndo: (id: string) => void;
}) {
	if (rows.length === 0) {
		return (
			<div className="mv-empty">
				<div className="ei">🎙️</div>
				<p>Nothing here.</p>
			</div>
		);
	}
	return (
		<div className="mv-grid">
			{rows.map((it) => (
				<div className="mv-card" key={it.recId}>
					<div className="date">
						{it.date} {it.time}
					</div>
					<h3 onClick={() => onOpenNote(it.notePath)} title="Open the recording note">
						{it.title}
					</h3>
					<div className="row">
						{statusFilter === "pending" && (
							<>
								<button className="mv-sbtn primary" onClick={() => onSort(it)} type="button">
									<CheckIcon /> Sort
								</button>
								<button className="mv-sbtn" onClick={() => onSnooze(it.recId)} type="button">
									<PauseIcon /> Snooze
								</button>
								<span className="spacer" />
								<button className="mv-sbtn icon" title="Hide" onClick={() => onHide(it.recId)} type="button">
									<CloseIcon />
								</button>
							</>
						)}
						{statusFilter === "snoozed" && (
							<>
								<span className="mv-statusnote">
									<span className="mv-dot hold" /> Snoozed
								</span>
								<span className="spacer" />
								<button className="mv-sbtn primary" onClick={() => onSort(it)} type="button">
									<CheckIcon /> Sort
								</button>
								<button className="mv-sbtn icon" title="Undo" onClick={() => onUndo(it.recId)} type="button">
									<UndoIcon />
								</button>
							</>
						)}
						{statusFilter === "hidden" && (
							<>
								<span className="mv-statusnote">
									<span className="mv-dot no" /> Hidden
								</span>
								<span className="spacer" />
								<button className="mv-sbtn icon" title="Undo" onClick={() => onUndo(it.recId)} type="button">
									<UndoIcon />
								</button>
							</>
						)}
					</div>
				</div>
			))}
		</div>
	);
}

function Section({ title, dot, count, children }: { title: string; dot: string; count: number; children: React.ReactNode }) {
	return (
		<div className="mv-section">
			<h4>
				<span className={`mv-tagdot ${dot}`} />
				{title} <span className="c">{count}</span>
			</h4>
			{children}
		</div>
	);
}

function Bucket({
	title,
	count,
	dest,
	destLabel,
	children,
}: {
	title: string;
	count: string;
	dest: string;
	destLabel: string;
	children: React.ReactNode;
}) {
	return (
		<div className="mv-bucket">
			<div className="mv-bhead">
				<span className="bt">{title}</span>
				<span className="bc">{count}</span>
				<span className={`mv-dest dest ${dest}`}>{destLabel}</span>
			</div>
			<div className="mv-atoms">{children}</div>
		</div>
	);
}
