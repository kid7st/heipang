import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";

// This log contains timings/counts only. Never persist prompts, tool arguments,
// response content, headers, account IDs, or authentication tokens.
export function measuredStream(upstream: any, model: any, options: any, logPath: string,
	idleAbort?: AbortController, callerSignal?: AbortSignal): any {
	const output = createAssistantMessageEventStream();
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const idleTimeoutMs = options?.timeoutMs ?? 120_000;
	const resetIdleTimer = () => {
		if (!idleAbort || timedOut) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => { timedOut = true; idleAbort.abort(); }, idleTimeoutMs);
		timer.unref();
	};
	resetIdleTimer();
	const started = performance.now();
	let firstEventMs: number | undefined;
	let firstTextMs: number | undefined;
	let lastEvent = started;
	let longestGapMs = 0;
	void (async () => {
		try {
			// SDK stream functions may await credential refresh/request preparation
			// before returning the event stream. Providers themselves return it directly.
			const stream = await upstream;
			for await (let event of stream) {
				resetIdleTimer();
				if (event.type === "error" && timedOut && !callerSignal?.aborted) {
					event = { ...event, reason: "error", error: { ...event.error,
						stopReason: "error", errorMessage: `Provider stream idle timeout after ${idleTimeoutMs}ms` } };
				}
				const now = performance.now();
				longestGapMs = Math.max(longestGapMs, now - lastEvent);
				lastEvent = now;
				if (firstEventMs == null) firstEventMs = now - started;
				if (event.type === "text_delta" && firstTextMs == null) firstTextMs = now - started;
				if (event.type === "done" || event.type === "error") {
					const message = event.message ?? event.error;
					const diagnostics = message?.diagnostics ?? [];
					const record = {
						at: new Date().toISOString(), provider: model.provider, model: model.id,
						transport: options?.transport ?? "auto", reasoning: options?.reasoning,
						firstEventMs: Math.round(firstEventMs ?? 0), firstTextMs: firstTextMs == null ? null : Math.round(firstTextMs),
						totalMs: Math.round(now - started), longestGapMs: Math.round(longestGapMs),
						stopReason: message?.stopReason, inputTokens: message?.usage?.input,
						cachedTokens: message?.usage?.cacheRead, outputTokens: message?.usage?.output,
						transportFailures: diagnostics.filter((d: any) => d.type === "provider_transport_failure").length,
					};
					try {
						if (existsSync(logPath) && statSync(logPath).size > 2_000_000) renameSync(logPath, `${logPath}.previous`);
						appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
					} catch { /* diagnostics must not interrupt a request */ }
				}
				output.push(event);
			}
			output.end();
		} catch (error) {
			// pi providers return error events rather than throwing. Preserve the
			// upstream result if an iterator itself fails during cleanup.
			try {
				const message = await (await upstream).result();
				output.push({ type: "error", reason: message.stopReason, error: message } as any);
				output.end();
			} catch {
				const message = {
					role: "assistant", content: [], provider: model.provider, model: model.id, api: model.api,
					timestamp: Date.now(), stopReason: callerSignal?.aborted ? "aborted" : "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				output.push({ type: "error", reason: message.stopReason, error: message } as any);
				output.end();
			}
		} finally {
			if (timer) clearTimeout(timer);
		}
	})();
	return output;
}
