import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// No browser is opened, no network call is made, and no credential is written.
// The test only verifies HEIPANG's Antigravity OAuth wiring.
const root = await mkdtemp(join(tmpdir(), "heipang-antigravity-test-"));
const shim = join(root, "electron.mjs");
await writeFile(shim, "export const nativeImage = {};\nexport const clipboard = { writeText: () => {} };\n");
const { Driver } = await createJiti(import.meta.url, { alias: { electron: shim } }).import(resolve("src/main/driver.ts"));
const driver = Object.create(Driver.prototype);

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";
let openedUrl = "";
let promptPayload;
let dismissed = false;
driver.oauthBridge = {
	openExternal: (url) => { openedUrl = url; },
	requestInput: async (_kind, payload) => { promptPayload = payload; return payload.placeholder; },
	dismissInputs: () => { dismissed = true; },
};
driver.runtime = async () => ({
	login: async (providerId, type, interaction) => {
		assert.equal(providerId, "antigravity");
		assert.equal(type, "oauth");
		interaction.notify({ type: "auth_url", url: authUrl });
		const pasted = await interaction.prompt({
			type: "text",
			message: "After signing in, paste the full callback URL.",
			placeholder: "http://localhost:51121/oauth-callback?state=abc&code=def",
		});
		assert.equal(pasted, "http://localhost:51121/oauth-callback?state=abc&code=def");
		return { type: "oauth" };
	},
});

const result = await driver.loginAccount("antigravity");
assert.equal(result.ok, true);
assert.equal(openedUrl, authUrl);
// The login URL is shown in the dialog message (and copied to the clipboard), but
// the input itself stays empty for the callback URL — never pre-filled, never submitted.
assert.match(promptPayload.message, /accounts\.google\.com/);
assert.equal(promptPayload.defaultValue, undefined);
assert.equal(dismissed, false);

// Verify remote Antigravity models discovery / fallback
driver.settings = { getEnabledModels: () => [] };
driver.providerApiKey = async () => undefined;
const remoteRes = await driver.fetchRemoteAntigravityModels();
assert.equal(remoteRes.ok, true);
assert.ok(remoteRes.models.length > 0);
assert.ok(remoteRes.models.some((m) => m.provider === "antigravity" && m.id.includes("flash")));

// Verify Gemini 4 Argon / Carbon / Hydrogen grouping, xhigh routing, and thinking config
const jiti = createJiti(import.meta.url, { alias: { electron: shim } });
const {
	ANTIGRAVITY_MODELS,
	ANTIGRAVITY_ROUTING,
	applyAntigravityCatalog,
	buildAntigravityCatalog,
	getMaxOutputTokens,
	getThinkingConfig,
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
assert.deepEqual(getThinkingConfig("gemini-4-hydrogen-xhigh", "xhigh"), { includeThoughts: true, thinkingBudget: -1 });
assert.equal(getThinkingConfig("gemini-4-argon-low", "off"), undefined);
resetAntigravityCatalogForTests();

await rm(root, { recursive: true, force: true });
console.log("PASS: Antigravity OAuth shows the login URL in the dialog, keeps the paste box empty, never auto-submits or auto-closes; dynamic model list and Gemini 4 routing available");
