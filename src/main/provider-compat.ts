/**
 * Provider compatibility shims that used to live as patches inside pi's
 * node_modules. pi 0.85 ships a pre-bundled core, so patching its internals is
 * no longer reliable; both fixes below work from the outside instead and keep
 * working across pi upgrades.
 */

const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Some local HTTPS proxies gzip streamed provider responses and strip
 * `content-encoding`, so nothing downstream inflates them and pi's SSE parser
 * fails with "stream ended without a stop reason". Sniff the first chunk and
 * inflate when the body really is gzip.
 */
export function installStreamDecompressionFix(): void {
	const original = globalThis.fetch;
	if (!original || (globalThis as any).__heipangGzipFix) return;
	(globalThis as any).__heipangGzipFix = true;

	globalThis.fetch = (async (input: any, init?: any) => {
		const response = await original(input as any, init as any);
		try {
			if (!response.body || response.headers.get("content-encoding")) return response;
			if (typeof DecompressionStream !== "function") return response;

			const reader = response.body.getReader();
			const first = await reader.read();
			const head = first.value as Uint8Array | undefined;
			const replay = new ReadableStream<Uint8Array>({
				start(controller) {
					if (head) controller.enqueue(head);
					if (first.done) controller.close();
				},
				async pull(controller) {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						reader.releaseLock();
						return;
					}
					controller.enqueue(next.value as Uint8Array);
				},
				cancel(reason) {
					return reader.cancel(reason);
				},
			});

			const gzipped = !!head && head.length > 1 && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
			const body = gzipped ? replay.pipeThrough(new DecompressionStream("gzip") as any) : replay;
			return new Response(body as any, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch {
			return response;
		}
	}) as typeof fetch;
}

// ---------------------------------------------------------------- PDF support
// pi carries every attachment as an image block, so PDFs reach providers as
// images and are rejected. Rewrite them in the outgoing payload instead.

type AnyRecord = Record<string, any>;

function isPdfDataUrl(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("data:application/pdf;base64,");
}

function convertAnthropicPayload(payload: AnyRecord): boolean {
	let changed = false;
	for (const message of payload.messages ?? []) {
		if (!Array.isArray(message?.content)) continue;
		message.content = message.content.map((block: AnyRecord) => {
			if (block?.type === "image" && block.source?.media_type === "application/pdf") {
				changed = true;
				return { type: "document", source: { ...block.source, media_type: "application/pdf" } };
			}
			return block;
		});
	}
	return changed;
}

function convertOpenAIPayload(payload: AnyRecord): boolean {
	let changed = false;
	const inputs = Array.isArray(payload.input) ? payload.input : [];
	for (const item of inputs) {
		if (!Array.isArray(item?.content)) continue;
		item.content = item.content.map((block: AnyRecord) => {
			if (block?.type === "input_image" && isPdfDataUrl(block.image_url)) {
				changed = true;
				return { type: "input_file", filename: block.filename || "document.pdf", file_data: block.image_url };
			}
			return block;
		});
	}
	return changed;
}

/** Returns the payload only when a PDF attachment had to be rewritten. */
export function convertPdfAttachments(payload: unknown, api: string | undefined): unknown {
	if (!payload || typeof payload !== "object") return undefined;
	const record = payload as AnyRecord;
	const changed = api === "anthropic-messages" ? convertAnthropicPayload(record) : convertOpenAIPayload(record);
	return changed ? record : undefined;
}
