import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Worker } from "node:worker_threads";

const fixtures = new Map();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => fixtures.get(String(input));
const jiti = createJiti(import.meta.url);
const { installStreamDecompressionFix, convertPdfAttachments } = await jiti.import(resolve("src/main/provider-compat.ts"));
installStreamDecompressionFix();
for (const [name, encode] of [["gzip", gzipSync], ["brotli", brotliCompressSync], ["plain", Buffer.from]]) {
	const url = `https://api.anthropic.com/v1/test-${name}`;
	fixtures.set(url, new Response(encode('{"ok":true}')));
	assert.deepEqual(await (await fetch(url)).json(), { ok: true });
}
const unicodeUrl = "https://api.anthropic.com/v1/unicode";
fixtures.set(unicodeUrl, new Response(JSON.stringify({ text: "测".repeat(100) })));
assert.equal((await (await fetch(unicodeUrl)).json()).text.length, 100);
const binary = new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fixtures.set("https://example.com/image.png", binary);
assert.equal(await fetch("https://example.com/image.png"), binary);
assert.equal((await binary.arrayBuffer()).byteLength, 4);
globalThis.fetch = originalFetch;
const pdf = { messages: [{ content: [{ type: "image", source: { media_type: "application/pdf", data: "AAA" } }] }] };
assert.equal(convertPdfAttachments(pdf, "anthropic-messages").messages[0].content[0].type, "document");

// The worker must preserve search text, names and incomplete-tail tolerance,
// observe append/delete, and never create or rewrite conversation files.
const root = await mkdtemp(join(tmpdir(), "heipang-index-test-"));
await mkdir(join(root, "workspace"));
const file = join(root, "workspace", "session.jsonl");
const header = { type: "session", id: "test", cwd: "/workspace", timestamp: "2026-10-01T00:00:00Z" };
const user = { type: "message", timestamp: header.timestamp, message: { role: "user", content: [{ type: "text", text: "Searchable user text" }], timestamp: 1000 } };
await writeFile(file, [header, user].map(JSON.stringify).join("\n") + "\n");
const worker = new Worker(resolve("out/main/session-index-worker.js"), { workerData: { sessionDir: root } });
const scan = () => new Promise((ok, fail) => { worker.once("message", ok); worker.once("error", fail); worker.postMessage("scan"); });
try {
	let result = await scan();
	assert.equal(result.items.length, 1);
	assert.equal(result.items[0].firstMessage, "Searchable user text");
	await appendFile(file, JSON.stringify({ type: "session_info", name: "Renamed" }) + "\n" + '{"partial":');
	result = await scan();
	assert.equal(result.items[0].name, "Renamed");
	assert.equal(result.items[0].messageCount, 1);
	await rm(file);
	assert.equal((await scan()).items.length, 0);
} finally { await worker.terminate(); await rm(root, { recursive: true, force: true }); }

// Timing instrumentation must preserve all stream events and final result.
const { measuredStream } = await jiti.import(resolve("src/main/request-stream.ts"));
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const temp = await mkdtemp(join(tmpdir(), "heipang-stream-test-"));
const upstream = createAssistantMessageEventStream();
const message = { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop", usage: { input: 10, output: 2 } };
const output = measuredStream(upstream, { provider: "test", id: "test" }, { reasoning: "high" }, join(temp, "timings.jsonl"));
upstream.push({ type: "text_delta", delta: "OK", partial: message });
upstream.push({ type: "done", reason: "stop", message });
upstream.end();
const events = [];
for await (const event of output) events.push(event);
assert.equal(events.length, 2);
assert.equal(await output.result(), message);
const asyncUpstream = createAssistantMessageEventStream();
const asyncOutput = measuredStream(Promise.resolve(asyncUpstream), { provider: "test", id: "test" }, {}, join(temp, "timings.jsonl"));
asyncUpstream.push({ type: "done", reason: "stop", message });
asyncUpstream.end();
assert.equal(await asyncOutput.result(), message);
// A silent server is retryable; a human pressing Stop remains aborted.
const keepAlive = setInterval(() => {}, 1000);
try {
	const controller = new AbortController();
	const silent = createAssistantMessageEventStream();
	controller.signal.addEventListener("abort", () => {
		silent.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
		silent.end();
	});
	const bounded = measuredStream(silent, { provider: "test", id: "test" }, { timeoutMs: 10 }, join(temp, "timings.jsonl"), controller);
	const timeoutResult = await bounded.result();
	assert.equal(timeoutResult.stopReason, "error");
	assert.match(timeoutResult.errorMessage, /idle timeout/);
	const cancelled = new AbortController();
	cancelled.abort();
	const aborted = createAssistantMessageEventStream();
	const stopped = measuredStream(aborted, { provider: "test", id: "test" }, {}, join(temp, "timings.jsonl"), undefined, cancelled.signal);
	aborted.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
	aborted.end();
	assert.equal((await stopped.result()).stopReason, "aborted");
} finally { clearInterval(keepAlive); }
await rm(temp, { recursive: true, force: true });
// Exercise the driver's IPC cursor and new-core lifecycle without Electron or
// reading real credentials. Construct only the methods' required state.
const shimRoot = await mkdtemp(join(tmpdir(), "heipang-driver-test-"));
const shim = join(shimRoot, "electron.mjs");
await writeFile(shim, "export const nativeImage = {};\n");
const { Driver } = await createJiti(import.meta.url, { alias: { electron: shim } }).import(resolve("src/main/driver.ts"));
const driver = Object.create(Driver.prototype);
driver.sentUiCount = 0; driver.sentRawCount = 0; driver.sentTailUiCount = 0;
driver.session = { messages: [] };
let ui = [];
driver.onMessages = (messages) => { ui = messages; };
driver.onMessagesPatch = (from, messages) => { ui = ui.slice(0, from).concat(messages); };
for (const role of ["user", "custom", "assistant", "toolResult", "custom", "assistant"]) {
	driver.session.messages.push({ role, content: [{ type: "text", text: "Hello" }], timestamp: 0 });
	driver.emitMessages();
	assert.deepEqual(ui, driver.toUIMessages(driver.session.messages));
}
driver.session.messages.at(-1).content[0].text = "Updated";
driver.emitMessages();
assert.deepEqual(ui, driver.toUIMessages(driver.session.messages));
driver.session.messages = driver.session.messages.slice(0, 2);
driver.emitMessages();
assert.deepEqual(ui, driver.toUIMessages(driver.session.messages));

let listener;
let finished = 0;
driver.session = { sessionId: "test", sessionFile: "test", subscribe: (callback) => { listener = callback; return () => {}; } };
driver.flushEmit = () => {};
driver.emitState = () => {};
driver.markRunEnd = () => {};
driver.scheduleGuiRetry = () => {};
driver.scheduleAutoExtract = () => {};
driver.guiRetryTimers = new Map();
driver.onRunComplete = () => { finished++; };
driver.wireSession();
listener({ type: "agent_end" });
assert.equal(finished, 0); // retries/compaction may still follow
listener({ type: "agent_settled" });
assert.equal(finished, 1);

let disposed = 0;
driver.session = { sessionId: "background", sessionFile: "background", isIdle: false, isStreaming: false,
	subscribe: (callback) => { listener = callback; return () => {}; }, dispose: () => { disposed++; } };
driver.bgSessions = new Map();
driver.clearSessionUiState = () => {};
driver.emitBackground = () => {};
driver.leaveCurrent();
assert.equal(driver.bgSessions.size, 1); // a sleeping retry must remain alive
listener({ type: "agent_end" });
assert.equal(disposed, 0);
listener({ type: "agent_settled" });
assert.equal(disposed, 1);
await rm(shimRoot, { recursive: true, force: true });
console.log("PASS: decoding isolation, PDF conversion, incremental index, stream fidelity, IPC cursor, settlement lifecycle");
