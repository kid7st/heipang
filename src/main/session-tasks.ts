import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Task } from "../shared/types.js";

type ExtractionResult = { ok: boolean; tasks?: Task[]; error?: string };

function capTitle(title: string): string {
	return title.trim().replace(/\s+/g, " ").slice(0, 20);
}

function normalize(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

function parseTitles(text: string): string[] {
	let json = text.trim();
	const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) json = fence[1].trim();
	const start = json.indexOf("{");
	const end = json.lastIndexOf("}");
	if (start >= 0 && end > start) json = json.slice(start, end + 1);
	const parsed = JSON.parse(json);
	const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
	if (!Array.isArray(tasks)) throw new Error("Task extraction returned no task list");
	return tasks.map((value) => typeof value === "string" ? value : value?.title)
		.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map(capTitle);
}

export class SessionTasks {
	private tasks: Task[] = [];
	private counter = 0;
	private lastUserCount = -1;
	private inflight?: Promise<ExtractionResult>;
	private timer?: ReturnType<typeof setTimeout>;
	private controller = new AbortController();

	constructor(
		private session: AgentSession,
		private headers: (model: unknown) => Record<string, string>,
		private changed: (tasks: Task[]) => void,
		private failed: (message: string) => void,
	) {
		const path = this.sidecar();
		if (!path || !existsSync(path)) return;
		try {
			const data = JSON.parse(readFileSync(path, "utf8"));
			if (!Array.isArray(data.tasks) || typeof data.counter !== "number") throw new Error("Invalid task file");
			this.tasks = data.tasks;
			this.counter = data.counter;
		} catch {
			this.failed("Could not read this session's saved tasks.");
		}
	}

	private sidecar(): string | undefined {
		return this.session.sessionFile ? `${this.session.sessionFile}.tasks.json` : undefined;
	}

	private persist(): void {
		const path = this.sidecar();
		if (!path || this.controller.signal.aborted) return;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ tasks: this.tasks, counter: this.counter }, null, 2)}\n`, "utf8");
	}

	get(): Task[] { return [...this.tasks]; }

	update(task: Task): Task[] {
		this.tasks = this.tasks.map((saved) => saved.id === task.id ? { ...saved, ...task, updatedAt: Date.now() } : saved);
		this.persist();
		return this.get();
	}

	delete(id: string): Task[] {
		this.tasks = this.tasks.filter((task) => task.id !== id);
		this.persist();
		return this.get();
	}

	cancelScheduled(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.cancelScheduled();
		this.controller.abort();
	}

	schedule(): void {
		this.cancelScheduled();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.extract(false).then((result) => {
				if (result.ok && result.tasks) this.changed(result.tasks);
				else if (result.error && !this.controller.signal.aborted) this.failed(result.error);
			});
		}, 1500);
	}

	extract(force = true): Promise<ExtractionResult> {
		if (!this.inflight) this.inflight = this.runExtraction(force).finally(() => { this.inflight = undefined; });
		return this.inflight;
	}

	private async runExtraction(force: boolean): Promise<ExtractionResult> {
		try {
			const userCount = this.session.messages.filter((message) => message.role === "user").length;
			if (!force && userCount === this.lastUserCount) return { ok: true, tasks: this.get() };
			const available = await this.session.modelRuntime.getAvailable();
			const model = available.find((entry) => entry.provider === "anthropic" && /haiku-4/.test(entry.id))
				?? this.session.model ?? available[0];
			if (!model) return { ok: false, error: "No model available for extraction" };
			const lines = this.session.messages.flatMap((message: any): string[] => {
				if (message.role !== "user" && message.role !== "assistant") return [];
				const text = typeof message.content === "string" ? message.content
					: (message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join(" ");
				return text.trim() ? [`${message.role.toUpperCase()}: ${text.trim().slice(0, message.role === "user" ? 600 : 300)}`] : [];
			});
			if (!lines.length) return { ok: true, tasks: this.get() };
			let transcript = "";
			for (let i = lines.length - 1; i >= 0; i--) {
				if (transcript.length + lines[i].length > 16000) break;
				transcript = `${lines[i]}\n${transcript}`;
			}
			const open = this.tasks.filter((task) => task.status === "open").map((task) => `- ${task.title}`);
			const result = await this.session.modelRuntime.completeSimple(model, {
				systemPrompt: "You extract a short reminder list of distinct TASKS (small projects or informal requests the user raised) from a conversation. " +
					"Group multiple turns about the same thing into ONE task. Each task title MUST be an ultra-short reminder of at most 20 characters (count CJK characters as 1 each), a noun phrase in the user's own language, NOT a sentence or quote. " +
					"Example good titles: '图片归类', '加外链', 'fix login bug'. Ignore chit-chat and clarifications. Return STRICT JSON only: {\"tasks\":[\"title\", ...]}. No prose.",
				messages: [{ role: "user", content: (open.length ? `Existing open tasks (reuse wording if the same task still applies):\n${open.join("\n")}\n\n` : "") + `Conversation:\n${transcript}`, timestamp: Date.now() }],
			}, { maxTokens: 1024, headers: this.headers(model), signal: this.controller.signal });
			if (this.controller.signal.aborted) return { ok: false, error: "Task extraction cancelled" };
			if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || "Task extraction failed");
			const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			const titles = parseTitles(text);
			if (titles.length) this.reconcile(titles);
			this.lastUserCount = userCount;
			return { ok: true, tasks: this.get() };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private reconcile(titles: string[]): void {
		const now = Date.now();
		const preserved = this.tasks.filter((task) => task.status !== "open" || task.sourceIndex === -1);
		const seen = new Set(preserved.map((task) => normalize(task.title)));
		const existing = new Map(this.tasks.filter((task) => task.status === "open").map((task) => [normalize(task.title), task]));
		this.tasks = [...preserved];
		for (const title of titles) {
			const key = normalize(title);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			this.tasks.push(existing.get(key) ?? { id: `a${++this.counter}`, title, status: "open", sourceIndex: 0, createdAt: now, updatedAt: now });
		}
		this.persist();
	}
}
