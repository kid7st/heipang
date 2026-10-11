import { parentPort, workerData } from "node:worker_threads";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { SessionListItem } from "../shared/types";

// Parsing image-heavy JSONL histories must not block the provider/UI event loop.
// A metadata cache means a refresh reads only files that actually changed.
const cache = new Map<string, { signature: string; item: SessionListItem | null }>();
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
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; } // tolerate a partially appended last line
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
async function scan(): Promise<SessionListItem[]> {
	const root = String(workerData.sessionDir);
	const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
	const result: SessionListItem[] = [];
	const seen = new Set<string>();
	for (const directory of directories) {
		if (!directory.isDirectory()) continue;
		const folder = join(root, directory.name);
		const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
		for (const name of names) {
			const path = join(folder, name);
			const metadata = await stat(path).catch(() => undefined);
			if (!metadata) continue;
			seen.add(path);
			const signature = `${metadata.size}:${metadata.mtimeMs}`;
			let cached = cache.get(path);
			if (!cached || cached.signature !== signature) {
				cached = { signature, item: await readInfo(path, metadata.mtimeMs).catch(() => null) };
				cache.set(path, cached);
			}
			if (cached.item) result.push(cached.item);
		}
	}
	for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
	return result.sort((a, b) => b.modified - a.modified);
}
parentPort?.on("message", async () => {
	try { parentPort?.postMessage({ items: await scan() }); }
	catch (error) { parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
