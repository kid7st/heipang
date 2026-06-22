// Singleton worker client for async syntax highlighting.
// Only visible code blocks call into this (virtua unmounts off-screen messages).

import HighlightWorker from "./highlight.worker.ts?worker";

const worker = new HighlightWorker();
let seq = 0;
const pending = new Map<number, (html: string) => void>();

worker.onmessage = (e: MessageEvent<{ id: number; html: string }>) => {
	const cb = pending.get(e.data.id);
	if (cb) {
		pending.delete(e.data.id);
		cb(e.data.html);
	}
};

export function highlight(code: string, lang?: string): Promise<string> {
	return new Promise((resolve) => {
		const id = ++seq;
		pending.set(id, resolve);
		worker.postMessage({ id, code, lang });
	});
}
