import { parentPort, workerData } from "node:worker_threads";
import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { SessionListItem } from "../shared/types";

// Parsing image-heavy JSONL histories must not block the provider/UI event loop.
// A metadata cache means a refresh reads only files that actually changed.
export interface SessionIndexResult {
	items: SessionListItem[];
	errors: string[];
}

const cache = new Map<string, { signature: string; item: SessionListItem | null }>();

function ignoreMissing<T>(error: unknown): T[] {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
	throw error;
}
async function readInfo(path: string, modifiedFallback: number): Promise<SessionListItem | null> {
	let header: any;
	let name: string | undefined;
	let count = 0;
	let first = "";
	let modified = 0;
	const texts: string[] = [];
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			if (!entry || typeof entry !== "object") continue;
			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}
			if (entry.type === "session_info") name = entry.name?.trim() || undefined;
			if (entry.type !== "message") continue;
			count++;
			const message = entry.message;
			if (message?.role !== "user" && message?.role !== "assistant") continue;
			const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
			if (Number.isFinite(timestamp)) modified = Math.max(modified, timestamp);
			const content = message.content;
			const text = typeof content === "string" ? content : Array.isArray(content)
				? content.filter((block: any) => block.type === "text").map((block: any) => block.text).join(" ") : "";
			if (!text) continue;
			texts.push(text);
			if (!first && message.role === "user") first = text;
		}
	} finally { lines.close(); input.destroy(); }
	if (!header) return null;
	const created = Date.parse(header.timestamp);
	return { path, id: header.id, cwd: header.cwd ?? "", name,
		created, modified: modified || (Number.isFinite(created) ? created : modifiedFallback),
		messageCount: count, firstMessage: first || "(no messages)", allMessagesText: texts.join(" ") };
}
async function scan(): Promise<SessionIndexResult> {
	const root = String(workerData.sessionDir);
	const directories = await readdir(root, { withFileTypes: true }).catch(ignoreMissing<Dirent>);
	const items: SessionListItem[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const directory of directories) {
		if (!directory.isDirectory()) continue;
		const folder = join(root, directory.name);
		let names: string[];
		try { names = (await readdir(folder).catch(ignoreMissing<string>)).filter((name) => name.endsWith(".jsonl")); }
		catch (error) {
			errors.push(`Could not index session folder ${folder}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const name of names) {
			const path = join(folder, name);
			try {
				const metadata = await stat(path);
				seen.add(path);
				const signature = `${metadata.size}:${metadata.mtimeMs}`;
				let cached = cache.get(path);
				if (!cached || cached.signature !== signature) {
					cached = { signature, item: await readInfo(path, metadata.mtimeMs) };
					cache.set(path, cached);
				}
				if (cached.item) items.push(cached.item);
			} catch (error) {
				cache.delete(path);
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				errors.push(`Could not index session ${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
	return { items: items.sort((a, b) => b.modified - a.modified), errors };
}
parentPort?.on("message", async () => {
	try { parentPort?.postMessage(await scan()); }
	catch (error) { parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
