import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// All credentials and requests are isolated in a temporary directory and MockAgent.
for (const name of ["ANTIGRAVITY_RELAY_URL", "ANTIGRAVITY_RELAY_KEY", "NOAGY_RELAY_URL", "NOAGY_RELAY_KEY"]) delete process.env[name];
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
const { Driver } = await createJiti(import.meta.url, { alias: { electron: shim } }).import(resolve("src/main/driver.ts"));
const driver = Object.create(Driver.prototype);

const settingsJiti = createJiti(import.meta.url, { alias: { electron: shim } });
const { AntigravitySettingsStore } = await settingsJiti.import(resolve("src/main/antigravity-settings.ts"));
const { configureRelay } = await settingsJiti.import(resolve("src/main/antigravity/client/relay.ts"));
const { resolveRelayApiKey } = await settingsJiti.import(resolve("src/main/antigravity/auth/relay.ts"));
const { antigravityTransport } = await settingsJiti.import(resolve("src/main/antigravity/client/transport.ts"));
const { antigravityProvider } = await settingsJiti.import(resolve("src/main/antigravity/provider.ts"));
const { streamAntigravity } = await settingsJiti.import(resolve("src/main/antigravity/stream/index.ts"));
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
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
projectReply();
await store.save({ relayUrl: "https://relay.example.test", relayKey: "" });
projectReply();
const credential = JSON.parse(await resolveRelayApiKey());
assert.equal(credential.token, "secret-key");
assert.equal(credential.projectId, "test-project");
assert.throws(() => antigravityTransport.fetch("https://google.example.test/", {}), /only the relay/);
configureRelay({ url: "https://second-relay.example.test", key: "secret-key" });
mock.get("https://second-relay.example.test").intercept({ path: "/v1internal:loadCodeAssist", method: "POST" }).reply(200, { cloudaicompanionProject: "second-project" });
assert.equal(JSON.parse(await resolveRelayApiKey()).projectId, "second-project");
configureRelay({ url: "https://relay.example.test", key: "secret-key" });
await writeFile(join(root, "auth.json"), JSON.stringify({ antigravity: { type: "oauth", access: "old-token", refresh: "old-refresh", expires: 0 } }));
const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), allowModelNetwork: false });
runtime.registerNativeProvider(antigravityProvider(streamAntigravity));
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
relay.intercept({ path: "/v1internal:fetchAvailableModels", method: "POST" }).reply(200, { models: {
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
const { preferBuiltinAntigravity } = await settingsJiti.import(resolve("src/main/builtin-antigravity.ts"));
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
driver.providerApiKey = async () => undefined;
const remoteRes = await driver.fetchRemoteAntigravityModels();
assert.equal(remoteRes.ok, true);
assert.ok(remoteRes.models.length > 0);
assert.ok(remoteRes.models.some((m) => m.provider === "antigravity" && m.id === "gemini-4-argon"));

// Verify Gemini 4 Argon / Carbon / Hydrogen grouping, xhigh routing, and thinking config
const jiti = createJiti(import.meta.url, { alias: { electron: shim } });
const {
	ANTIGRAVITY_MODELS,
	ANTIGRAVITY_ROUTING,
	applyAntigravityCatalog,
	buildAntigravityCatalog,
	getMaxOutputTokens,
	resetAntigravityCatalogForTests,
} = await jiti.import(resolve("src/main/antigravity/models/index.ts"));

const info = (displayName, extra = {}) => ({
	displayName,
	supportsThinking: true,
	supportsImages: true,
	...extra,
});
const rawModels = {
	"gemini-4-argon-low": info("Gemini 4 Argon (Low)"),
	"gemini-4-argon-medium": info("Gemini 4 Argon (Medium)"),
	"gemini-4-argon-high": info("Gemini 4 Argon (High)"),
	"gemini-4-carbon-low": info("Gemini 4 Carbon (Low)", { maxTokens: 1048576, maxOutputTokens: 262144 }),
	"gemini-4-carbon-medium": info("Gemini 4 Carbon (Medium)", { maxTokens: 1048576, maxOutputTokens: 262144 }),
	"gemini-4-carbon-high": info("Gemini 4 Carbon (High)", { maxTokens: 1048576, maxOutputTokens: 262144 }),
	"gemini-4-hydrogen-low": info("Gemini 4 Hydrogen (Low)", { maxTokens: 1048576, maxOutputTokens: 262144 }),
	"gemini-4-hydrogen-medium": info("Gemini 4 Hydrogen (Medium)", { maxTokens: 1048576, maxOutputTokens: 262144 }),
	"gemini-4-hydrogen-high": info("Gemini 4 Hydrogen (High)", { maxTokens: 1048576, maxOutputTokens: 262144 }),
	"gemini-4-hydrogen-xhigh": info("Gemini 4 Hydrogen (XHigh)", { maxTokens: 1048576, maxOutputTokens: 262144 }),
};
const sortsPayload = [{ groups: [{ modelIds: ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"] }] }];
const catalog = buildAntigravityCatalog(
	rawModels,
	{ models: ANTIGRAVITY_MODELS, routing: ANTIGRAVITY_ROUTING },
	sortsPayload,
);
assert.deepEqual(
	catalog.models.map((m) => m.id).sort(),
	["gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen"].sort(),
);
assert.equal(catalog.routing["gemini-4-hydrogen"].routing?.xhigh, "gemini-4-hydrogen-xhigh");
assert.equal(catalog.models.find((m) => m.id === "gemini-4-hydrogen")?.thinkingLevelMap?.xhigh, "xhigh");
assert.equal(catalog.models.find((m) => m.id === "gemini-4-carbon")?.maxTokens, 262144);
assert.equal(catalog.models.find((m) => m.id === "gemini-4-hydrogen")?.maxTokens, 262144);
applyAntigravityCatalog(catalog);
assert.equal(getMaxOutputTokens("gemini-4-hydrogen", "gemini-4-hydrogen-xhigh"), 262144);
const { thinkingWire } = await jiti.import(resolve("src/main/antigravity/wire/family.ts"));
assert.deepEqual(thinkingWire("gemini-4-hydrogen-xhigh", "xhigh"), { includeThoughts: true, thinkingLevel: 100 });
assert.deepEqual(thinkingWire("gemini-4-argon-low", "off"), { includeThoughts: false });
resetAntigravityCatalogForTests();

const { renameHarness } = await jiti.import(resolve("src/main/antigravity/wire/system-prompt.ts"));
const { buildRequest } = await jiti.import(resolve("src/main/antigravity/stream/stream.ts"));
const docsBlurb = "codemode scripts and non-LLM models such as classifiers and image models";
const docsLine = `- When asked about: MCP servers (docs/mcp.md), ${docsBlurb} (docs/codemode.md)`;
const shortenedDocsLine = "- When asked about: MCP servers (docs/mcp.md), codemode scripts (docs/codemode.md)";
assert.equal(renameHarness(docsLine), shortenedDocsLine);
assert.equal(renameHarness(`${docsBlurb}\n${docsBlurb}`), "codemode scripts\ncodemode scripts");
assert.equal(renameHarness("You are running inside pi. Ask Pi."), "You are running inside antigravity. Ask antigravity.");
for (const text of ["a piece of pie", "pi-coding-agent and @earendil-works/pi-coding-agent", "PI_VERSION and PI_CODING_AGENT_DIR", "/Users/me/.pi/agent/settings.json"]) {
	assert.equal(renameHarness(text), text);
}
const normalized = renameHarness(`You are running inside pi.\n${docsLine}`);
assert.equal(renameHarness(normalized), normalized);
const promptModel = {
	...ANTIGRAVITY_MODELS.find((model) => model.id === "gemini-3.8-flash"),
	provider: "antigravity",
	api: "antigravity-api",
	baseUrl: "https://relay.example.test",
};
const userText = `Explain pi and the phrase: ${docsBlurb}`;
const promptContext = {
	systemPrompt: `You are running inside pi.\n${docsLine}`,
	messages: [{ role: "user", content: userText, timestamp: 1 }],
};
const promptSnapshot = JSON.stringify(promptContext);
const request = buildRequest(promptModel, promptContext, "project-1", {}, "gemini-3.8-flash-low");
assert.equal(request.request.systemInstruction.parts[0].text, `You are running inside antigravity.\n${shortenedDocsLine}`);
assert.deepEqual(request.request.contents[0].parts, [{ text: userText }]);
assert.equal(JSON.stringify(promptContext), promptSnapshot);
const skillContext = {
	...promptContext,
	messages: [{ role: "user", content: `<skill name="docs">Inside pi. ${docsBlurb}</skill>\n${userText}`, timestamp: 1 }],
};
const skillRequest = buildRequest(promptModel, skillContext, "project-1", {}, "gemini-3.8-flash-low");
assert.equal(skillRequest.request.systemInstruction.parts[1].text, '<skill name="docs">Inside antigravity. codemode scripts</skill>');
assert.equal(skillRequest.request.contents[0].parts[0].text.trim(), userText);

await rm(root, { recursive: true, force: true });
console.log("PASS: Antigravity relay validation, encrypted persistence, project isolation, legacy credential override, model availability, Gemini 4 routing and system prompt normalization");
