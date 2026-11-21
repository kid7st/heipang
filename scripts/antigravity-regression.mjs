import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// All credentials and requests are isolated in a temporary directory and MockAgent.
for (const prefix of ["ANTIGRAVITY", "NOAGY"]) {
 for (const name of ["RELAY_URL", "RELAY_KEY", "USER_AGENT"]) delete process.env[`${prefix}_${name}`];
}
const root = await mkdtemp(join(tmpdir(), "heipang-antigravity-test-"));
const shim = join(root, "electron.mjs");
await writeFile(shim, `
export const nativeImage = {};
export const clipboard = { writeText: () => {} };
export const safeStorage = {
 isEncryptionAvailable: () => true,
 encryptString: (value) => Buffer.from(value.split('').reverse().join('')),
 decryptString: (value) => value.toString().split('').reverse().join(''),
};
`);
const jiti = createJiti(import.meta.url, { alias: { electron: shim }, transformModules: ["pi-antigravity"] });
const { Driver } = await jiti.import(resolve("src/main/driver.ts"));
const driver = Object.create(Driver.prototype);
driver.bgSessions = new Map();
driver.shutdownController = new AbortController();
driver.sessionShutdownErrors = new WeakMap();

const { AntigravitySettingsStore } = await jiti.import(resolve("src/main/antigravity-settings.ts"));
const { readAntigravitySystemPrompt } = await jiti.import(resolve("src/main/session-resources.ts"));
const { antigravityProvider, configureRelay } = await jiti.import("pi-antigravity/app");
const provider = antigravityProvider();
const resolveRelayApiKey = async () => (await provider.auth.apiKey.resolve({})).auth.apiKey;
const { ModelRuntime, createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
const originalDispatcher = getGlobalDispatcher();
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
const relay = mock.get("https://relay.example.test");
const projectReply = (project = "test-project") => relay.intercept({ path: "/v1internal:loadCodeAssist", method: "POST" }).reply(200, { cloudaicompanionProject: project });
const store = new AntigravitySettingsStore(root);
assert.deepEqual(store.get(), { relayUrl: "", hasKey: false });
await assert.rejects(store.save({ relayUrl: "http://public.example.test", relayKey: "secret-key" }), /https/);
await assert.rejects(store.save({ relayUrl: "https://relay.example.test/path", relayKey: "secret-key" }), /origin only/);
await assert.rejects(store.save({ relayUrl: "https://relay.example.test", relayKey: "" }), /Enter/);
relay.intercept({ path: "/v1internal:loadCodeAssist", method: "POST" }).reply(401, { error: "secret-key must never appear in errors" });
await assert.rejects(store.save({ relayUrl: "https://relay.example.test", relayKey: "secret-key" }), (error) => /HTTP 401/.test(error.message) && !error.message.includes("secret-key"));
assert.equal(store.get().hasKey, false);
projectReply();
await store.save({ relayUrl: "https://relay.example.test/", relayKey: "secret-key" });
assert.deepEqual(store.get(), { relayUrl: "https://relay.example.test", hasKey: true });
const persisted = await readFile(join(root, "heipang-antigravity.json"), "utf8");
assert.ok(!persisted.includes("secret-key"));
assert.equal((await stat(join(root, "heipang-antigravity.json"))).mode & 0o777, 0o600);
assert.deepEqual(new AntigravitySettingsStore(root).get(), store.get());
for (const damaged of ['{"truncated":', JSON.stringify({ url: "https://relay.example.test", encryptedKey: "" })]) {
 await writeFile(join(root, "heipang-antigravity.json"), damaged);
 const recovered = new AntigravitySettingsStore(root).get();
 assert.equal(recovered.hasKey, false);
 assert.match(recovered.error, /original file has been kept/);
 assert.equal(await readFile(join(root, "heipang-antigravity.json"), "utf8"), damaged);
}
await writeFile(join(root, "heipang-antigravity.json"), persisted);
new AntigravitySettingsStore(root);
projectReply();
await store.save({ relayUrl: "https://relay.example.test", relayKey: "" });
projectReply();
const credential = JSON.parse(await resolveRelayApiKey());
assert.equal(credential.token, "secret-key");
assert.equal(credential.projectId, "test-project");
configureRelay({ url: "https://second-relay.example.test", key: "secret-key" });
mock.get("https://second-relay.example.test").intercept({ path: "/v1internal:loadCodeAssist", method: "POST" }).reply(200, { cloudaicompanionProject: "second-project" });
assert.equal(JSON.parse(await resolveRelayApiKey()).projectId, "second-project");
configureRelay({ url: "https://relay.example.test", key: "secret-key" });
await writeFile(join(root, "auth.json"), JSON.stringify({ antigravity: { type: "oauth", access: "old-token", refresh: "old-refresh", expires: 0 } }));
const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), allowModelNetwork: false });
runtime.registerNativeProvider(provider);
await runtime.setRuntimeApiKey("antigravity", "heipang-relay");
assert.ok((await runtime.getAvailable("antigravity")).length > 0);
projectReply();
assert.equal(JSON.parse((await runtime.getAuth("antigravity")).auth.apiKey).token, "secret-key");
assert.ok((await readFile(join(root, "auth.json"), "utf8")).includes("old-refresh"));
driver.antigravitySettings = store;
driver.runtime = async () => runtime;
let enabled = ["anthropic/example"];
driver.settings = { getEnabledModels: () => enabled, setEnabledModels: (value) => { enabled = value; }, flush: async () => {} };
projectReply();
relay.intercept({
 path: "/v1internal:fetchAvailableModels",
 method: "POST",
 headers: { "user-agent": /^antigravity\/cli\/1\.5\.13 \([^)]*; cl=1025641825; auth_method=consumer\)$/ },
}).reply(200, { models: {
 "gemini-4-argon-low": { displayName: "Gemini 4 Argon Low", supportsThinking: true, supportsImages: true },
 "gemini-4-argon-high": { displayName: "Gemini 4 Argon High", supportsThinking: true, supportsImages: true },
} });
const saved = await driver.saveAntigravitySettings({ relayUrl: "https://relay.example.test", relayKey: "" });
assert.equal(saved.ok, true, saved.error);
assert.equal(saved.warning, undefined);
assert.ok(enabled.includes("antigravity/gemini-4-argon"));
assert.ok((await runtime.getAvailable("antigravity")).some((model) => model.id === "gemini-4-argon"));
const streamPath = "/v1internal:streamGenerateContent?alt=sse";
relay.intercept({ path: streamPath, method: "POST", body: (body) => JSON.parse(body).requestType === "checkpoint" }).reply(200, "");
relay.intercept({ path: "/v1internal:writeTrajectoryAcls", method: "POST" }).reply(200, {});
relay.intercept({ path: streamPath, method: "POST", headers: { authorization: "Bearer secret-key" }, body: (body) => JSON.parse(body).requestType !== "checkpoint" }).reply(200, (request) => {
 assert.equal(JSON.parse(request.body).project, "test-project");
 return `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "Relay response" }] }, finishReason: "STOP" }] } })}\n\n`;
}, { headers: { "content-type": "text/event-stream" } });
const answer = await runtime.completeSimple(runtime.getModel("antigravity", "gemini-4-argon"), {
 messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
}, { sessionId: "relay-regression" });
assert.equal(answer.stopReason, "stop", answer.errorMessage);
assert.ok(answer.content.some((block) => block.type === "text" && block.text === "Relay response"));
relay.intercept({ path: "/v1internal:loadCodeAssist", method: "POST" }).reply(403, {});
await assert.rejects(store.save({ relayUrl: "https://relay.example.test", relayKey: "rejected-key" }), /HTTP 403/);
assert.equal(await readFile(join(root, "heipang-antigravity.json"), "utf8"), persisted);
await driver.logoutAccount("antigravity");
assert.equal(store.get().hasKey, false);
process.env.ANTIGRAVITY_RELAY_URL = "https://environment-relay.example.test";
process.env.ANTIGRAVITY_RELAY_KEY = "environment-key";
assert.equal(new AntigravitySettingsStore(root).get().hasKey, false);
delete process.env.ANTIGRAVITY_RELAY_URL;
delete process.env.ANTIGRAVITY_RELAY_KEY;
assert.equal((await runtime.getAvailable("antigravity")).length, 0);
mock.assertNoPendingInterceptors();
setGlobalDispatcher(originalDispatcher);
await mock.close();
assert.equal((await driver.loginAccount("antigravity")).ok, false);

const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { preferBuiltinAntigravity } = await jiti.import(resolve("src/main/builtin-antigravity.ts"));
const external = join(root, "external-plugin");
await mkdir(external);
await writeFile(join(external, "package.json"), JSON.stringify({ name: "pi-antigravity", pi: { extensions: ["./index.ts"] } }));
await writeFile(join(external, "index.ts"), `export default function(pi) {
 pi.registerCommand("antigravity.usage", { description: "External", handler: async () => {} });
 pi.registerProvider("antigravity", { name: "External", baseUrl: "https://external.example.test", apiKey: "unused" });
}`);
const loader = new DefaultResourceLoader({
 cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
 noExtensions: true, noSkills: true, noContextFiles: true,
 additionalExtensionPaths: [external],
 extensionFactories: [(pi) => pi.registerCommand("antigravity.usage", { description: "Builtin", handler: async () => {} })],
 extensionsOverride: preferBuiltinAntigravity,
});
await loader.reload();
const extensions = loader.getExtensions();
assert.deepEqual(extensions.errors, []);
assert.equal(extensions.extensions.length, 1);
assert.equal(extensions.extensions[0].commands.get("antigravity.usage").description, "Builtin");
assert.equal(extensions.runtime.pendingProviderRegistrations.length, 0);

// Verify remote Antigravity models discovery / fallback
driver.settings = { getEnabledModels: () => [] };
const { ModelCatalog } = await jiti.import(resolve("src/main/model-catalog.ts"));
driver.catalog = new ModelCatalog(root, driver.runtime, driver.settings);
driver.catalog.providerApiKey = async () => undefined;
const remoteRes = await driver.fetchRemoteAntigravityModels();
assert.equal(remoteRes.ok, true);
assert.ok(remoteRes.models.length > 0);
assert.ok(remoteRes.models.some((m) => m.provider === "antigravity" && m.id === "gemini-4-argon"));

const docsBlurb = "codemode scripts and non-LLM models such as classifiers and image models";
const docsLine = `- When asked about: MCP servers (docs/mcp.md), ${docsBlurb} (docs/codemode.md)`;
const normalized = "You are running inside antigravity.\n- When asked about: MCP servers (docs/mcp.md), codemode scripts (docs/codemode.md)";
const userText = `Explain pi and the phrase: ${docsBlurb}`;
const promptContext = {
	systemPrompt: `You are running inside pi.\n${docsLine}`,
	messages: [{ role: "user", content: userText, timestamp: 1 }],
};
const skillText = `<skill name="docs">Inside pi. ${docsBlurb}</skill>\n${userText}`;

const image = { type: "image", data: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" };
const toolCall = {
	role: "assistant", api: "antigravity-api", provider: "antigravity", timestamp: 1,
	stopReason: "toolUse", content: [{ type: "toolCall", id: "call-shot", name: "screenshot", arguments: {}, thoughtSignature: "YWJjZA==" }],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const toolResult = {
	role: "toolResult", toolCallId: "call-shot", toolName: "screenshot", timestamp: 1, isError: false,
	content: [{ type: "text", text: "captured" }, image],
};
const sessionMock = new MockAgent();
sessionMock.disableNetConnect();
setGlobalDispatcher(sessionMock);
configureRelay({ url: "https://relay.example.test", key: "secret-key" });
await runtime.setRuntimeApiKey("antigravity", "heipang-relay");
const sessionRelay = sessionMock.get("https://relay.example.test");
sessionRelay.intercept({ path: "/v1internal:writeTrajectoryAcls", method: "POST" }).reply(200, {}).persist();
sessionRelay.intercept({ path: streamPath, method: "POST", body: (body) => JSON.parse(body).requestType === "checkpoint" }).reply(200, "").persist();
const sessionRequests = [];
sessionRelay.intercept({ path: streamPath, method: "POST", body: (body) => JSON.parse(body).requestType !== "checkpoint" }).reply(200, (request) => {
	sessionRequests.push(JSON.parse(request.body).request);
	return `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "Session response" }] }, finishReason: "STOP" }] } })}\n\n`;
}, { headers: { "content-type": "text/event-stream" } }).persist();
const sessionSettings = SettingsManager.inMemory({ retry: { enabled: false }, cacheWarming: "off" });
const sessionLoader = new DefaultResourceLoader({
	cwd: root, agentDir: root, settingsManager: sessionSettings,
	noExtensions: true, noSkills: true, noContextFiles: true,
});
await sessionLoader.reload();
const { session } = await createAgentSession({
	cwd: root, agentDir: root, modelRuntime: runtime,
	model: runtime.getModel("antigravity", "gemini-3.8-flash"),
	thinkingLevel: "off", tools: ["read", "bash"], settingsManager: sessionSettings,
	resourceLoader: sessionLoader, sessionManager: SessionManager.inMemory(root),
});
session.setActiveToolsByName(["read"]);
driver.agentDir = root;
driver.sessionControllers = new Map([[session, new AbortController()]]);
driver.sessionOperations = new WeakMap();
driver.installSessionGuards(session);
try {
	assert.match(session.systemPrompt, /inside pi,/);
	assert.ok(session.systemPrompt.includes(docsBlurb));
	await session.prompt(userText);
	assert.equal(session.getLastAssistantText(), "Session response");
	assert.equal(sessionRequests.length, 1);
	const firstPrompt = sessionRequests[0].systemInstruction.parts.map((part) => part.text).join("\n");
	assert.match(firstPrompt, /inside antigravity,/);
	assert.ok(!firstPrompt.includes(docsBlurb));
	assert.ok(firstPrompt.includes("codemode scripts (docs/codemode.md)"));
	assert.ok(sessionRequests[0].contents.some((message) => message.parts.some((part) => part.text === userText)));
	assert.deepEqual(sessionRequests[0].tools.flatMap((group) => group.functionDeclarations.map((tool) => tool.name)), ["read"]);
	session.setActiveToolsByName(["read", "bash"]);
	await session.prompt("Continue without using tools.");
	assert.equal(session.getLastAssistantText(), "Session response");
	assert.equal(sessionRequests.length, 2);
	assert.deepEqual(sessionRequests[1].tools.flatMap((group) => group.functionDeclarations.map((tool) => tool.name)), ["read", "bash"]);
	assert.match(sessionRequests[1].systemInstruction.parts[0].text, /inside antigravity,/);
	assert.ok(!sessionRequests[1].systemInstruction.parts[0].text.includes(docsBlurb));
	const imageContext = { messages: [{ role: "user", content: "Take a screenshot", timestamp: 1 }, { ...toolCall, model: session.model.id }, toolResult] };
	const imageAnswer = await runtime.completeSimple(session.model, imageContext, { sessionId: "tool-image-regression" });
	assert.equal(imageAnswer.stopReason, "stop", imageAnswer.errorMessage);
	const imageContents = sessionRequests.at(-1).contents;
	assert.deepEqual(imageContents.map(turn => turn.role), ["user", "model", "model", "user"]);
	assert.deepEqual(imageContents[2].parts, [{ functionResponse: { id: "call-shot", name: "screenshot", response: { output: "captured" } } }]);
	assert.deepEqual(imageContents[3].parts, [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }]);
	driver.sessionTasks = new WeakMap();
	driver.releasingSessions = new WeakMap();
	await writeFile(join(root, "settings.json"), JSON.stringify({ cacheWarming: "off", retry: { enabled: false } }));
	const overridePath = join(root, "heipang-antigravity-system-prompt.txt");
	assert.equal(await readAntigravitySystemPrompt(overridePath), undefined);
	await writeFile(overridePath, " \n");
	await assert.rejects(readAntigravitySystemPrompt(overridePath), /system prompt override is empty/);
	const override = `  A fixed system prompt about pi.\n${docsLine}\n`;
	await writeFile(overridePath, override);
	const liveA = (await driver.createSession(root, new AbortController(), SessionManager.inMemory(root))).session;
	const liveB = (await driver.createSession(root, new AbortController(), SessionManager.inMemory(root))).session;
	try {
		assert.notEqual(liveA.modelRuntime, liveB.modelRuntime);
		for (const current of [liveA, liveB]) {
			const selected = current.modelRuntime.getModels("antigravity")[0];
			assert.ok(selected, "The built-in extension must register Antigravity models");
			await current.setModel(selected);
			current.setThinkingLevel("off");
		}
		const beforeOverride = sessionRequests.length;
		await Promise.all([liveA.prompt(skillText), liveB.prompt("Session B")]);
		assert.equal(liveA.getLastAssistantText(), "Session response");
		assert.equal(liveB.getLastAssistantText(), "Session response");
		const overridden = sessionRequests.slice(beforeOverride);
		assert.equal(overridden.length, 2);
		for (const request of overridden) {
			assert.deepEqual(request.systemInstruction, { role: "user", parts: [{ text: override }] });
		}
		assert.ok(overridden.some((request) => request.contents[0].parts.some((part) => part.text === skillText)));
		await liveA.modelRuntime.completeSimple(liveA.model, promptContext, { sessionId: "auxiliary" });
		assert.equal(sessionRequests.at(-1).systemInstruction.parts[0].text, normalized);
		await rm(overridePath);
		await liveB.prompt("Return to the default prompt.");
		assert.match(sessionRequests.at(-1).systemInstruction.parts[0].text, /inside antigravity,/);
		for (const current of [liveA, liveB]) {
			assert.equal(current.sessionManager.getBranch().filter((entry) => entry.customType === "antigravity.request-state").length, current === liveA ? 1 : 2);
		}
	} finally {
		await Promise.all([driver.releaseSession(liveA), driver.releaseSession(liveB)]);
	}
	sessionMock.assertNoPendingInterceptors();
} finally {
	session.dispose();
	setGlobalDispatcher(originalDispatcher);
	await sessionMock.close();
	await rm(root, { recursive: true, force: true });
}
console.log("PASS: Antigravity relay validation, encrypted persistence, project isolation, legacy credential override, model availability, Gemini 4 routing, SDK session/tool updates, Gemini tool-result image turns and system prompt normalization");
