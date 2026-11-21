import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "heipang-gemini-test-"));
const key = "fixture-gemini-key";
const originalFetch = globalThis.fetch;
delete process.env.GEMINI_API_KEY;
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };

try {
	const shim = join(root, "electron.mjs");
	await writeFile(shim, "export const nativeImage = {};\n");
	const jiti = createJiti(import.meta.url, { alias: { electron: shim } });
	const { Driver } = await jiti.import(resolve("src/main/driver.ts"));
	const { installProviderFetch } = await jiti.import(resolve("src/main/provider-compat.ts"));
	let geminiFetch = async () => assert.fail("Unexpected Gemini request");
	installProviderFetch((input, options) => geminiFetch(input, options));
	await assert.rejects(fetch("https://generativelanguage.googleapis.com.example.com/v1beta/models"), /Unexpected network request/);
	const createRuntime = () => ModelRuntime.create({
		authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false,
	});
	const runtime = await createRuntime();
	const driver = Object.assign(Object.create(Driver.prototype), {
		runtime: async () => runtime,
		warmExtensionProviders: async () => {},
		shutdownController: new AbortController(),
		oauthBridge: {
			openExternal: () => assert.fail("Gemini API sign-in must not open an OAuth page"),
			requestInput: async (kind, payload) => {
				assert.equal(kind, "secret");
				assert.match(payload.message, /Gemini API key/);
				return ` ${key} `;
			},
		},
	});
	const googleAccount = async () => (await driver.getAccounts()).find((account) => account.id === "google");
	assert.deepEqual(await googleAccount(), { id: "google", name: "Gemini API", connected: false, authType: "api_key" });
	assert.equal((await runtime.getAvailable("google")).length, 0);

	geminiFetch = async () => new Response(`Rejected ${key}`, { status: 403 });
	assert.deepEqual(await driver.loginAccount("google"), { ok: false, error: "Gemini API key verification failed (HTTP 403)" });
	geminiFetch = async () => { throw new Error(`Transport failure: ${key}`); };
	assert.deepEqual(await driver.loginAccount("google"), {
		ok: false, error: "Could not reach Google Gemini. Check your network or system proxy and try again.",
	});
	assert.equal(await runtime.getAuth("google"), undefined);
	assert.equal((await googleAccount()).connected, false);

	geminiFetch = async (url, options) => {
		assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
		assert.equal(options.headers["x-goog-api-key"], key);
		assert.equal(options.redirect, "error");
		assert.ok(options.signal);
		return Response.json({ models: [{ name: "models/gemini-flash-latest" }] });
	};
	assert.deepEqual(await driver.loginAccount("google"), { ok: true });
	assert.equal((await googleAccount()).connected, true);
	assert.ok((await runtime.getAvailable("google")).length > 0);
	assert.equal((await (await createRuntime()).getAuth("google"))?.auth.apiKey, key);

	geminiFetch = async (input, options) => {
		const url = new URL(input);
		assert.equal(url.pathname, "/v1beta/models/gemini-flash-latest:streamGenerateContent");
		assert.equal(options.method, "POST");
		assert.equal(new Headers(options.headers).get("x-goog-api-key"), key);
		const chunk = { candidates: [{ content: { role: "model", parts: [{ text: "Gemini fixture" }] }, finishReason: "STOP" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } });
	};
	const model = runtime.getModel("google", "gemini-flash-latest");
	const reply = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Test", timestamp: 0 }] });
	assert.equal(reply.stopReason, "stop", reply.errorMessage);
	assert.ok(reply.content.some((block) => block.type === "text" && block.text === "Gemini fixture"));

	await driver.logoutAccount("google");
	assert.equal((await googleAccount()).connected, false);
	assert.equal(await (await createRuntime()).getAuth("google"), undefined);
} finally {
	globalThis.fetch = originalFetch;
	await rm(root, { recursive: true, force: true });
}

console.log("PASS: Gemini transport routing for sign-in and streaming, API key validation and redaction, credential persistence and sign-out");
