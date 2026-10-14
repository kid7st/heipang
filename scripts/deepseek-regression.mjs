import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// No real API key, request, or credential write is used by these tests.
const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
const model = { ...runtime.getModel("deepseek", "deepseek-v4-pro"), input: ["text"] };
assert.equal(model.contextWindow, 1_000_000);
assert.equal(model.maxTokens, 384_000);
assert.deepEqual(getSupportedThinkingLevels(model), ["off", "high", "max"]);
let payload;
const fakeFetch = async (_url, options) => {
	payload = JSON.parse(options.body);
	const event = { id: "fixture", object: "chat.completion.chunk", model: model.id,
		choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] };
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};
for (const level of [undefined, "high", "max"]) {
	const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Test", timestamp: 0 }] },
		{ apiKey: "fixture-key", fetch: fakeFetch, reasoning: level, maxTokens: 16 });
	assert.equal(result.stopReason, "stop");
	assert.equal(payload.model, "deepseek-v4-pro");
	assert.equal(payload.thinking.type, level ? "enabled" : "disabled");
	if (level) assert.equal(payload.reasoning_effort, level);
}
await runtime.completeSimple(model, {
	messages: [
		{ role: "user", content: "Use the tool", timestamp: 0 },
		{ role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 1,
			content: [{ type: "thinking", thinking: "Previous reasoning", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "call_fixture", name: "check", arguments: {} }],
			stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } },
		{ role: "toolResult", toolCallId: "call_fixture", toolName: "check", content: [{ type: "text", text: "Done" }], isError: false, timestamp: 2 },
	], tools: [{ name: "check", description: "Check", parameters: { type: "object", properties: {} } }],
}, { apiKey: "fixture-key", fetch: fakeFetch, reasoning: "high", maxTokens: 16 });
assert.equal(payload.messages.find((message) => message.role === "assistant").reasoning_content, "Previous reasoning");
assert.equal(payload.messages.find((message) => message.role === "tool").tool_call_id, "call_fixture");

const root = await mkdtemp(join(tmpdir(), "heipang-deepseek-test-"));
const shim = join(root, "electron.mjs");
await writeFile(shim, "export const nativeImage = {};\n");
const { Driver } = await createJiti(import.meta.url, { alias: { electron: shim } }).import(resolve("src/main/driver.ts"));
const driver = Object.create(Driver.prototype);
let persisted = false;
let secretKind;
driver.oauthBridge = { requestInput: async (kind) => { secretKind = kind; return "fixture-key"; }, dismissInputs: () => {}, openExternal: () => {} };
driver.runtime = async () => ({
	login: async (_id, type, interaction) => {
		assert.equal(type, "api_key");
		await interaction.prompt({ type: "secret", message: "Enter key" });
		persisted = true;
	},
});
const originalFetch = globalThis.fetch;
try {
	globalThis.fetch = async () => new Response('{"data":[{"id":"deepseek-v4-pro"}]}', { headers: { "content-type": "application/json" } });
	assert.equal((await driver.loginAccount("deepseek")).ok, true);
	assert.equal(secretKind, "secret");
	assert.equal(persisted, true);
	persisted = false;
	globalThis.fetch = async () => new Response("Denied", { status: 401 });
	const rejected = await driver.loginAccount("deepseek");
	assert.equal(rejected.ok, false);
	assert.equal(persisted, false);
	assert.equal(rejected.error.includes("fixture-key"), false);
	assert.match(rejected.error, /401/);
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
console.log("PASS: DeepSeek modes, tool reasoning round-trip, secure API-key validation, no key leakage");
