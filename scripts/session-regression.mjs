import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, readdir, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ModelRuntime, ProjectTrustStore, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createProvider, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "heipang-session-test-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network request in isolated regression"); };
try {
	const shim = join(root, "electron.mjs");
	await writeFile(shim, `
import { EventEmitter } from "node:events";
export const nativeImage = {};
export const clipboard = { writeText() {} };
export const safeStorage = {};
export const shell = {};
export const dialog = {};
export class Notification {}
export const ipcMain = new EventEmitter();
ipcMain.handle = () => {};
export const app = { getAppPath: () => ${JSON.stringify(root)}, getVersion: () => "0.4.11" };
export const transport = { respond: undefined, aborted: false, urls: [] };
export const net = { request(options) {
 transport.urls.push(options.url);
 const request = new EventEmitter();
 request.setHeader = () => {};
 request.abort = () => { transport.aborted = true; };
 request.end = () => queueMicrotask(() => transport.respond(request));
 return request;
} };
`);
	const jiti = createJiti(import.meta.url, { alias: { electron: shim } });
	const { Driver } = await jiti.import(resolve("src/main/driver.ts"));
	const { InputRequests } = await jiti.import(resolve("src/main/input-requests.ts"));
	const { ModelCatalog } = await jiti.import(resolve("src/main/model-catalog.ts"));
	const { SessionTasks } = await jiti.import(resolve("src/main/session-tasks.ts"));
	const { createSessionResources, loadSessionResources } = await jiti.import(resolve("src/main/session-resources.ts"));
	const { MAC_INSTALL_SCRIPT } = await jiti.import(resolve("src/main/mac-update.ts"));
	const { transport } = await jiti.import(shim);
	const { download, checkForUpdate } = await jiti.import(resolve("src/main/updater.ts"));
	const { EventEmitter } = await import("node:events");
	const response = (body, statusCode = 200, total = Buffer.byteLength(body), interrupted = false) => {
		transport.aborted = false;
		transport.respond = (request) => {
			const incoming = new EventEmitter();
			incoming.statusCode = statusCode;
			incoming.headers = { "content-length": String(total) };
			request.emit("response", incoming);
			if (statusCode >= 400) return;
			incoming.emit("data", Buffer.from(body));
			incoming.emit(interrupted ? "aborted" : "end");
		};
	};
	response("installer");
	await download("https://example.test/installer", join(root, "installer"), () => {});
	assert.equal(await readFile(join(root, "installer"), "utf8"), "installer");
	response("installer");
	await assert.rejects(download("https://example.test/installer", join(root, "missing", "installer"), () => {}), { code: "ENOENT" });
	assert.equal(transport.aborted, true);
	response("short", 200, 10);
	await assert.rejects(download("https://example.test/installer", join(root, "short"), () => {}), /incomplete/);
	response("partial", 200, 10, true);
	await assert.rejects(download("https://example.test/installer", join(root, "interrupted"), () => {}), /interrupted/);
	response("Denied", 403);
	await assert.rejects(download("https://example.test/installer", join(root, "denied"), () => {}), /HTTP 403/);
	const release = (tag, overrides = {}) => ({
		tag_name: tag, body: `notes ${tag}`, draft: false, prerelease: false,
		assets: [{ name: "HEIPANG-arm64.dmg", browser_download_url: `https://example.test/${tag}/mac` }, { name: "HEIPANG-Setup.exe", browser_download_url: `https://example.test/${tag}/win` }],
		...overrides,
	});
	const releases = [release("meta-v0.9.0", { draft: true }), release("meta-v0.4.13"), release("v0.5.0"), release("meta-v0.4.11")];
	for (const [channel, tag] of [["stable", "v0.5.0"], ["meta", "meta-v0.4.13"]]) {
		await writeFile(join(root, "package.json"), JSON.stringify({ updateChannel: channel }));
		response(JSON.stringify(releases));
		const check = await checkForUpdate();
		assert.equal(check.hasUpdate, true);
		assert.equal(check.latest, tag.replace(/^(meta-)?v/, ""));
		assert.equal(check.notes, `notes ${tag}`);
		assert.equal(check.url, `https://example.test/${tag}/${process.platform === "darwin" ? "mac" : "win"}`);
		assert.ok(transport.urls.at(-1).startsWith("https://api.github.com/repos/kid7st/heipang/releases"));
	}
	response(JSON.stringify([release("meta-v0.4.11")]));
	assert.equal((await checkForUpdate()).hasUpdate, false);
	response(JSON.stringify([release("v0.5.0")]));
	assert.match((await checkForUpdate()).error, /No published release/);
	const dismissed = [];
	const shown = [];
	const requests = new InputRequests((request) => shown.push(request), (id) => dismissed.push(id));
	const abort = new AbortController();
	const answer = requests.ask("prompt", { message: "Callback" }, { signal: abort.signal });
	await assert.rejects(requests.ask("prompt", { message: "Concurrent" }), /already open/);
	abort.abort();
	assert.equal(await answer, undefined);
	assert.deepEqual(dismissed, [shown[0].id]);
	requests.respond(shown[0].id, "late");
	const select = requests.ask("select", { message: "Choose", options: [{ id: "choice", label: "Choice" }] });
	requests.respond(shown.at(-1).id, "choice");
	assert.equal(await select, "choice");
	assert.equal(await requests.ask("prompt", { message: "Already aborted" }, { signal: abort.signal }), undefined);
	assert.equal(await requests.ask("prompt", { message: "Timeout" }, { timeout: 5 }), undefined);
	const closed = requests.ask("prompt", { message: "Window closed" });
	requests.dismissAll();
	assert.equal(await closed, undefined);
	const brokenRequests = new InputRequests(() => { throw new Error("send failed"); }, () => {});
	await assert.rejects(brokenRequests.ask("prompt", { message: "Fail" }), /send failed/);

	for (const mode of ["respond", "abort", "timeout", "dismissAll"]) {
		let requestId;
		const destroyedWindow = new InputRequests((request) => { requestId = request.id; }, () => { throw new Error("Object has been destroyed"); });
		const cancellation = new AbortController();
		const pending = destroyedWindow.ask("prompt", { message: mode }, { signal: cancellation.signal, timeout: mode === "timeout" ? 5 : undefined });
		const rejected = assert.rejects(pending, /Object has been destroyed/);
		if (mode === "respond") assert.doesNotThrow(() => destroyedWindow.respond(requestId, "answer"));
		if (mode === "abort") cancellation.abort();
		if (mode === "dismissAll") assert.doesNotThrow(() => destroyedWindow.dismissAll());
		await rejected;
		assert.equal(destroyedWindow.pending.size, 0);
		const retry = destroyedWindow.ask("prompt", { message: "Retry" });
		const retryRejected = assert.rejects(retry, /Object has been destroyed/);
		destroyedWindow.respond(requestId, "retry answer");
		await retryRejected;
	}
	const doublyBroken = new InputRequests(() => { throw new Error("show failed"); }, () => { throw new Error("dismiss failed"); });
	await assert.rejects(doublyBroken.ask("prompt", { message: "Both fail" }), (error) => {
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(error.errors.map((error) => error.message), ["show failed", "dismiss failed"]);
		assert.match(error.message, /show failed.*dismiss failed/);
		return true;
	});

	const { registerIpc } = await jiti.import(resolve("src/main/ipc.ts"));
	const webContents = new EventEmitter();
	webContents.send = () => {};
	const inputDriver = {
		setHandlers() {},
		shutdownController: new AbortController(),
		runtime: async () => ({ login: async (_provider, _type, interaction) => interaction.prompt({ type: "text", message: "Callback" }) }),
		loginAccount: Driver.prototype.loginAccount,
	};
	registerIpc(inputDriver, () => ({ webContents, isDestroyed: () => false }));
	for (const interruption of ["reload", "crash", "destroyed"]) {
		const login = inputDriver.loginAccount("fixture-provider");
		await new Promise(setImmediate);
		webContents.emit("did-start-navigation", {}, "https://example.test/subframe", false, false);
		webContents.emit("did-start-navigation", {}, "file:///index.html#anchor", true, true);
		assert.match((await inputDriver.loginAccount("fixture-provider")).error, /in progress/);
		if (interruption === "reload") webContents.emit("did-start-navigation", {}, "file:///index.html", false, true);
		if (interruption === "crash") webContents.emit("render-process-gone", {}, { reason: "crashed" });
		if (interruption === "destroyed") webContents.emit("destroyed");
		assert.match((await login).error, /Sign-in cancelled/);
		assert.equal(inputDriver.loginController, undefined);
		for (const event of ["destroyed", "render-process-gone", "did-start-navigation"]) assert.equal(webContents.listenerCount(event), 0);
	}

	const trustAgentDir = join(root, "trust-agent");
	const trustProject = join(root, "untrusted-project");
	const trustMarker = join(root, "project-extension-ran");
	await mkdir(join(trustProject, ".pi", "extensions"), { recursive: true });
	await writeFile(join(trustProject, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "max", defaultProjectTrust: "always" }));
	await writeFile(join(trustProject, ".pi", "extensions", "probe.ts"), `import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(trustMarker)}, "executed");
export default function(pi) { appendFileSync(${JSON.stringify(trustMarker)}, " factory"); pi.registerCommand("trust-probe", { handler: async () => {} }); }`);
	await mkdir(join(trustAgentDir, "extensions"), { recursive: true });
	await writeFile(join(trustAgentDir, "extensions", "global.ts"), 'export default function(pi) { pi.registerCommand("global-probe", { handler: async () => {} }); }');
	const trustStore = new ProjectTrustStore(trustAgentDir);
	const noUiResources = await loadSessionResources(trustProject, trustAgentDir, undefined, new AbortController().signal);
	assert.equal(noUiResources.settingsManager.isProjectTrusted(), false);
	assert.ok(noUiResources.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has("global-probe")));
	assert.notEqual(noUiResources.settingsManager.getDefaultThinkingLevel(), "max");
	await assert.rejects(readFile(trustMarker), { code: "ENOENT" });
	const trustRequests = [];
	const trustBridge = { openExternal() {}, async requestInput(...args) { trustRequests.push(args); return "skip"; } };
	await loadSessionResources(trustProject, trustAgentDir, trustBridge, new AbortController().signal);
	assert.equal(trustRequests.length, 1);
	assert.equal(trustStore.get(trustProject), false);
	await loadSessionResources(trustProject, trustAgentDir, trustBridge, new AbortController().signal);
	assert.equal(trustRequests.length, 1);
	await assert.rejects(readFile(trustMarker), { code: "ENOENT" });
	trustStore.set(trustProject, null);
	const cancelledTrust = new AbortController();
	await assert.rejects(loadSessionResources(trustProject, trustAgentDir, {
		...trustBridge, async requestInput() { cancelledTrust.abort(); return "trust"; },
	}, cancelledTrust.signal), { name: "AbortError" });
	assert.equal(trustStore.get(trustProject), null);
	await assert.rejects(readFile(trustMarker), { code: "ENOENT" });
	await assert.rejects(loadSessionResources(trustProject, trustAgentDir, {
		...trustBridge, async requestInput() { return undefined; },
	}, new AbortController().signal), /Project trust confirmation cancelled/);
	let approveTrust;
	const approval = loadSessionResources(trustProject, trustAgentDir, {
		...trustBridge, requestInput() { return new Promise((resolve) => { approveTrust = resolve; }); },
	}, new AbortController().signal);
	await assert.rejects(readFile(trustMarker), { code: "ENOENT" });
	approveTrust("trust");
	const trustedResources = await approval;
	assert.equal(trustedResources.settingsManager.isProjectTrusted(), true);
	assert.equal(trustedResources.settingsManager.getDefaultThinkingLevel(), "max");
	assert.equal(await readFile(trustMarker, "utf8"), "executed factory");
	const resourceDriver = Object.assign(Object.create(Driver.prototype), {
		agentDir: trustAgentDir, session: { resourceLoader: trustedResources.resourceLoader },
	});
	assert.ok((await resourceDriver.getResources()).extensions.some((extension) => extension.commands.includes("trust-probe")));
	assert.equal(await readFile(trustMarker, "utf8"), "executed factory");
	await writeFile(join(trustProject, ".pi", "extensions", "later.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "listed-extension-ran"))}, "bad"); export default function() {}`);
	await resourceDriver.getResources();
	await assert.rejects(readFile(join(root, "listed-extension-ran")), { code: "ENOENT" });
	resourceDriver.session.resourceLoader = noUiResources.resourceLoader;
	assert.equal((await resourceDriver.getResources()).extensions.some((extension) => extension.commands.includes("trust-probe")), false);
	const savedTrustResources = await loadSessionResources(trustProject, trustAgentDir, trustBridge, new AbortController().signal);
	assert.equal(savedTrustResources.settingsManager.isProjectTrusted(), true);
	assert.equal(trustRequests.length, 1);
	const scannedResources = createSessionResources(trustProject, trustAgentDir);
	await scannedResources.resourceLoader.reload();
	assert.equal(scannedResources.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has("trust-probe")), false);
	trustStore.set(trustProject, null);
	await writeFile(join(trustAgentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
	assert.equal((await loadSessionResources(trustProject, trustAgentDir, trustBridge, new AbortController().signal)).settingsManager.isProjectTrusted(), false);
	assert.equal(trustRequests.length, 1);
	await writeFile(join(trustAgentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	trustStore.set(trustProject, false);
	assert.equal((await loadSessionResources(trustProject, trustAgentDir, trustBridge, new AbortController().signal)).settingsManager.isProjectTrusted(), false);
	trustStore.set(trustProject, null);
	assert.equal((await loadSessionResources(trustProject, trustAgentDir, trustBridge, new AbortController().signal)).settingsManager.isProjectTrusted(), true);
	assert.equal(trustRequests.length, 1);
	await writeFile(join(trustAgentDir, "trust.json"), "broken");
	await assert.rejects(loadSessionResources(trustProject, trustAgentDir, trustBridge, new AbortController().signal), /Failed to read trust store/);
	assert.equal(await readFile(join(trustAgentDir, "trust.json"), "utf8"), "broken");
	await rm(join(trustAgentDir, "extensions", "global.ts"));
	assert.equal((await resourceDriver.getResources()).extensions.some((extension) => extension.commands.includes("global-probe")), false);
	assert.ok(noUiResources.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has("global-probe")));

	const makeDriver = () => Object.assign(Object.create(Driver.prototype), {
		agentDir: root, sessionTasks: new WeakMap(), sessionControllers: new Map(), sessionOperations: new WeakMap(), releasingSessions: new WeakMap(), pendingNavigations: new Set(), navigationSequence: 0,
		shutdownController: new AbortController(), credentialRevisions: new Map(), sessionShutdownErrors: new WeakMap(),
		modelRuntimePromise: Promise.resolve({ settleCredentialWrites: async () => {} }),
		bgSessions: new Map(), guiRetryTimers: new Map(), guiRetryAttempt: new Map(), cancelledRuns: new Set(),
		runStart: new Map(), lastRunMs: new Map(), shutdownErrors: [], guiSettings: { autoExtractTasks: false },
		oauthBridge: { openExternal() {}, requestInput: (...args) => requests.ask(...args) },
	});
	const driver = makeDriver();
	const notices = [];
	driver.onError = (message) => notices.push(message);
	const projects = [];
	const projectTrust = new ProjectTrustStore(root);
	for (const name of ["A", "B"]) {
		const cwd = join(root, name);
		projects.push(cwd);
		await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
		projectTrust.set(cwd, true);
		await writeFile(join(cwd, "AGENTS.md"), `Project ${name} instruction sentinel`);
		await writeFile(join(cwd, ".pi", "extensions", "probe.ts"), `export default function(pi) {
 pi.on("session_start", (_event, ctx) => pi.appendEntry("fixture-start", { cwd: ctx.cwd }));
 pi.on("session_shutdown", async (_event, ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  pi.appendEntry("fixture-stop", { cwd: ctx.cwd });
 });
 pi.registerCommand("probe", { handler: async (_args, ctx) => {
  pi.appendEntry("fixture-ui", { hasUI: ctx.hasUI });
  ctx.ui.notify("Project ${name} command output");
 } });
}`);
	}
	const a = await driver.newSession(projects[0]);
	assert.equal(a.state.cwd, projects[0]);
	const sessionA = driver.session;
	assert.ok(sessionA.systemPrompt.includes("Project A instruction sentinel"));
	assert.ok(!sessionA.systemPrompt.includes("Project B instruction sentinel"));
	assert.equal(sessionA.sessionManager.getBranch().filter((entry) => entry.customType === "fixture-start").length, 1);
	await sessionA.prompt("/probe");
	assert.ok(sessionA.sessionManager.getBranch().some((entry) => entry.customType === "fixture-ui" && entry.data.hasUI));
	assert.ok(notices.includes("Project A command output"));
	const controllerA = driver.sessionControllers.get(sessionA);
	const b = await driver.newSession(projects[1]);
	const sessionB = driver.session;
	assert.equal(b.state.cwd, projects[1]);
	assert.notEqual(sessionA.modelRuntime, sessionB.modelRuntime);
	assert.notEqual(sessionA.resourceLoader, sessionB.resourceLoader);
	assert.equal(controllerA.signal.aborted, true);
	assert.equal(sessionA.sessionManager.getBranch().filter((entry) => entry.customType === "fixture-stop").length, 1);
	assert.equal(driver.releaseSession(sessionA), driver.releaseSession(sessionA));
	await driver.releaseSession(sessionA);
	assert.equal(sessionA.sessionManager.getBranch().filter((entry) => entry.customType === "fixture-stop").length, 1);
	assert.ok(sessionB.systemPrompt.includes("Project B instruction sentinel"));
	assert.ok(!sessionB.systemPrompt.includes("Project A instruction sentinel"));
	await sessionB.prompt("/probe");
	assert.ok(notices.includes("Project B command output"));
	assert.ok((await driver.getCommands()).some((command) => command.name === "probe"));
	await driver.disposeSession();
	assert.equal(sessionB.sessionManager.getBranch().filter((entry) => entry.customType === "fixture-stop").length, 1);
	const realCreate = driver.createSession.bind(driver);
	let releaseA;
	const delayed = new Promise((resolve) => { releaseA = resolve; });
	driver.createSession = async (cwd, ...args) => {
		if (cwd === projects[0]) await delayed;
		return realCreate(cwd, ...args);
	};
	const slow = driver.newSession(projects[0]);
	const slowRejected = assert.rejects(slow, /superseded/);
	await driver.newSession(projects[1]);
	releaseA();
	await slowRejected;
	assert.equal(driver.getActiveState().cwd, projects[1]);
	const selectedSession = driver.session;
	let resumeNavigation;
	const navigationPause = new Promise((resolve) => { resumeNavigation = resolve; });
	driver.createSession = async (cwd, ...args) => { await navigationPause; return realCreate(cwd, ...args); };
	const away = driver.newSession(projects[0]);
	const awayRejected = assert.rejects(away, /superseded/);
	await driver.openSession(selectedSession.sessionFile);
	assert.equal(driver.session, selectedSession);
	resumeNavigation();
	await awayRejected;
	assert.equal(driver.session, selectedSession);
	await driver.disposeSession();

	driver.createSession = realCreate;
	await driver.newSession(projects[0]);
	const backgroundSession = driver.session;
	Object.defineProperty(backgroundSession, "isIdle", { configurable: true, value: false });
	await driver.newSession(projects[1]);
	assert.equal(driver.bgSessions.get(backgroundSession.sessionFile).session, backgroundSession);
	assert.equal(driver.sessionControllers.get(backgroundSession).signal.aborted, false);
	assert.equal(backgroundSession.sessionManager.getBranch().filter((entry) => entry.customType === "fixture-stop").length, 0);
	delete backgroundSession.isIdle;
	await driver.finishBackground(backgroundSession.sessionFile);
	assert.equal(backgroundSession.sessionManager.getBranch().filter((entry) => entry.customType === "fixture-stop").length, 1);

	let unblockShutdown;
	let signalShutdown;
	const shutdownGate = new Promise((resolve) => { unblockShutdown = resolve; });
	const shutdownStarted = new Promise((resolve) => { signalShutdown = resolve; });
	const oldRunner = driver.session.extensionRunner;
	const emit = oldRunner.emit.bind(oldRunner);
	oldRunner.emit = async (event) => {
		if (event.type === "session_shutdown") { signalShutdown(); await shutdownGate; }
		return emit(event);
	};
	const duringShutdown = driver.newSession(projects[0]);
	const supersededShutdown = assert.rejects(duringShutdown, /superseded/);
	await shutdownStarted;
	await driver.newSession(projects[1]);
	const latestSession = driver.session;
	unblockShutdown();
	await supersededShutdown;
	assert.equal(driver.session, latestSession);
	await driver.disposeSession();

	await driver.newSession(projects[0]);
	const deletedSession = driver.session;
	let resumeDeletedNavigation;
	const deletedNavigationGate = new Promise((resolve) => { resumeDeletedNavigation = resolve; });
	driver.createSession = async (...args) => { await deletedNavigationGate; return realCreate(...args); };
	const deletedNavigation = driver.newSession(projects[1]);
	const listAll = SessionManager.listAll;
	try {
		SessionManager.listAll = async () => [];
		await driver.deleteFolder(projects[0]);
	} finally { SessionManager.listAll = listAll; }
	resumeDeletedNavigation();
	await deletedNavigation;
	assert.equal(driver.session.sessionManager.getCwd(), projects[1]);
	assert.equal(deletedSession.sessionManager.getBranch().filter((entry) => entry.customType === "fixture-stop").length, 1);
	driver.createSession = realCreate;

	const persistSession = (session) => {
		session.sessionManager.appendMessage({ role: "user", content: "Persisted file mutation fixture", timestamp: Date.now() });
		return session.sessionFile;
	};
	const pauseShutdown = (session) => {
		let resume;
		let started;
		const gate = new Promise((resolve) => { resume = resolve; });
		const entered = new Promise((resolve) => { started = resolve; });
		const runner = session.extensionRunner;
		const emit = runner.emit.bind(runner);
		runner.emit = async (event) => {
			if (event.type === "session_shutdown") { started(); await gate; }
			return emit(event);
		};
		return { entered, resume };
	};
	const preflightProject = join(root, "preflight");
	const preflightKey = `heipang-preflight-${root}`;
	await mkdir(join(preflightProject, ".pi", "extensions"), { recursive: true });
	projectTrust.set(preflightProject, true);
	await writeFile(join(preflightProject, ".pi", "extensions", "input.ts"), `export default function(pi) {
 pi.on("input", async (event) => { await globalThis[Symbol.for(${JSON.stringify(preflightKey)})].input(event); return { action: "continue" }; });
 pi.registerTool({ name: "preflight_fixture", label: "Fixture", description: "Record an isolated test action", parameters: { type: "object", properties: {} },
  execute: async () => { globalThis[Symbol.for(${JSON.stringify(preflightKey)})].tools++; return { content: [{ type: "text", text: "done" }], details: {} }; } });
}`);
	for (const action of ["deleteSession", "archiveSession", "deleteFolder", "navigate", "shutdown"]) {
		for (const phase of ["input", "auth", "context"]) {
			const owner = makeDriver();
			const errors = [];
			owner.onError = (error) => errors.push(error);
			let resume;
			let start;
			const gate = new Promise((resolve) => { resume = resolve; });
			const entered = new Promise((resolve) => { start = resolve; });
			const pause = async () => { start(); await gate; };
			const fixture = { input: phase === "input" ? pause : async () => {}, tools: 0 };
			globalThis[Symbol.for(preflightKey)] = fixture;
			const install = owner.installSessionGuards.bind(owner);
			owner.installSessionGuards = (session) => {
				if (phase === "context") session.agent.transformContext = async (messages) => { await pause(); return messages; };
				install(session);
			};
			await owner.newSession(preflightProject);
			const selected = owner.session;
			const path = persistSession(selected);
			const signal = owner.sessionControllers.get(selected).signal;
			const model = selected.modelRuntime.getModels("anthropic")[0];
			await selected.modelRuntime.setRuntimeApiKey(model.provider, "fixture-key");
			selected.agent.state.model = model;
			if (phase === "auth") {
				selected.modelRuntime.hasConfiguredAuth = () => false;
				selected.modelRuntime.checkAuth = async () => { await pause(); return true; };
			}
			let streams = 0;
			selected.agent.streamFunction = () => {
				const stream = createAssistantMessageEventStream();
				const stopReason = ++streams === 1 ? "toolUse" : "stop";
				const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason,
					content: streams === 1 ? [{ type: "toolCall", id: "fixture-call", name: "preflight_fixture", arguments: {} }] : [{ type: "text", text: "done" }],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "done", reason: stopReason, message }); stream.end();
				return stream;
			};
			await owner.sendMessage("Must not run after release", [], selected.sessionId);
			await entered;
			assert.equal(owner.sessionOperations.get(selected).size, 1);
			const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			let finished = false;
			const originalList = SessionManager.listAll;
			try {
				if (action === "deleteFolder") SessionManager.listAll = async () => [{ cwd: preflightProject, path }];
				let operation;
				if (action === "navigate" && phase === "context") {
					await owner.newSession(projects[1]);
					assert.equal(owner.bgSessions.get(path).session, selected);
					operation = owner.killBackground(path);
				} else operation = action === "navigate" ? owner.newSession(projects[1]) : action === "shutdown" ? owner.shutdown()
					: owner[action](action === "deleteFolder" ? preflightProject : path);
				operation = operation.then(() => { finished = true; });
				await aborted;
				await new Promise(setImmediate);
				assert.equal(finished, false);
				assert.ok(owner.sessionControllers.has(selected));
				await readFile(path);
				resume();
				await operation;
				assert.equal(streams, 0);
				assert.equal(fixture.tools, 0);
				assert.deepEqual(errors, []);
				assert.equal(owner.sessionOperations.get(selected).size, 0);
				await assert.rejects(selected.prompt("Late retained session request"), (error) => error === signal.reason);
				if (["deleteSession", "archiveSession", "deleteFolder"].includes(action)) await assert.rejects(readFile(path), { code: "ENOENT" });
				if (action === "archiveSession") {
					const archived = join(root, "sessions-archived", path.slice(join(root, "sessions").length + 1));
					assert.equal(JSON.parse((await readFile(archived, "utf8")).split("\n")[0]).type, "session");
				}
				if (action === "deleteSession" && phase === "input") {
					await owner.newSession(preflightProject);
					await owner.session.modelRuntime.setRuntimeApiKey(model.provider, "fixture-key");
					owner.session.agent.state.model = model;
					owner.session.agent.streamFunction = selected.agent.streamFunction;
					await owner.session.prompt("Positive control: execute the fixture tool");
					assert.equal(streams, 2);
					assert.equal(fixture.tools, 1);
				}
			} finally { resume(); SessionManager.listAll = originalList; }
			await owner.disposeSession();
		}
	}
	for (const phase of ["input", "auth", "auth-error"]) {
		const owner = makeDriver();
		const errors = [];
		owner.onError = (error) => errors.push(error);
		let resume;
		let enter;
		let startStream;
		let finishInitial;
		let finishFresh;
		let startFresh;
		const freshStreaming = new Promise((resolve) => { startFresh = resolve; });
		const gate = new Promise((resolve) => { resume = resolve; });
		const entered = new Promise((resolve) => { enter = resolve; });
		const streaming = new Promise((resolve) => { startStream = resolve; });
		const fixture = { tools: 0, input: async (event) => {
			if (phase === "input" && event.text === "Stopped follow-up") { enter(); await gate; }
		} };
		globalThis[Symbol.for(preflightKey)] = fixture;
		let streams = 0;
		const install = owner.installSessionGuards.bind(owner);
		owner.installSessionGuards = (session) => {
			session.agent.streamFunction = (model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				const index = ++streams;
				const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
					stopReason: index === 1 ? "aborted" : index === 2 ? "toolUse" : "stop",
					content: index === 2 ? [{ type: "toolCall", id: "stop-fixture-call", name: "preflight_fixture", arguments: {} }] : [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				if (index === 1) {
					options.signal.addEventListener("abort", () => { stream.push({ type: "error", reason: "aborted", error: message }); stream.end(); }, { once: true });
					finishInitial = () => { stream.push({ type: "done", reason: "stop", message: { ...message, stopReason: "stop" } }); stream.end(); };
					startStream();
				} else if (index === 2) {
					finishFresh = () => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); };
					startFresh();
				} else { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); }
				return stream;
			};
			install(session);
		};
		await owner.newSession(preflightProject);
		const selected = owner.session;
		const model = selected.modelRuntime.getModels("anthropic")[0];
		await selected.modelRuntime.setRuntimeApiKey(model.provider, "fixture-key");
		selected.agent.state.model = model;
		if (phase !== "input") {
			let checks = 0;
			selected.modelRuntime.hasConfiguredAuth = () => false;
			selected.modelRuntime.checkAuth = async () => {
				if (++checks === 2) {
					enter(); await gate;
					if (phase === "auth-error") throw new Error("fixture stopped prompt authentication failure");
				}
				return true;
			};
		}
		await owner.sendMessage("Initial running prompt", [], selected.sessionId);
		await streaming;
		if (phase !== "input") { finishInitial(); await selected.waitForIdle(); }
		else {
			await owner.sendMessage("Queued before Stop", [], selected.sessionId);
			assert.equal(selected.pendingMessageCount, 1);
		}
		const following = owner.sendMessage("Stopped follow-up", [], selected.sessionId);
		await entered;
		assert.equal(owner.getActiveState().isStreaming, phase === "input");
		await owner.abort();
		assert.equal(streams, 1);
		assert.equal(fixture.tools, 0);
		assert.equal(owner.sessionControllers.get(selected).signal.aborted, false);
		assert.equal(selected.pendingMessageCount, 0);
		const fresh = selected.prompt("Fresh prompt after Stop");
		await freshStreaming;
		resume();
		await following;
		await new Promise(setImmediate);
		assert.equal(streams, 2);
		assert.equal(fixture.tools, 0);
		assert.equal(selected.pendingMessageCount, 0);
		finishFresh();
		await fresh;
		assert.equal(streams, 3);
		assert.equal(fixture.tools, 1);
		assert.equal(owner.sessionOperations.get(selected).size, 0);
		assert.equal(owner.getMessages().some((message) => ["Stopped follow-up", "Queued before Stop"].includes(message.content)), false);
		assert.deepEqual(errors, phase === "auth-error" ? ["fixture stopped prompt authentication failure"] : []);
		await owner.disposeSession();
	}
	globalThis[Symbol.for(preflightKey)] = { input: async () => {}, tools: 0 };
	const failedPromptOwner = makeDriver();
	const promptErrors = [];
	failedPromptOwner.onError = (error) => promptErrors.push(error);
	await failedPromptOwner.newSession(preflightProject);
	const failedPromptSession = failedPromptOwner.session;
	const failedPromptPath = persistSession(failedPromptSession);
	failedPromptSession.agent.state.model = failedPromptSession.modelRuntime.getModels("anthropic")[0];
	failedPromptSession.modelRuntime.hasConfiguredAuth = () => false;
	let failPrompt;
	let startPrompt;
	const promptFailure = new Promise((_resolve, reject) => { failPrompt = reject; });
	const promptStarted = new Promise((resolve) => { startPrompt = resolve; });
	failedPromptSession.modelRuntime.checkAuth = () => { startPrompt(); return promptFailure; };
	await failedPromptOwner.sendMessage("An actual auth failure must stay visible", [], failedPromptSession.sessionId);
	await promptStarted;
	const failedPromptDeletion = assert.rejects(failedPromptOwner.deleteSession(failedPromptPath), /fixture prompt auth failure/);
	failPrompt(new Error("fixture prompt auth failure"));
	await failedPromptDeletion;
	assert.ok(promptErrors.includes("fixture prompt auth failure"));
	assert.equal(JSON.parse((await readFile(failedPromptPath, "utf8")).split("\n")[0]).type, "session");
	delete globalThis[Symbol.for(preflightKey)];

	const reopenProject = join(root, "reopen-owner");
	await mkdir(join(reopenProject, ".pi", "extensions"), { recursive: true });
	projectTrust.set(reopenProject, true);
	await writeFile(join(reopenProject, ".pi", "extensions", "dirty.ts"), `export default function(pi) {
 let dirty = false;
 pi.registerCommand("mark-dirty", { handler: async () => { dirty = true; } });
 pi.on("session_shutdown", () => { if (dirty) pi.appendEntry("saved-dirty-state", {}); });
}`);
	for (const source of ["leaving", "background"]) {
		const owner = makeDriver();
		await owner.newSession(reopenProject);
		const selected = owner.session;
		await selected.prompt("/mark-dirty");
		const path = persistSession(selected);
		const closing = pauseShutdown(selected);
		let leaving;
		if (source === "leaving") leaving = assert.rejects(owner.newSession(projects[1]), /superseded/);
		else {
			Object.defineProperty(selected, "isIdle", { configurable: true, value: false });
			await owner.newSession(projects[1]);
			delete selected.isIdle;
			leaving = owner.finishBackground(path);
		}
		await closing.entered;
		const alias = join(dirname(path), `${source}-alias.jsonl`);
		await symlink(path, alias);
		let opened = false;
		const opening = owner.openSession(alias).then(() => { opened = true; });
		await new Promise(setImmediate);
		assert.equal(opened, false);
		assert.notEqual(owner.session?.sessionFile, alias);
		closing.resume();
		await Promise.all([leaving, opening]);
		assert.ok(owner.session.sessionManager.getBranch().some((entry) => entry.customType === "saved-dirty-state"));
		owner.session.sessionManager.appendMessage({ role: "user", content: "New user turn after reopening", timestamp: Date.now() });
		await owner.disposeSession();
		await owner.openSession(path);
		assert.ok(owner.getMessages().some((message) => message.content === "New user turn after reopening"));
		await owner.disposeSession();
		await rm(alias);
	}

	const pendingOwner = makeDriver();
	await pendingOwner.newSession(reopenProject);
	const pendingPath = persistSession(pendingOwner.session);
	await pendingOwner.disposeSession();
	const createPending = pendingOwner.createSession.bind(pendingOwner);
	let resumePending;
	let startPending;
	const pendingGate = new Promise((resolve) => { resumePending = resolve; });
	const pendingStarted = new Promise((resolve) => { startPending = resolve; });
	let pausePending = true;
	pendingOwner.createSession = async (...args) => {
		const result = await createPending(...args);
		if (pausePending) {
			pausePending = false;
			await result.session.prompt("/mark-dirty");
			startPending(); await pendingGate;
		}
		return result;
	};
	const firstOpening = assert.rejects(pendingOwner.openSession(pendingPath), /superseded/);
	await pendingStarted;
	let secondOpened = false;
	const secondOpening = pendingOwner.openSession(pendingPath).then(() => { secondOpened = true; });
	await new Promise(setImmediate);
	assert.equal(secondOpened, false);
	resumePending();
	await Promise.all([firstOpening, secondOpening]);
	assert.ok(pendingOwner.session.sessionManager.getBranch().some((entry) => entry.customType === "saved-dirty-state"));
	assert.equal(pendingOwner.sessionControllers.size, 1);
	assert.equal(pendingOwner.pendingNavigations.size, 0);
	await pendingOwner.disposeSession();

	for (const interruption of ["navigation", "deleteSession", "deleteFolder", "shutdown", "releaseFailure"]) {
		const owner = makeDriver();
		await owner.newSession(reopenProject);
		const selected = owner.session;
		const path = persistSession(selected);
		if (interruption === "releaseFailure") selected.extensionRunner.emit = async () => { throw new Error("fixture releasing owner failed"); };
		const closing = pauseShutdown(selected);
		const leaving = assert.rejects(owner.newSession(projects[1]), interruption === "releaseFailure" ? /fixture releasing owner failed/ : /superseded/);
		await closing.entered;
		const reopening = assert.rejects(owner.openSession(path), interruption === "releaseFailure" ? /fixture releasing owner failed/ : /superseded|closing/);
		const originalList = SessionManager.listAll;
		try {
			let operation;
			if (interruption === "navigation") {
				await owner.newSession(projects[1]);
				assert.equal(owner.session.sessionManager.getCwd(), projects[1]);
			} else if (interruption === "deleteSession") operation = owner.deleteSession(path);
			else if (interruption === "deleteFolder") {
				SessionManager.listAll = async () => [{ cwd: reopenProject, path }];
				operation = owner.deleteFolder(reopenProject);
			} else if (interruption === "shutdown") operation = owner.shutdown();
			closing.resume();
			await Promise.all([leaving, reopening, operation]);
			if (["deleteSession", "deleteFolder"].includes(interruption)) {
				await assert.rejects(owner.openSession(path), /Session file no longer exists/);
				await assert.rejects(readFile(path), { code: "ENOENT" });
			}
		} finally { closing.resume(); SessionManager.listAll = originalList; }
		await owner.disposeSession();
	}

	for (const operation of ["deleteSession", "archiveSession"]) {
		await driver.newSession(projects[0]);
		const targetSession = driver.session;
		const path = persistSession(targetSession);
		const shutdown = pauseShutdown(targetSession);
		const mutation = driver[operation](path);
		await shutdown.entered;
		await driver.newSession(projects[1]);
		const otherSession = driver.session;
		await assert.rejects(driver.openSession(path), /being deleted or archived/);
		await assert.rejects(driver.renameSession(path, "Must not write"), /being deleted or archived/);
		await assert.rejects(driver.deleteSession(path), /Another session file operation/);
		assert.equal(driver.session, otherSession);
		assert.ok(driver.sessionControllers.has(targetSession));
		shutdown.resume();
		await mutation;
		assert.equal(driver.session, otherSession);
		assert.equal(driver.sessionControllers.has(targetSession), false);
		await assert.rejects(readFile(path), { code: "ENOENT" });
		if (operation === "archiveSession") {
			const archived = join(root, "sessions-archived", path.slice(join(root, "sessions").length + 1));
			const entries = (await readFile(archived, "utf8")).trim().split("\n").map(JSON.parse);
			assert.equal(entries[0].type, "session");
			assert.equal(entries.filter((entry) => entry.customType === "fixture-stop").length, 1);
		}
		assert.equal(driver.fileMutation, undefined);
	}

	await driver.newSession(projects[0]);
	const folderSession = driver.session;
	const folderPath = persistSession(folderSession);
	await writeFile(`${folderPath}.tasks.json`, "[]");
	const folderShutdown = pauseShutdown(folderSession);
	let resumeListing;
	let startListing;
	const listingGate = new Promise((resolve) => { resumeListing = resolve; });
	const listingStarted = new Promise((resolve) => { startListing = resolve; });
	try {
		SessionManager.listAll = async () => { startListing(); await listingGate; return listAll(dirname(folderPath)); };
		const deletion = driver.deleteFolder(projects[0]);
		await folderShutdown.entered;
		await assert.rejects(driver.newSession(projects[0]), /being deleted or archived/);
		await assert.rejects(driver.openSession(folderPath), /being deleted or archived/);
		await driver.newSession(projects[1]);
		const otherSession = driver.session;
		folderShutdown.resume();
		await listingStarted;
		await assert.rejects(driver.openSession(folderPath), /being deleted or archived/);
		await assert.rejects(driver.newSession(projects[0]), /being deleted or archived/);
		await readFile(folderPath);
		resumeListing();
		await deletion;
		await assert.rejects(readFile(folderPath), { code: "ENOENT" });
		await assert.rejects(readFile(`${folderPath}.tasks.json`), { code: "ENOENT" });
		assert.equal(driver.session, otherSession);
	} finally { SessionManager.listAll = listAll; }

	for (const alreadySuperseded of [false, true]) {
		const seed = (await realCreate(projects[0], new AbortController())).session;
		const path = persistSession(seed);
		await driver.releaseSession(seed);
		let resumeRuntime;
		let startRuntime;
		const runtimeGate = new Promise((resolve) => { resumeRuntime = resolve; });
		const runtimeStarted = new Promise((resolve) => { startRuntime = resolve; });
		const createRuntime = driver.createModelRuntime.bind(driver);
		let pauseNext = true;
		driver.createModelRuntime = async () => {
			const runtime = await createRuntime();
			if (pauseNext) { pauseNext = false; startRuntime(); await runtimeGate; }
			return runtime;
		};
		const opening = driver.openSession(path);
		const rejectedOpening = assert.rejects(opening, /superseded/);
		await runtimeStarted;
		if (alreadySuperseded) await driver.newSession(projects[1]);
		let deleted = false;
		const deletion = driver.deleteSession(path).then(() => { deleted = true; });
		await new Promise(setImmediate);
		assert.equal(deleted, false);
		await readFile(path);
		await assert.rejects(driver.openSession(path), /being deleted or archived/);
		resumeRuntime();
		await rejectedOpening;
		await deletion;
		assert.equal(driver.pendingNavigations.size, 0);
		assert.equal([...driver.sessionControllers.keys()].some((session) => session.sessionFile === path), false);
		await assert.rejects(readFile(path), { code: "ENOENT" });
		driver.createModelRuntime = createRuntime;
	}

	await driver.newSession(projects[0]);
	const leavingSession = driver.session;
	const leavingPath = persistSession(leavingSession);
	const leavingShutdown = pauseShutdown(leavingSession);
	const leaving = driver.newSession(projects[1]);
	await leavingShutdown.entered;
	assert.equal(driver.session, undefined);
	let removedLeaving = false;
	const removeLeaving = driver.deleteSession(leavingPath).then(() => { removedLeaving = true; });
	await new Promise(setImmediate);
	assert.equal(removedLeaving, false);
	leavingShutdown.resume();
	await Promise.all([leaving, removeLeaving]);
	await assert.rejects(readFile(leavingPath), { code: "ENOENT" });
	assert.equal(driver.getActiveState().cwd, projects[1]);

	await driver.newSession(projects[0]);
	const failureSession = driver.session;
	const failurePath = persistSession(failureSession);
	const blockedArchive = join(root, "sessions-archived", failurePath.slice(join(root, "sessions").length + 1));
	await mkdir(blockedArchive, { recursive: true });
	await assert.rejects(driver.archiveSession(failurePath), /EISDIR|ENOTDIR|EEXIST/);
	assert.equal(driver.fileMutation, undefined);
	assert.equal(JSON.parse((await readFile(failurePath, "utf8")).split("\n")[0]).type, "session");
	await driver.openSession(failurePath);
	assert.equal(driver.session.sessionFile, failurePath);
	const cleanupFailure = driver.session;
	cleanupFailure.extensionRunner.emit = async () => { throw new Error("fixture destructive cleanup failure"); };
	await assert.rejects(driver.deleteSession(failurePath), /fixture destructive cleanup failure/);
	assert.equal(driver.fileMutation, undefined);
	assert.equal(driver.sessionControllers.has(cleanupFailure), false);
	assert.equal(JSON.parse((await readFile(failurePath, "utf8")).split("\n")[0]).type, "session");
	await driver.openSession(failurePath);
	await driver.disposeSession();

	for (const operation of ["deleteSession", "archiveSession", "deleteFolder"]) {
		for (const phase of ["refresh", "auth"]) {
			await driver.newSession(projects[0]);
			const selected = driver.session;
			const path = persistSession(selected);
			const model = selected.modelRuntime.getModels("anthropic")[0];
			let resume;
			let start;
			const gate = new Promise((resolve) => { resume = resolve; });
			const entered = new Promise((resolve) => { start = resolve; });
			const pause = async () => { start(); await gate; };
			if (phase === "refresh") selected.modelRuntime.refresh = async () => { await pause(); return { errors: new Map() }; };
			selected.modelRuntime.checkAuth = async () => { if (phase === "auth") await pause(); return true; };
			const changing = assert.rejects(driver.setModel(model.provider, model.id), /session is closing/);
			await entered;
			let finished = false;
			try {
				if (operation === "deleteFolder") SessionManager.listAll = async () => [{ cwd: projects[0], path }];
				const mutation = driver[operation](operation === "deleteFolder" ? projects[0] : path).then(() => { finished = true; });
				await new Promise(setImmediate);
				assert.equal(finished, false);
				assert.ok(driver.sessionControllers.has(selected));
				assert.equal(selected.sessionManager.getBranch().filter((entry) => entry.customType === "fixture-stop").length, 0);
				await assert.rejects(driver.sendMessage("Must not create a default-directory session", [], selected.sessionId), /selected session has changed/);
				assert.equal(driver.session, undefined);
				assert.equal(JSON.parse((await readFile(path, "utf8")).split("\n")[0]).type, "session");
				resume();
				await Promise.all([mutation, changing]);
				await assert.rejects(readFile(path), { code: "ENOENT" });
				if (operation === "archiveSession") {
					const archived = join(root, "sessions-archived", path.slice(join(root, "sessions").length + 1));
					assert.equal(JSON.parse((await readFile(archived, "utf8")).split("\n")[0]).type, "session");
				}
			} finally { resume(); SessionManager.listAll = listAll; }
		}
	}

	await driver.newSession(projects[0]);
	const failedModelSession = driver.session;
	const failedModelPath = persistSession(failedModelSession);
	const failedModel = failedModelSession.modelRuntime.getModels("anthropic")[0];
	let failModel;
	let startModel;
	const modelFailure = new Promise((_resolve, reject) => { failModel = reject; });
	const modelStarted = new Promise((resolve) => { startModel = resolve; });
	failedModelSession.modelRuntime.checkAuth = async () => { startModel(); return modelFailure; };
	const failedSwitch = assert.rejects(driver.setModel(failedModel.provider, failedModel.id), /fixture model auth failure/);
	await modelStarted;
	const failedDeletion = assert.rejects(driver.deleteSession(failedModelPath), /fixture model auth failure/);
	failModel(new Error("fixture model auth failure"));
	await Promise.all([failedSwitch, failedDeletion]);
	assert.equal(JSON.parse((await readFile(failedModelPath, "utf8")).split("\n")[0]).type, "session");
	assert.equal(driver.fileMutation, undefined);

	const shutdownErrorProject = join(root, "shutdown-error");
	await mkdir(join(shutdownErrorProject, ".pi", "extensions"), { recursive: true });
	await writeFile(join(shutdownErrorProject, ".pi", "extensions", "fail.ts"), `export default function(pi) {
 pi.on("session_shutdown", () => { throw new Error("fixture shutdown hook failure"); });
 pi.on("session_shutdown", async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  pi.appendEntry("fixture-after-failed-shutdown", {});
 });
 pi.on("session_shutdown", () => { throw new Error("fixture second shutdown hook failure"); });
}`);
	projectTrust.set(shutdownErrorProject, true);
	const shutdownErrorSession = (await realCreate(shutdownErrorProject, new AbortController())).session;
	await assert.rejects(driver.releaseSession(shutdownErrorSession), /fixture shutdown hook failure/);
	assert.ok(notices.some((message) => message.includes("fixture shutdown hook failure")));

	for (const operation of ["deleteSession", "archiveSession", "deleteFolder"]) {
		for (const background of [false, true]) {
			const owner = makeDriver();
			const errors = [];
			owner.onError = (error) => errors.push(error);
			await owner.newSession(shutdownErrorProject);
			const selected = owner.session;
			const path = persistSession(selected);
			let disposed = 0;
			let settled = 0;
			const dispose = selected.dispose.bind(selected);
			selected.dispose = () => { disposed++; dispose(); };
			const settle = selected.modelRuntime.settleCredentialWrites.bind(selected.modelRuntime);
			selected.modelRuntime.settleCredentialWrites = async () => {
				settled++; await settle();
				if (operation === "archiveSession") throw new Error("fixture native hook credential failure");
			};
			if (background) {
				Object.defineProperty(selected, "isIdle", { value: false, configurable: true });
				await owner.newSession(projects[1]);
				delete selected.isIdle;
			}
			const unrelated = background ? owner.session : undefined;
			await assert.rejects(owner[operation](operation === "deleteFolder" ? shutdownErrorProject : path), (error) => {
				assert.ok(error instanceof AggregateError);
				assert.equal(error.errors.length, operation === "archiveSession" ? 3 : 2);
				assert.match(error.message, /fixture shutdown hook failure/);
				assert.match(error.message, /fixture second shutdown hook failure/);
				if (operation === "archiveSession") assert.match(error.message, /fixture native hook credential failure/);
				return true;
			});
			const entries = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
			assert.equal(entries[0].type, "session");
			assert.equal(entries.filter((entry) => entry.customType === "fixture-after-failed-shutdown").length, 1);
			assert.equal(disposed, 1);
			assert.equal(settled, 1);
			assert.equal(owner.sessionControllers.has(selected), false);
			assert.equal(owner.sessionShutdownErrors.has(selected), false);
			assert.equal(owner.fileMutation, undefined);
			assert.equal(owner.session, unrelated);
			assert.equal(errors.filter((error) => /fixture (second )?shutdown hook failure/.test(error)).length, 2);
			await owner.shutdown();
		}
	}

	const cleanupOrder = [];
	await assert.rejects(driver.releaseSession({
		modelRuntime: { settleCredentialWrites: async () => {} },
		abort: async () => { throw new Error("fixture abort failure"); },
		extensionRunner: { emit: async () => { cleanupOrder.push("shutdown"); } },
		dispose: () => { cleanupOrder.push("dispose"); },
	}), /fixture abort failure/);
	assert.deepEqual(cleanupOrder, ["shutdown", "dispose"]);
	await assert.rejects(driver.releaseSession({
		abort: async () => {},
		modelRuntime: { settleCredentialWrites: async () => {} },
		extensionRunner: { emit: async () => { throw new Error("fixture shutdown failure"); } },
		dispose: () => { cleanupOrder.push("dispose-after-failure"); },
	}), /fixture shutdown failure/);
	assert.equal(cleanupOrder.at(-1), "dispose-after-failure");

	const shutdownDriver = makeDriver();
	await shutdownDriver.newSession(projects[0]);
	const shutdownBackground = shutdownDriver.session;
	persistSession(shutdownBackground);
	Object.defineProperty(shutdownBackground, "isIdle", { configurable: true, value: false });
	await shutdownDriver.newSession(projects[1]);
	const shutdownActive = shutdownDriver.session;
	delete shutdownBackground.isIdle;
	persistSession(shutdownActive);
	const backgroundStop = pauseShutdown(shutdownBackground);
	const activeStop = pauseShutdown(shutdownActive);
	let resumeShutdownRuntime;
	let startShutdownRuntime;
	const shutdownRuntimeGate = new Promise((resolve) => { resumeShutdownRuntime = resolve; });
	const shutdownRuntimeStarted = new Promise((resolve) => { startShutdownRuntime = resolve; });
	const shutdownCreateRuntime = shutdownDriver.createModelRuntime.bind(shutdownDriver);
	shutdownDriver.createModelRuntime = async () => {
		const runtime = await shutdownCreateRuntime();
		startShutdownRuntime();
		await shutdownRuntimeGate;
		return runtime;
	};
	const openingAtQuit = shutdownDriver.newSession(projects[0]);
	const cancelledAtQuit = assert.rejects(openingAtQuit, /superseded|closing/);
	await shutdownRuntimeStarted;
	shutdownDriver.loginController = new AbortController();
	let quitFinished = false;
	const shutdown = shutdownDriver.shutdown();
	assert.equal(shutdownDriver.shutdown(), shutdown);
	const completedShutdown = shutdown.then(() => { quitFinished = true; });
	await Promise.all([backgroundStop.entered, activeStop.entered]);
	assert.equal(shutdownDriver.loginController.signal.aborted, true);
	await assert.rejects(shutdownDriver.newSession(projects[0]), /application is closing/);
	await assert.rejects(shutdownDriver.sendMessage("Must not run"), /application is closing/);
	assert.match((await shutdownDriver.loginAccount("fixture-provider")).error, /application is closing/);
	backgroundStop.resume(); activeStop.resume();
	await Promise.all([shutdownDriver.releaseSession(shutdownActive), shutdownDriver.releaseSession(shutdownBackground)]);
	assert.equal(quitFinished, false);
	resumeShutdownRuntime();
	await cancelledAtQuit;
	await completedShutdown;
	assert.equal(shutdownDriver.session, undefined);
	assert.equal(shutdownDriver.sessionControllers.size, 0);
	assert.equal(shutdownDriver.bgSessions.size, 0);
	assert.equal(shutdownDriver.pendingNavigations.size, 0);
	for (const session of [shutdownActive, shutdownBackground]) {
		const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
		assert.equal(entries.filter((entry) => entry.customType === "fixture-stop").length, 1);
	}

	const nativeShutdownFailure = makeDriver();
	await nativeShutdownFailure.newSession(shutdownErrorProject);
	await assert.rejects(nativeShutdownFailure.shutdown(), /fixture shutdown hook failure/);
	assert.equal(nativeShutdownFailure.sessionControllers.size, 0);

	const failingShutdown = makeDriver();
	const disposedAtQuit = [];
	const failingActive = {
		modelRuntime: { settleCredentialWrites: async () => {} },
		sessionId: "quit-active", sessionFile: "quit-active", abort: async () => { throw new Error("fixture quit abort failure"); },
		extensionRunner: { emit: async () => {} }, dispose: () => disposedAtQuit.push("active"),
	};
	const failingBackground = {
		modelRuntime: { settleCredentialWrites: async () => {} },
		sessionId: "quit-background", sessionFile: "quit-background", abort: async () => {},
		extensionRunner: { emit: async () => { throw new Error("fixture quit hook failure"); } }, dispose: () => disposedAtQuit.push("background"),
	};
	failingShutdown.session = failingActive;
	failingShutdown.bgSessions.set("quit-background", { session: failingBackground, unsubscribe() {} });
	for (const session of [failingActive, failingBackground]) failingShutdown.sessionControllers.set(session, new AbortController());
	await assert.rejects(failingShutdown.shutdown(), (error) => {
		assert.ok(error instanceof AggregateError);
		assert.equal(error.errors.length, 2);
		assert.match(error.message, /fixture quit abort failure/);
		assert.match(error.message, /fixture quit hook failure/);
		return true;
	});
	assert.deepEqual(disposedAtQuit.sort(), ["active", "background"]);
	assert.equal(failingShutdown.sessionControllers.size, 0);

	const mutationAtQuit = makeDriver();
	let resumeQuitListing;
	let startQuitListing;
	const quitListing = new Promise((resolve) => { resumeQuitListing = resolve; });
	const quitListingStarted = new Promise((resolve) => { startQuitListing = resolve; });
	try {
		SessionManager.listAll = async () => { startQuitListing(); await quitListing; return []; };
		const deletion = mutationAtQuit.deleteFolder(projects[0]);
		await quitListingStarted;
		let closed = false;
		const close = mutationAtQuit.shutdown().then(() => { closed = true; });
		await new Promise(setImmediate);
		assert.equal(closed, false);
		resumeQuitListing();
		await Promise.all([deletion, close]);
		assert.equal(mutationAtQuit.fileMutation, undefined);
	} finally { SessionManager.listAll = listAll; }

	const pausedRotation = async (runtime, id) => {
		let resume;
		let start;
		let refreshes = 0;
		const gate = new Promise((resolve) => { resume = resolve; });
		const entered = new Promise((resolve) => { start = resolve; });
		await runtime.credentials.modify(id, () => ({ type: "oauth", access: "old-fixture-access", refresh: "old-fixture-refresh", expires: 0 }));
		runtime.registerNativeProvider(createProvider({
			id, models: [], api: { stream: () => { throw new Error("Unused fixture stream"); } },
			auth: { oauth: {
				name: id, login: async () => { throw new Error("Unused fixture login"); },
				refresh: async (credential) => {
					refreshes++; start(); await gate;
					return { ...credential, access: "new-fixture-access", refresh: "new-fixture-refresh", expires: Date.now() + 3_600_000 };
				},
				toAuth: (credential) => ({ apiKey: credential.access }),
			} },
		}));
		return { entered, resume, get refreshes() { return refreshes; }, read: () => runtime.getAuth(id) };
	};
	const catalogClose = makeDriver();
	const catalogRuntime = await catalogClose.createModelRuntime();
	const catalogRotation = await pausedRotation(catalogRuntime, "review-catalog-oauth");
	const catalogRead = catalogRotation.read();
	await catalogRotation.entered;
	let finishCatalogCreation;
	catalogClose.modelRuntimePromise = new Promise((resolve) => { finishCatalogCreation = () => resolve(catalogRuntime); });
	let catalogClosed = false;
	const closingCatalog = catalogClose.shutdown().then(() => { catalogClosed = true; });
	await new Promise(setImmediate);
	assert.equal(catalogClosed, false);
	finishCatalogCreation();
	await new Promise(setImmediate);
	assert.equal(catalogClosed, false);
	assert.equal(JSON.parse(await readFile(join(root, "auth.json"), "utf8"))["review-catalog-oauth"].refresh, "old-fixture-refresh");
	catalogRotation.resume();
	await Promise.all([catalogRead, closingCatalog]);
	assert.equal(JSON.parse(await readFile(join(root, "auth.json"), "utf8"))["review-catalog-oauth"].refresh, "new-fixture-refresh");

	const releasedClose = makeDriver();
	await releasedClose.newSession(projects[0]);
	const rotatingSession = releasedClose.session;
	const sessionRotation = await pausedRotation(rotatingSession.modelRuntime, "review-session-oauth");
	const sessionRead = sessionRotation.read();
	await sessionRotation.entered;
	let released = false;
	const releasing = releasedClose.disposeSession().then(() => { released = true; });
	await new Promise(setImmediate);
	assert.equal(released, false);
	assert.ok(releasedClose.sessionControllers.has(rotatingSession));
	await releasedClose.newSession(projects[1]);
	let releasedClosed = false;
	const closingReleased = releasedClose.shutdown().then(() => { releasedClosed = true; });
	await new Promise(setImmediate);
	assert.equal(releasedClosed, false);
	sessionRotation.resume();
	await Promise.all([sessionRead, releasing, closingReleased]);
	assert.equal(releasedClose.sessionControllers.size, 0);
	assert.equal(JSON.parse(await readFile(join(root, "auth.json"), "utf8"))["review-session-oauth"].refresh, "new-fixture-refresh");

	const creatingClose = makeDriver();
	let creationRotation;
	let creationRead;
	let finishCreation;
	let signalCreation;
	const creationGate = new Promise((resolve) => { finishCreation = resolve; });
	const creationEntered = new Promise((resolve) => { signalCreation = resolve; });
	const createClosingRuntime = creatingClose.createModelRuntime.bind(creatingClose);
	creatingClose.createModelRuntime = async () => {
		const runtime = await createClosingRuntime();
		creationRotation = await pausedRotation(runtime, "review-creating-oauth");
		creationRead = creationRotation.read();
		await creationRotation.entered;
		signalCreation(); await creationGate;
		return runtime;
	};
	const cancelledCreation = assert.rejects(creatingClose.newSession(projects[0]), /superseded|closing/);
	await creationEntered;
	let creationClosed = false;
	const closingCreation = creatingClose.shutdown().then(() => { creationClosed = true; });
	finishCreation();
	await new Promise(setImmediate);
	assert.equal(creationClosed, false);
	creationRotation.resume();
	await Promise.all([creationRead, cancelledCreation, closingCreation]);
	assert.equal(JSON.parse(await readFile(join(root, "auth.json"), "utf8"))["review-creating-oauth"].refresh, "new-fixture-refresh");

	const lateAuthClose = makeDriver();
	const lateAuthRuntime = await lateAuthClose.createModelRuntime();
	lateAuthClose.modelRuntimePromise = Promise.resolve(lateAuthRuntime);
	const lateRotation = await pausedRotation(lateAuthRuntime, "review-late-oauth");
	let resumeAuth;
	const authGate = new Promise((resolve) => { resumeAuth = resolve; });
	const lateCatalog = new ModelCatalog(root, async () => { await authGate; return lateAuthRuntime; }, SettingsManager.inMemory(), lateAuthClose.shutdownController.signal);
	const lateRead = lateCatalog.providerApiKey("review-late-oauth");
	await lateAuthClose.shutdown();
	resumeAuth();
	assert.equal(await lateRead, undefined);
	assert.equal(lateRotation.refreshes, 0);
	await assert.rejects(lateAuthClose.logoutAccount("review-late-oauth"), /application is closing/);

	const loginOwner = makeDriver();
	await loginOwner.newSession(projects[0]);
	loginOwner.session.modelRuntime.login = async (_provider, _type, interaction) => {
		assert.ok(interaction.signal);
		await interaction.prompt({ type: "text", message: "Session-owned login" });
		interaction.signal.throwIfAborted();
	};
	const ownedLogin = loginOwner.loginAccount("fixture-provider");
	await new Promise(setImmediate);
	assert.equal(requests.pending.size, 1);
	await loginOwner.disposeSession();
	assert.equal((await ownedLogin).ok, false);
	assert.equal(requests.pending.size, 0);
	assert.equal(loginOwner.loginController, undefined);

	for (const owner of ["catalog", "catalog-live", "session", "session-abort", "creating"]) {
		const failing = makeDriver();
		failing.agentDir = join(root, `credential-failure-${owner}`);
		await mkdir(failing.agentDir);
		await writeFile(join(failing.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
		const id = `fixture-failing-${owner}`;
		let runtime;
		let rotation;
		let reading;
		let opening;
		let finishCreation;
		if (owner === "creating") {
			let enterCreation;
			const entered = new Promise((resolve) => { enterCreation = resolve; });
			const gate = new Promise((resolve) => { finishCreation = resolve; });
			const create = failing.createModelRuntime.bind(failing);
			failing.createModelRuntime = async () => {
				runtime = await create();
				rotation = await pausedRotation(runtime, id);
				reading = rotation.read();
				await rotation.entered;
				enterCreation(); await gate;
				return runtime;
			};
			opening = assert.rejects(failing.newSession(projects[0]), /Could not save credentials/);
			await entered;
		} else {
			if (owner.startsWith("session")) {
				await failing.newSession(projects[0]);
				runtime = failing.session.modelRuntime;
				if (owner === "session-abort") failing.session.abort = () => { throw new Error("fixture credential abort failure"); };
			} else {
				runtime = await failing.createModelRuntime();
				failing.modelRuntimePromise = Promise.resolve(runtime);
			}
			rotation = await pausedRotation(runtime, id);
			const catalog = new ModelCatalog(failing.agentDir, async () => runtime, SettingsManager.inMemory(), owner === "catalog-live" ? undefined : failing.shutdownController.signal);
			reading = catalog.providerApiKey(id);
			await rotation.entered;
		}
		const readResult = owner === "creating" || owner === "catalog-live" ? assert.rejects(reading, /Credential store modify failed/) : reading;
		const authPath = join(failing.agentDir, "auth.json");
		const backup = `${authPath}.backup`;
		await rename(authPath, backup);
		await mkdir(authPath);
		try {
			let closed = false;
			const closing = assert.rejects(failing.shutdown(), (error) => {
				assert.ok(error instanceof AggregateError);
				assert.match(error.message, new RegExp(`Could not save credentials for ${id}`));
				assert.match(error.message, /EISDIR|EACCES|EPERM/);
				if (owner === "session-abort") assert.match(error.message, /fixture credential abort failure/);
				return true;
			}).then(() => { closed = true; });
			finishCreation?.();
			await new Promise(setImmediate);
			assert.equal(closed, false);
			rotation.resume();
			await Promise.all([readResult, opening, closing]);
			assert.equal(failing.sessionControllers.size, 0);
			assert.equal(JSON.parse(await readFile(backup, "utf8"))[id].refresh, "old-fixture-refresh");
		} finally {
			await rm(authPath, { recursive: true, force: true });
			await rename(backup, authPath);
		}
		await assert.rejects(runtime.settleCredentialWrites(), /Could not save credentials/);
		await runtime.credentials.modify(id, async () => undefined);
		await assert.rejects(runtime.settleCredentialWrites(), /Could not save credentials/);
		await runtime.credentials.modify(id, async () => ({ type: "api_key", key: "fixture-recovered-key" }));
		await runtime.settleCredentialWrites();
		const callbackError = new Error("fixture refresh callback failure");
		await assert.rejects(runtime.credentials.modify(id, async () => { throw callbackError; }), (error) => error === callbackError);
		const cancellation = new AbortController(); cancellation.abort();
		await assert.rejects(runtime.credentials.modify(id, async () => undefined, { signal: cancellation.signal }), (error) => error === cancellation.signal.reason);
		await runtime.settleCredentialWrites();
		if (owner === "catalog") {
			await rename(authPath, backup);
			await mkdir(authPath);
			try {
				await assert.rejects(runtime.credentials.modify(id, async () => ({ type: "api_key", key: "fixture-unsaved-key" })), /EISDIR|EACCES|EPERM/);
			} finally {
				await rm(authPath, { recursive: true, force: true });
				await rename(backup, authPath);
			}
			await assert.rejects(runtime.settleCredentialWrites(), /Could not save credentials/);
			await runtime.logout(id);
			await runtime.settleCredentialWrites();
			assert.equal(JSON.parse(await readFile(authPath, "utf8"))[id], undefined);
		}
	}
	for (const recovery of ["logout", "replacement"]) {
		const owner = makeDriver();
		owner.agentDir = join(root, `shared-credential-recovery-${recovery}`);
		await mkdir(owner.agentDir);
		await writeFile(join(owner.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
		const catalogRuntime = await owner.createModelRuntime();
		owner.modelRuntimePromise = Promise.resolve(catalogRuntime);
		await owner.newSession(projects[0]);
		const sessionRuntime = owner.session.modelRuntime;
		assert.notEqual(catalogRuntime, sessionRuntime);
		const id = "fixture-shared-recovery";
		const rotation = await pausedRotation(catalogRuntime, id);
		const catalog = new ModelCatalog(owner.agentDir, async () => catalogRuntime, SettingsManager.inMemory());
		const reading = catalog.providerApiKey(id);
		await rotation.entered;
		const authPath = join(owner.agentDir, "auth.json");
		const backup = `${authPath}.backup`;
		const failWrite = async (write) => {
			await rename(authPath, backup);
			await mkdir(authPath);
			try { await assert.rejects(write(), /Credential store modify failed|EISDIR|EACCES|EPERM/); }
			finally { await rm(authPath, { recursive: true, force: true }); await rename(backup, authPath); }
		};
		await failWrite(async () => { rotation.resume(); await reading; });
		await assert.rejects(catalogRuntime.settleCredentialWrites(), /Could not save credentials/);
		await failWrite(() => sessionRuntime.credentials.modify(id, () => ({ type: "api_key", key: "fixture-unsaved-replacement" })));
		const unresolved = async () => {
			for (const runtime of [catalogRuntime, sessionRuntime]) await assert.rejects(runtime.settleCredentialWrites(), /Could not save credentials/);
		};
		await unresolved();
		await sessionRuntime.credentials.modify(id, () => undefined);
		await sessionRuntime.credentials.modify("fixture-other-provider", () => ({ type: "api_key", key: "fixture-other-key" }));
		await unresolved();
		const otherStore = makeDriver();
		otherStore.agentDir = join(root, `other-credential-store-${recovery}`);
		const otherRuntime = await otherStore.createModelRuntime();
		otherStore.modelRuntimePromise = Promise.resolve(otherRuntime);
		await otherRuntime.credentials.modify(id, () => ({ type: "api_key", key: "fixture-other-store-key" }));
		await unresolved();
		const recoveringRuntime = await owner.createModelRuntime();
		await recoveringRuntime.settleCredentialWrites();
		if (recovery === "logout") await owner.logoutAccount(id);
		else await recoveringRuntime.credentials.modify(id, () => ({ type: "api_key", key: "fixture-recovered-replacement" }));
		for (const runtime of [catalogRuntime, sessionRuntime, recoveringRuntime]) await runtime.settleCredentialWrites();
		const stored = JSON.parse(await readFile(authPath, "utf8"));
		assert.deepEqual(stored[id], recovery === "logout" ? undefined : { type: "api_key", key: "fixture-recovered-replacement" });
		assert.equal(stored["fixture-other-provider"].key, "fixture-other-key");
		await Promise.all([owner.shutdown(), otherStore.shutdown()]);
	}
	const { unresolvedCredentialErrors } = await jiti.import(resolve("src/main/model-runtime.ts"));
	const unrelatedCleanupError = new AggregateError([new Error("fixture unrelated cleanup error")], "fixture cleanup context");
	assert.deepEqual(unresolvedCredentialErrors(unrelatedCleanupError), [unrelatedCleanupError]);
	for (const scenario of ["active", "background", "creating", "mixed-errors", "unresolved-provider"]) {
		const owner = makeDriver();
		owner.agentDir = join(root, `credential-recovery-during-shutdown-${scenario}`);
		await mkdir(owner.agentDir);
		await writeFile(join(owner.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: scenario === "mixed-errors" ? "always" : "never", cacheWarming: "off" }));
		if (scenario !== "creating") await owner.newSession(scenario === "mixed-errors" ? shutdownErrorProject : projects[0]);
		const failedRuntime = owner.session?.modelRuntime ?? await owner.createModelRuntime();
		const recoveringRuntime = await owner.createModelRuntime();
		owner.modelRuntimePromise = Promise.resolve(recoveringRuntime);
		const id = "fixture-recovery-at-quit";
		const rotation = await pausedRotation(recoveringRuntime, id);
		await Promise.all([failedRuntime.refresh({ allowNetwork: false }), recoveringRuntime.refresh({ allowNetwork: false })]);
		const authPath = join(owner.agentDir, "auth.json");
		const backup = `${authPath}.backup`;
		await rename(authPath, backup);
		await mkdir(authPath);
		try {
			await assert.rejects(failedRuntime.credentials.modify(id, () => ({ type: "api_key", key: "fixture-unsaved-key" })), /EISDIR|EACCES|EPERM/);
			if (scenario === "unresolved-provider") {
				await assert.rejects(failedRuntime.credentials.modify("fixture-unrecovered-provider", () => ({ type: "api_key", key: "fixture-unsaved-other-key" })), /EISDIR|EACCES|EPERM/);
			}
		} finally {
			await rm(authPath, { recursive: true, force: true });
			await rename(backup, authPath);
		}
		await assert.rejects(failedRuntime.settleCredentialWrites(), /Could not save credentials/);
		if (scenario === "background") {
			const selected = owner.session;
			Object.defineProperty(selected, "isIdle", { configurable: true, value: false });
			await owner.newSession(projects[1]);
			delete selected.isIdle;
			assert.equal(owner.bgSessions.size, 1);
		}
		if (scenario === "mixed-errors") owner.session.abort = () => { throw new Error("fixture recovery quit abort failure"); };
		let reportFailure;
		const failureReported = new Promise(resolve => { reportFailure = resolve; });
		const settle = failedRuntime.settleCredentialWrites.bind(failedRuntime);
		failedRuntime.settleCredentialWrites = async () => {
			try { await settle(); }
			catch (error) { reportFailure(); throw error; }
		};
		let resumeCreation;
		let opening;
		if (scenario === "creating") {
			let enterCreation;
			const creationEntered = new Promise(resolve => { enterCreation = resolve; });
			const creationGate = new Promise(resolve => { resumeCreation = resolve; });
			owner.createModelRuntime = async () => { enterCreation(); await creationGate; return failedRuntime; };
			opening = assert.rejects(owner.newSession(projects[0]), /Could not save credentials/);
			await creationEntered;
		}
		const reading = rotation.read();
		await rotation.entered;
		let closed = false;
		const closing = owner.shutdown().then(() => ({ ok: true }), error => ({ ok: false, error })).then(result => { closed = true; return result; });
		resumeCreation?.();
		await failureReported;
		await new Promise(setImmediate);
		assert.equal(closed, false);
		rotation.resume();
		await Promise.all([reading, opening]);
		const result = await closing;
		assert.equal(JSON.parse(await readFile(authPath, "utf8"))[id].refresh, "new-fixture-refresh");
		if (scenario === "mixed-errors") {
			assert.equal(result.ok, false);
			assert.equal(result.error.errors.length, 3);
			assert.match(result.error.message, /fixture recovery quit abort failure/);
			assert.match(result.error.message, /fixture shutdown hook failure/);
			assert.match(result.error.message, /fixture second shutdown hook failure/);
			assert.doesNotMatch(result.error.message, /Could not save credentials/);
		} else if (scenario === "unresolved-provider") {
			assert.equal(result.ok, false);
			assert.match(result.error.message, /Could not save credentials for fixture-unrecovered-provider/);
			assert.doesNotMatch(result.error.message, /Could not save credentials for fixture-recovery-at-quit/);
		} else {
			assert.equal(result.ok, true, result.error?.message);
			await failedRuntime.settleCredentialWrites();
		}
		assert.equal(owner.sessionControllers.size, 0);
		assert.equal(owner.pendingNavigations.size, 0);
		assert.equal(owner.bgSessions.size, 0);
	}
	const visibleAuthFailure = new ModelCatalog(root, async () => ({ getAuth: async () => { throw new Error("fixture visible auth failure"); } }), SettingsManager.inMemory());
	await assert.rejects(visibleAuthFailure.providerApiKey("anthropic"), /fixture visible auth failure/);
	assert.match((await visibleAuthFailure.fetchRemoteModels()).error, /fixture visible auth failure/);
	const releaseFailures = makeDriver();
	await assert.rejects(releaseFailures.releaseSession({
		abort: () => { throw new Error("fixture combined abort failure"); },
		extensionRunner: { emit: async () => { throw new Error("fixture combined hook failure"); } },
		dispose: () => { throw new Error("fixture combined dispose failure"); },
		modelRuntime: { settleCredentialWrites: async () => { throw new Error("fixture session credential failure"); } },
	}), (error) => {
		assert.ok(error instanceof AggregateError);
		assert.equal(error.errors.length, 4);
		for (const phase of ["abort", "hook", "dispose"]) assert.match(error.message, new RegExp(`fixture combined ${phase} failure`));
		assert.match(error.message, /fixture session credential failure/);
		return true;
	});

	let selectedChoice;
	driver.runtime = async () => ({ login: async (_provider, _type, interaction) => {
		selectedChoice = await interaction.prompt({ type: "select", message: "Account", options: [{ id: "account-id", label: "Account" }] });
	} });
	const login = driver.loginAccount("fixture-provider");
	await new Promise(setImmediate);
	assert.match((await driver.loginAccount("other-provider")).error, /in progress/);
	assert.deepEqual(shown.at(-1).payload.options, [{ id: "account-id", label: "Account" }]);
	requests.respond(shown.at(-1).id, "account-id");
	assert.equal((await login).ok, true);
	assert.equal(selectedChoice, "account-id");
	const workingBridge = driver.oauthBridge;
	let brokenLoginId;
	const brokenLoginRequests = new InputRequests((request) => { brokenLoginId = request.id; }, () => { throw new Error("Object has been destroyed"); });
	driver.oauthBridge = { openExternal() {}, requestInput: (...args) => brokenLoginRequests.ask(...args) };
	const brokenLogin = driver.loginAccount("fixture-provider");
	await new Promise(setImmediate);
	brokenLoginRequests.respond(brokenLoginId, "account-id");
	assert.match((await brokenLogin).error, /Object has been destroyed/);
	assert.equal(driver.loginController, undefined);
	driver.oauthBridge = workingBridge;
	driver.runtime = async () => ({ login: async (_provider, _type, interaction) => {
		const callback = new AbortController();
		const paste = interaction.prompt({ type: "text", message: "Callback", signal: callback.signal });
		callback.abort();
		await assert.rejects(paste, /cancelled/);
	} });
	assert.equal((await driver.loginAccount("fixture-provider")).ok, true);

	const settings = SettingsManager.inMemory();
	const known = { provider: "test", id: "built-in", name: "Built-in", reasoning: true, contextWindow: 100, maxTokens: 20 };
	let refreshed = 0;
	const runtime = { getModel: (_provider, id) => id === known.id ? known : undefined, refresh: async () => { refreshed++; } };
	const catalogRoot = join(root, "catalog");
	await mkdir(catalogRoot);
	const catalog = new ModelCatalog(catalogRoot, async () => runtime, settings);
	await catalog.addModels([{ provider: known.provider, id: known.id, name: known.name }]);
	await assert.rejects(readFile(join(catalogRoot, "models.json")), { code: "ENOENT" });
	catalog.remember([{ provider: "openai-codex", id: "new-model", display_name: "Live model", contextWindow: 123456, maxTokens: 12345 }]);
	await catalog.addModels([{ provider: "openai-codex", id: "new-model", name: "Live model" }]);
	const custom = JSON.parse(await readFile(join(catalogRoot, "models.json"), "utf8")).providers["openai-codex"].models[0];
	assert.equal(custom.contextWindow, 123456);
	assert.equal(custom.maxTokens, 12345);
	assert.equal(refreshed, 1);
	const permissionPath = join(catalogRoot, "models.json");
	const permissionData = JSON.parse(await readFile(permissionPath, "utf8"));
	permissionData.providers.test = { apiKey: "fixture-only-not-secret" };
	await writeFile(permissionPath, JSON.stringify(permissionData));
	await chmod(permissionPath, 0o600);
	const staleTemporary = `${permissionPath}.tmp`;
	await writeFile(staleTemporary, "Unrelated stale temporary file", { mode: 0o644 });
	const mask = process.umask(0o022);
	try {
		await catalog.addModels([{ provider: known.provider, id: known.id, name: "Secure model edit" }]);
		if (process.platform !== "win32") assert.equal((await stat(permissionPath)).mode & 0o777, 0o600);
		assert.equal(JSON.parse(await readFile(permissionPath, "utf8")).providers.test.apiKey, "fixture-only-not-secret");
		assert.equal(await readFile(staleTemporary, "utf8"), "Unrelated stale temporary file");
		assert.deepEqual((await readdir(catalogRoot)).filter((name) => name.startsWith(".models-")), []);
		await rm(permissionPath);
		await catalog.addModels([{ provider: known.provider, id: known.id, name: "Secure new configuration" }]);
		if (process.platform !== "win32") assert.equal((await stat(permissionPath)).mode & 0o777, 0o600);
	} finally { process.umask(mask); }
	await writeFile(join(catalogRoot, "models.json"), "broken");
	await assert.rejects(catalog.addModels([{ provider: "test", id: "new", name: "New" }]));
	assert.equal(await readFile(join(catalogRoot, "models.json"), "utf8"), "broken");
	catalog.catalogMem = { fetchedAt: Date.now(), models: [{ provider: "test", id: "cached" }] };
	catalog.fetchCatalogRemote = async () => { throw new Error("fixture network failure"); };
	assert.equal((await catalog.loadCatalog()).length, 1);
	assert.deepEqual(await catalog.refreshModelCatalog(), { ok: false, error: "fixture network failure" });

	const sdkCatalogRoot = join(root, "sdk-catalog");
	const runtimeOptions = { authPath: join(sdkCatalogRoot, "auth.json"), modelsPath: join(sdkCatalogRoot, "models.json"), allowModelNetwork: false };
	const sdkRuntime = await ModelRuntime.create(runtimeOptions);
	const sdkCatalog = new ModelCatalog(sdkCatalogRoot, async () => sdkRuntime, SettingsManager.inMemory());
	const modelSnapshot = (model) => JSON.parse(JSON.stringify(model));
	const builtin = sdkRuntime.getModels("anthropic").find((model) => model.reasoning && model.input.includes("image"));
	assert.ok(builtin);
	await sdkCatalog.addModels([{ provider: builtin.provider, id: builtin.id, name: "Renamed built-in" }]);
	assert.deepEqual(modelSnapshot(sdkRuntime.getModel(builtin.provider, builtin.id)), modelSnapshot({ ...builtin, name: "Renamed built-in" }));
	await sdkCatalog.addModels([{ provider: builtin.provider, id: builtin.id, maxTokens: 4096 }]);
	const savedModels = JSON.parse(await readFile(runtimeOptions.modelsPath, "utf8"));
	assert.equal(savedModels.providers.anthropic.models, undefined);
	assert.deepEqual(savedModels.providers.anthropic.modelOverrides[builtin.id], { name: "Renamed built-in", maxTokens: 4096 });
	const reopenedRuntime = await ModelRuntime.create(runtimeOptions);
	assert.deepEqual(modelSnapshot(reopenedRuntime.getModel(builtin.provider, builtin.id)), modelSnapshot({ ...builtin, name: "Renamed built-in", maxTokens: 4096 }));
	await sdkCatalog.addModels([{ provider: "openai-codex", id: "fixture-custom", name: "Custom", contextWindow: 123456, maxTokens: 7890 }]);
	const customBefore = sdkRuntime.getModel("openai-codex", "fixture-custom");
	assert.ok(customBefore);
	await sdkCatalog.addModels([{ provider: "openai-codex", id: "fixture-custom", name: "Renamed custom" }]);
	assert.deepEqual(modelSnapshot(sdkRuntime.getModel("openai-codex", "fixture-custom")), modelSnapshot({ ...customBefore, name: "Renamed custom" }));

	const nativeRuntimeEntry = await build({
		entryPoints: ["src/main/model-runtime.ts"], bundle: true, packages: "external",
		platform: "node", format: "esm", write: false,
	});
	await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
	const nativeRuntimePath = join(root, "model-runtime.mjs");
	await writeFile(nativeRuntimePath, nativeRuntimeEntry.outputFiles[0].text);
	const { createPersistentModelRuntime } = await import(pathToFileURL(nativeRuntimePath).href);
	const nativeRuntime = await createPersistentModelRuntime(join(root, "native-runtime"), new AbortController().signal, new Map());
	assert.ok(nativeRuntime.getModels().length > 0);
	await nativeRuntime.settleCredentialWrites();

	const updateEntry = await build({
		stdin: { contents: 'export { registerIpc } from "./src/main/ipc.ts";', resolveDir: process.cwd() },
		bundle: true, platform: "node", format: "cjs", write: false,
		define: { "process.platform": '"win32"', setTimeout: "globalThis.__heipangUpdateTest.schedule" },
		plugins: [{
			name: "update-fixtures",
			setup(builder) {
				builder.onResolve({ filter: /^electron$|^node:(child_process|os)$|^\.\/mac-update\.js$/ }, (args) => ({ path: args.path, namespace: "update-fixture" }));
				builder.onLoad({ filter: /.*/, namespace: "update-fixture" }, (args) => {
					if (args.path === "electron") return { contents: 'export const { app, net, shell, ipcMain, dialog, Notification } = globalThis.__heipangUpdateTest;' };
					if (args.path === "node:os") return { contents: 'export const tmpdir = () => globalThis.__heipangUpdateTest.root; export const homedir = tmpdir;' };
					if (args.path === "node:child_process") return { contents: 'export const spawn = (...args) => globalThis.__heipangUpdateTest.spawn(...args);' };
					return { contents: 'export const MAC_INSTALL_SCRIPT = ""; export const prepareMacUpdate = () => { throw new Error("Unexpected macOS update"); };' };
				});
			},
		}],
	});
	try {
		for (const scenario of ["success", "shutdown-failure", "spawn-failure", "download-failure"]) {
			const handlers = new Map();
			const events = [];
			let finishShutdown;
			let failShutdown;
			let enterShutdown;
			let quit;
			let shutdownCalls = 0;
			const shutdown = new Promise((resolve, reject) => { finishShutdown = resolve; failShutdown = reject; });
			const entered = new Promise((resolve) => { enterShutdown = resolve; });
			const hooks = {
				root, dialog: {}, shell: {}, Notification: class {},
				app: { quit: () => events.push("quit") },
				ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
				schedule: (callback) => { quit = callback; },
				net: { request: () => {
					const request = new EventEmitter();
					request.abort = () => {}; request.setHeader = () => {};
					request.end = () => queueMicrotask(() => {
						const incoming = new EventEmitter();
						incoming.statusCode = scenario === "download-failure" ? 403 : 200;
						incoming.headers = { "content-length": "9" };
						request.emit("response", incoming);
						if (incoming.statusCode === 200) { incoming.emit("data", Buffer.from("installer")); incoming.emit("end"); }
					});
					return request;
				} },
				spawn: (command, args) => {
					assert.equal(command.endsWith("Setup.exe"), true);
					assert.deepEqual(args, ["/S", "--force-run"]);
					events.push("installer-started");
					const child = new EventEmitter(); child.unref = () => {};
					queueMicrotask(() => scenario === "spawn-failure" ? child.emit("error", new Error("fixture installer spawn failure")) : child.emit("spawn"));
					return child;
				},
			};
			globalThis.__heipangUpdateTest = hooks;
			const entry = join(root, `update-${scenario}.cjs`);
			await writeFile(entry, updateEntry.outputFiles[0].text);
			const { registerIpc: registerUpdateIpc } = createRequire(import.meta.url)(entry);
			registerUpdateIpc({ setHandlers() {}, shutdown() { shutdownCalls++; enterShutdown(); return shutdown; } }, () => ({
				isDestroyed: () => false, webContents: { send: (_channel, event) => events.push(event) },
			}));
			const install = handlers.get("pi:installUpdate")({}, "https://example.test/Setup.exe");
			if (scenario === "download-failure") {
				await install;
				assert.equal(shutdownCalls, 0);
			} else {
				await entered;
				assert.equal(shutdownCalls, 1);
				assert.equal(events.includes("installer-started"), false);
				assert.equal(quit, undefined);
				await assert.rejects(handlers.get("pi:installUpdate")({}, "https://example.test/Setup.exe"), /already in progress/);
				if (scenario === "shutdown-failure") failShutdown(new Error("fixture update shutdown failure"));
				else { events.push("shutdown-finished"); finishShutdown(); }
				await install;
			}
			if (scenario === "success") {
				assert.ok(events.indexOf("shutdown-finished") < events.indexOf("installer-started"));
				assert.equal(events.at(-1).phase, "relaunch");
				assert.equal(events.includes("quit"), false);
				quit();
				assert.equal(events.at(-1), "quit");
			} else {
				assert.equal(events.at(-1).phase, "error");
				assert.match(events.at(-1).message, scenario === "download-failure" ? /HTTP 403/ : scenario === "shutdown-failure" ? /fixture update shutdown failure/ : /fixture installer spawn failure/);
				assert.equal(quit, undefined);
				assert.equal(events.at(-1).message.includes("Restart the application"), scenario !== "download-failure");
				if (scenario !== "spawn-failure") assert.equal(events.includes("installer-started"), false);
			}
		}
	} finally { delete globalThis.__heipangUpdateTest; }

	const appEntry = await build({
		entryPoints: ["src/main/index.ts"], bundle: true, platform: "node", format: "cjs", write: false,
		define: { "console.error": "globalThis.__heipangAppTest.logError" },
		plugins: [{
			name: "application-fixtures",
			setup(builder) {
				builder.onResolve({ filter: /^electron$|^\.\/(driver|ipc|provider-compat)\.js$/ }, (args) => ({ path: args.path, namespace: "app-fixture" }));
				builder.onLoad({ filter: /.*/, namespace: "app-fixture" }, (args) => {
					if (args.path === "electron") return { contents: `
import { EventEmitter } from "node:events";
const hooks = globalThis.__heipangAppTest;
export const app = hooks.app;
export const dialog = { showErrorBox: (title, message) => hooks.errors.push({ title, message }) };
export const nativeImage = {};
export const shell = {};
export class BrowserWindow extends EventEmitter {
 constructor() { super(); this.webContents = { setWindowOpenHandler() {} }; }
 loadFile() {} loadURL() {}
 static getAllWindows() { return []; }
}` };
					if (args.path === "./driver.js") return { contents: 'export class Driver { constructor() { return globalThis.__heipangAppTest.driver; } }' };
					if (args.path === "./ipc.js") return { contents: "export const registerIpc = () => {};" };
					return { contents: "export const installStreamDecompressionFix = () => {};" };
				});
			},
		}],
	});
	const originalResourcesPath = process.resourcesPath;
	process.resourcesPath = root;
	try {
		for (const fails of [false, true]) {
			const app = new EventEmitter();
			let finishShutdown;
			let failShutdown;
			let shutdownCalls = 0;
			let exits = 0;
			const pending = new Promise((resolve, reject) => { finishShutdown = resolve; failShutdown = reject; });
			app.requestSingleInstanceLock = () => true;
			app.whenReady = () => Promise.resolve();
			app.quit = () => {
				const event = { prevented: false, preventDefault() { this.prevented = true; } };
				app.emit("before-quit", event);
				if (!event.prevented) exits++;
			};
			const hooks = { app, errors: [], logs: [],
				driver: { shutdown() { shutdownCalls++; return pending; } },
				logError(...args) { this.logs.push(args); },
			};
			globalThis.__heipangAppTest = hooks;
			const entry = join(root, `app-${fails}.cjs`);
			await writeFile(entry, appEntry.outputFiles[0].text);
			createRequire(import.meta.url)(entry);
			await new Promise(setImmediate);
			app.quit(); app.quit();
			assert.equal(exits, 0);
			assert.equal(shutdownCalls, 1);
			if (fails) failShutdown(new Error("fixture application shutdown failure"));
			else finishShutdown();
			await new Promise(setImmediate);
			assert.equal(exits, 1);
			assert.equal(hooks.errors.length, fails ? 1 : 0);
			assert.equal(hooks.logs.length, fails ? 1 : 0);
			if (fails) assert.match(hooks.errors[0].message, /fixture application shutdown failure/);
			app.quit();
			assert.equal(shutdownCalls, 1);
		}
	} finally {
		delete globalThis.__heipangAppTest;
		if (originalResourcesPath === undefined) delete process.resourcesPath;
		else process.resourcesPath = originalResourcesPath;
	}

	const rendererHooks = { states: [], refs: [], effects: [], stateIndex: 0, refIndex: 0 };
	const originalWindow = globalThis.window;
	const originalConfirm = globalThis.confirm;
	globalThis.__heipangRendererTest = rendererHooks;
	const rendererCleanups = [];
	try {
		const compiled = await build({
			stdin: { contents: await readFile("src/renderer/src/App.tsx", "utf8"), loader: "tsx", resolveDir: resolve("src/renderer/src") },
			bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
			plugins: [{
				name: "renderer-fixtures",
				setup(builder) {
					builder.onResolve({ filter: /^(react|react\/jsx-runtime)$|^\.\/components\/|\.png$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
					builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
						if (args.path === "react") return { contents: `
const hooks = globalThis.__heipangRendererTest;
export const useState = initial => {
 const index = hooks.stateIndex++;
 if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
 return [hooks.states[index], value => { hooks.states[index] = typeof value === "function" ? value(hooks.states[index]) : value; }];
};
export const useRef = value => hooks.refs[hooks.refIndex++] ??= { current: value };
export const useMemo = fn => fn();
export const useCallback = fn => fn;
export const useEffect = fn => { hooks.effects.push(fn); };
` };
						if (args.path === "react/jsx-runtime") return { contents: "export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;" };
						if (args.path.endsWith(".png")) return { contents: 'export default "fixture.png";' };
						const name = args.path.split("/").at(-1);
						return { contents: `export const ${name} = ${JSON.stringify(name)};` };
					});
				},
			}],
		});
		const rendererPath = join(root, "renderer.cjs");
		await writeFile(rendererPath, compiled.outputFiles[0].text);
		const App = createRequire(import.meta.url)(rendererPath).default;
		const findComponent = (node, type) => {
			if (!node || typeof node !== "object") return undefined;
			if (node.type === type) return node;
			for (const child of [node.props?.children].flat(Infinity)) {
				const found = findComponent(child, type);
				if (found) return found;
			}
		};
		const render = () => {
			rendererHooks.stateIndex = 0;
			rendererHooks.refIndex = 0;
			rendererHooks.effects = [];
			return App();
		};
		for (const scenario of ["empty-startup", "existing-session", "new-session-events", "new-session-without-state-event", "newer-navigation"]) {
			const owner = makeDriver();
			owner.agentDir = join(root, `startup-${scenario}`);
			await mkdir(owner.agentDir);
			await writeFile(join(owner.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", cacheWarming: "off" }));
			owner.newSession = (cwd = projects[0]) => Driver.prototype.newSession.call(owner, cwd);
			const create = owner.createSession.bind(owner);
			owner.createSession = async (...args) => {
				const result = await create(...args);
				const session = result.session;
				const model = session.modelRuntime.getModels("anthropic")[0];
				await session.modelRuntime.setRuntimeApiKey(model.provider, "fixture-key");
				session.agent.state.model = model;
				session.agent.streamFunction = () => {
					const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
						stopReason: "stop", content: [{ type: "text", text: "Startup fixture answer" }],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message }); stream.end();
					return stream;
				};
				return result;
			};
			let resumeModels;
			try {
				if (scenario === "existing-session") {
					await owner.newSession();
					await owner.session.prompt("Existing conversation");
				}
				rendererHooks.states = [];
				rendererHooks.refs = [];
				let event;
				let modelRequests = 0;
				const models = { all: [], available: [], enabled: [] };
				const modelsGate = new Promise(resolve => { resumeModels = resolve; });
				globalThis.window = { pi: {
					onEvent: callback => { event = callback; return () => {}; },
					listModels: () => ++modelRequests === 1 ? modelsGate : Promise.resolve(models),
					getActiveState: async () => owner.getActiveState(),
					getMessages: async () => owner.getMessages(),
					getTasks: async () => owner.getTasks(),
					getCommands: async () => [{ name: "startup-command" }],
					getGuiSettings: async () => ({ autoExtractTasks: false, rightPanelOpen: true, workspaceNames: {}, folderOrder: [], sidebarWidth: 280, rightPanelWidth: 320, sidebarCollapsed: false }),
					listSessions: async () => [], getUsage: async () => null,
					sendMessage: (...args) => owner.sendMessage(...args),
					newSession: cwd => owner.newSession(cwd),
				} };
				owner.onError = assert.fail;
				owner.onState = state => { if (scenario !== "new-session-without-state-event") event({ type: "state", state }); };
				owner.onMessagesPatch = (from, messages, sessionId) => event({ type: "patch", from, messages, sessionId });
				owner.onMessages = (messages, sessionId) => event({ type: "messages", messages, sessionId });
				const tree = render();
				rendererCleanups.push(rendererHooks.effects.find(effect => effect.toString().includes("sessionRefreshTimers.current"))());
				rendererHooks.effects.find(effect => effect.toString().includes("window.pi.onEvent"))();
				rendererHooks.effects.find(effect => effect.toString().includes("getGuiSettings"))();
				if (scenario === "existing-session") {
					await assert.rejects(findComponent(tree, "Composer").props.onSend("Too early", []), /selected session has changed/);
					event({ type: "state", state: owner.getActiveState() });
				} else if (scenario === "newer-navigation") {
					await findComponent(tree, "Sidebar").props.onNewInFolder(projects[1]);
				} else if (scenario.startsWith("new-session")) {
					await findComponent(tree, "Composer").props.onSend("First prompt", []);
					await Promise.all([...owner.sessionOperations.get(owner.session)]);
					event({ type: "messages", sessionId: owner.session.sessionId, messages: owner.getMessages() });
				}
				resumeModels(models);
				await new Promise(setImmediate);
				const restored = findComponent(render(), "HeaderBar").props.state;
				assert.equal(restored?.sessionId, owner.getActiveState()?.sessionId, scenario);
				assert.equal(restored?.sessionFile, owner.getActiveState()?.sessionFile, scenario);
				assert.deepEqual(findComponent(render(), "MessageList").props.messages, owner.getMessages(), scenario);
				if (scenario === "empty-startup" || scenario === "existing-session") {
					assert.deepEqual(findComponent(render(), "Composer").props.commands, [{ name: "startup-command" }]);
				} else if (scenario.startsWith("new-session")) {
					assert.equal(owner.getMessages().length, 2);
				}
				await findComponent(render(), "Composer").props.onSend("Follow-up prompt", []);
				await Promise.all([...owner.sessionOperations.get(owner.session)]);
				assert.equal(owner.getMessages().at(-1).content[0].text, "Startup fixture answer");
			} finally {
				resumeModels?.({ all: [], available: [], enabled: [] });
				await owner.shutdown();
			}
		}
		const initialState = { sessionId: "A", sessionFile: "/A/a.jsonl", cwd: "/A", isStreaming: false };
		const nextState = { ...initialState, sessionId: "B", sessionFile: "/B/b.jsonl", cwd: "/B" };
		const nextMessages = [{ role: "user", content: "New conversation" }];
		for (const scenario of ["current", "other", "newer-navigation", "pending-navigation", "failure", "archive-failure", "delete-failure", "failure-newer-navigation", "failure-pending-navigation", "failure-metadata", "inflight-delete", "inflight-archive", "inflight-folder", "inflight-unsaved", "inflight-failure", "inflight-newer", "inflight-other"]) {
			rendererHooks.states = [null, initialState, [{ role: "user", content: "Old conversation" }], [], [{ id: "old-task" }], [{ name: "old-command" }], null];
			if (scenario === "inflight-unsaved") rendererHooks.states[1] = { ...initialState, sessionFile: undefined };
			rendererHooks.refs = [];
			let event;
			globalThis.confirm = () => true;
			globalThis.window = { pi: {
				onEvent: (callback) => { event = callback; return () => {}; },
				listSessions: async () => [],
				getActiveState: async () => nextState,
				getMessages: async () => [],
				getTasks: async () => [],
				getCommands: async () => [],
				listModels: async () => ({ all: [], available: [], enabled: [] }),
				getUsage: async () => null,
				newSession: async () => ({ state: nextState, messages: nextMessages }),
				deleteFolder: async () => { window.pi.getActiveState = async () => null; },
				sendMessage: async () => {
					event({ type: "state", state: nextState });
					event({ type: "patch", sessionId: "B", from: 0, messages: nextMessages });
				},
			} };
			let tree = render();
			rendererCleanups.push(rendererHooks.effects.find((effect) => effect.toString().includes("sessionRefreshTimers.current"))());
			rendererHooks.effects.find((effect) => effect.toString().includes("window.pi.onEvent"))();
			const folder = { cwd: scenario === "other" || scenario === "inflight-other" ? "/Other" : "/A", name: "Folder", count: 1 };
			if (scenario.startsWith("inflight-")) {
				const method = scenario === "inflight-delete" ? "deleteSession" : scenario === "inflight-archive" ? "archiveSession" : "deleteFolder";
				const callback = scenario === "inflight-delete" ? "onDeleteSession" : scenario === "inflight-archive" ? "onArchiveSession" : "onDeleteFolder";
				const target = method === "deleteFolder" ? folder : { path: initialState.sessionFile, name: "Old conversation" };
				let finish;
				let fail;
				let sends = 0;
				let modelChanges = 0;
				const send = window.pi.sendMessage;
				window.pi.sendMessage = async (...args) => {
					sends++;
					assert.equal(args[2], scenario === "inflight-other" ? "A" : "B");
					if (scenario !== "inflight-other") await send(...args);
				};
				window.pi.setModel = async () => { modelChanges++; return initialState; };
				window.pi.setThinkingLevel = async () => { modelChanges++; return initialState; };
				window.pi[method] = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
				const changing = findComponent(tree, "Sidebar").props[callback](target);
				assert.equal(findComponent(render(), "Composer").props.disabled, scenario !== "inflight-other");
				if (scenario === "inflight-other") {
					await findComponent(tree, "Composer").props.onSend("Continue in A", []);
				} else {
					await assert.rejects(findComponent(tree, "Composer").props.onSend("Must not send", []), /being deleted or archived/);
					await findComponent(tree, "TaskPanel").props.onSetModel("anthropic", "fixture");
					await findComponent(tree, "TaskPanel").props.onSetThinking("high");
					assert.equal(sends, 0);
					assert.equal(modelChanges, 0);
					assert.match(JSON.stringify(render()), /Updating conversation history/);
				}
				if (scenario === "inflight-newer") {
					await findComponent(tree, "Sidebar").props.onNewInFolder("/B");
					tree = render();
					assert.equal(findComponent(tree, "Composer").props.disabled, false);
					await findComponent(tree, "Composer").props.onSend("Continue in B", []);
				} else if (scenario !== "inflight-other") {
					window.pi.getActiveState = async () => null;
				}
				if (scenario === "inflight-failure") fail(new Error("fixture inflight deletion failure"));
				else finish();
				await changing;
				if (scenario === "inflight-failure") assert.match(JSON.stringify(render()), /fixture inflight deletion failure/);
			} else if (scenario === "newer-navigation") {
				let finishDeletion;
				window.pi.deleteFolder = () => new Promise((resolve) => { finishDeletion = resolve; });
				const deleting = findComponent(tree, "Sidebar").props.onDeleteFolder(folder);
				await findComponent(tree, "Sidebar").props.onNewInFolder("/B");
				finishDeletion();
				await deleting;
			} else if (scenario === "pending-navigation") {
				let finishNavigation;
				window.pi.newSession = () => new Promise((resolve) => { finishNavigation = resolve; });
				const navigating = findComponent(tree, "Sidebar").props.onNewInFolder("/B");
				await findComponent(tree, "Sidebar").props.onDeleteFolder(folder);
				finishNavigation({ state: nextState, messages: nextMessages });
				await navigating;
			} else if (scenario.includes("failure")) {
				const method = scenario === "archive-failure" ? "archiveSession" : scenario === "delete-failure" ? "deleteSession" : "deleteFolder";
				const callback = scenario === "archive-failure" ? "onArchiveSession" : scenario === "delete-failure" ? "onDeleteSession" : "onDeleteFolder";
				const target = method === "deleteFolder" ? folder : { path: initialState.sessionFile, name: "Old conversation" };
				window.pi.getActiveState = async () => null;
				window.pi[method] = async () => { throw new Error("fixture deletion failure"); };
				if (scenario === "failure-metadata") window.pi.listModels = async () => { throw new Error("fixture model list failure"); };
				if (scenario === "failure-newer-navigation") {
					let failDeletion;
					window.pi[method] = () => new Promise((_resolve, reject) => { failDeletion = reject; });
					const deleting = findComponent(tree, "Sidebar").props[callback](target);
					await findComponent(tree, "Sidebar").props.onNewInFolder("/B");
					failDeletion(new Error("fixture deletion failure"));
					await deleting;
				} else if (scenario === "failure-pending-navigation") {
					let finishNavigation;
					window.pi.newSession = () => new Promise((resolve) => { finishNavigation = resolve; });
					const navigating = findComponent(tree, "Sidebar").props.onNewInFolder("/B");
					await findComponent(tree, "Sidebar").props[callback](target);
					finishNavigation({ state: nextState, messages: nextMessages });
					await navigating;
				} else {
					await findComponent(tree, "Sidebar").props[callback](target);
				}
				assert.match(JSON.stringify(render()), /fixture deletion failure/);
				if (scenario === "failure-metadata") assert.match(JSON.stringify(render()), /fixture model list failure/);
			} else {
				await findComponent(tree, "Sidebar").props.onDeleteFolder(folder);
			}
			tree = render();
			if (["current", "failure", "archive-failure", "delete-failure", "failure-metadata", "inflight-delete", "inflight-archive", "inflight-folder", "inflight-unsaved", "inflight-failure"].includes(scenario)) {
				assert.equal(findComponent(tree, "HeaderBar").props.state, null);
				assert.deepEqual(findComponent(tree, "MessageList").props.messages, []);
				assert.deepEqual(findComponent(tree, "TaskPanel").props.tasks, []);
				assert.deepEqual(findComponent(tree, "Composer").props.commands, []);
				assert.equal(findComponent(tree, "Composer").props.disabled, false);
				event({ type: "patch", sessionId: "A", from: 0, messages: [{ role: "user", content: "Stale A" }] });
				assert.deepEqual(findComponent(render(), "MessageList").props.messages, []);
				window.pi.getActiveState = async () => nextState;
				window.pi.sendMessage = async (_text, _images, sessionId) => {
					assert.equal(sessionId, null);
					event({ type: "state", state: nextState });
					event({ type: "patch", sessionId: "B", from: 0, messages: nextMessages });
				};
				await findComponent(tree, "Composer").props.onSend("New conversation", []);
				tree = render();
			}
			const expected = scenario === "other" || scenario === "inflight-other" ? "A" : "B";
			assert.equal(findComponent(tree, "HeaderBar").props.state.sessionId, expected, scenario);
			if (expected === "B") {
				event({ type: "state", state: initialState });
				event({ type: "patch", sessionId: "A", from: 0, messages: [{ role: "user", content: "Stale A" }] });
				tree = render();
				assert.equal(findComponent(tree, "HeaderBar").props.state.sessionId, "B");
				assert.deepEqual(findComponent(tree, "MessageList").props.messages, nextMessages);
			}
		}
		const taskOwner = makeDriver();
		taskOwner.agentDir = join(root, "task-ownership");
		await mkdir(taskOwner.agentDir);
		await writeFile(join(taskOwner.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", cacheWarming: "off" }));
		const saveTask = async (session, title) => {
			const task = { id: "a1", title, status: "open", sourceIndex: 0, createdAt: 0, updatedAt: 0 };
			await mkdir(dirname(session.sessionFile), { recursive: true });
			await writeFile(`${session.sessionFile}.tasks.json`, JSON.stringify({ counter: 1, tasks: [task] }));
			taskOwner.sessionTasks.delete(session);
			return task;
		};
		const stateA = (await taskOwner.newSession(projects[0])).state;
		const taskA = await saveTask(taskOwner.session, "Task A");
		const stateB = (await taskOwner.newSession(projects[1])).state;
		const taskB = await saveTask(taskOwner.session, "Task B");
		const handlers = new Map();
		const { ipcMain } = await jiti.import(shim);
		const originalHandle = ipcMain.handle;
		ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
		try {
			const { registerIpc } = await jiti.import(resolve("src/main/ipc.ts"));
			registerIpc(taskOwner, () => null);
			globalThis.__heipangTaskBridge = {
				exposeInMainWorld: (_name, api) => { globalThis.window = { pi: api }; },
				invoke: async (channel, ...args) => handlers.get(channel)({}, ...args),
			};
			const preload = await build({
				entryPoints: ["src/preload/index.ts"], bundle: true, platform: "node", format: "cjs", write: false,
				plugins: [{ name: "task-bridge", setup(builder) {
					builder.onResolve({ filter: /^electron$/ }, args => ({ path: args.path, namespace: "task-bridge" }));
					builder.onLoad({ filter: /.*/, namespace: "task-bridge" }, () => ({ contents: `
export const contextBridge = globalThis.__heipangTaskBridge;
export const ipcRenderer = { invoke: (...args) => globalThis.__heipangTaskBridge.invoke(...args), on() {}, removeListener() {}, send() {} };
` }));
				} }],
			});
			const preloadPath = join(root, "task-preload.cjs");
			await writeFile(preloadPath, preload.outputFiles[0].text);
			createRequire(import.meta.url)(preloadPath);
			const api = window.pi;
			const taskPathB = `${taskOwner.session.sessionFile}.tasks.json`;
			const savedB = await readFile(taskPathB, "utf8");
			await assert.rejects(api.updateTask({ ...taskA, status: "done" }, stateA.sessionId), /selected session has changed/);
			await assert.rejects(api.deleteTask("a1", stateA.sessionId), /selected session has changed/);
			await assert.rejects(api.extractTasks(stateA.sessionId), /selected session has changed/);
			await assert.rejects(api.deleteTask("a1"), /selected session has changed/);
			assert.equal(await readFile(taskPathB, "utf8"), savedB);
			assert.equal((await api.updateTask({ ...taskB, title: "Edited B" }, stateB.sessionId))[0].title, "Edited B");
			await api.deleteTask("a1", stateB.sessionId);
			assert.deepEqual(JSON.parse(await readFile(taskPathB, "utf8")).tasks, []);
			await saveTask(taskOwner.session, "Task B");
			let resumeModels;
			const modelsGate = new Promise(resolve => { resumeModels = resolve; });
			window.pi = { ...api, listModels: () => modelsGate, getUsage: async () => null };
			rendererHooks.states = [null, stateA, [], [], [taskA], [], null];
			rendererHooks.refs = [];
			const oldPanel = findComponent(render(), "TaskPanel");
			const opening = findComponent(render(), "Sidebar").props.onOpen({ path: stateB.sessionFile });
			await new Promise(setImmediate);
			const loadingPanel = findComponent(render(), "TaskPanel");
			assert.equal(loadingPanel.props.state.sessionId, stateB.sessionId);
			assert.deepEqual(loadingPanel.props.tasks, []);
			assert.equal(loadingPanel.props.disabled, true);
			await oldPanel.props.onUpdate({ ...taskA, title: "Wrong owner", status: "done" });
			await oldPanel.props.onDelete("a1");
			await oldPanel.props.onExtract();
			assert.equal(taskOwner.getTasks()[0].title, "Task B");
			assert.equal(taskOwner.getTasks()[0].status, "open");
			assert.match(JSON.stringify(render()), /selected session has changed/);
			resumeModels({ all: [], available: [], enabled: [] });
			await opening;
			const readyPanel = findComponent(render(), "TaskPanel");
			assert.equal(readyPanel.props.disabled, false);
			assert.equal(readyPanel.props.tasks[0].title, "Task B");
			let resumeChange;
			let enterChange;
			const changeGate = new Promise(resolve => { resumeChange = resolve; });
			const changeStarted = new Promise(resolve => { enterChange = resolve; });
			window.pi.updateTask = async (...args) => {
				const tasks = await api.updateTask(...args);
				enterChange(); await changeGate;
				return tasks;
			};
			const changing = readyPanel.props.onUpdate({ ...taskB, title: "Saved in B" });
			await changeStarted;
			await findComponent(render(), "Sidebar").props.onNewInFolder(projects[0]);
			const stateC = taskOwner.getActiveState();
			assert.notEqual(stateC.sessionId, stateB.sessionId);
			resumeChange(); await changing;
			assert.equal(findComponent(render(), "TaskPanel").props.state.sessionId, stateC.sessionId);
			assert.deepEqual(findComponent(render(), "TaskPanel").props.tasks, []);
			assert.equal(JSON.parse(await readFile(taskPathB, "utf8")).tasks[0].title, "Saved in B");
			window.pi.deleteTask = async () => { throw new Error("fixture task deletion failure"); };
			await findComponent(render(), "TaskPanel").props.onDelete("a1");
			assert.match(JSON.stringify(render()), /fixture task deletion failure/);
		} finally {
			ipcMain.handle = originalHandle;
			delete globalThis.__heipangTaskBridge;
			await taskOwner.shutdown();
		}
	} finally {
		for (const cleanup of rendererCleanups) cleanup();
		delete globalThis.__heipangRendererTest;
		if (originalWindow === undefined) delete globalThis.window;
		else globalThis.window = originalWindow;
		if (originalConfirm === undefined) delete globalThis.confirm;
		else globalThis.confirm = originalConfirm;
	}

	let finishExtraction;
	const extraction = new Promise((resolve) => { finishExtraction = resolve; });
	const extractionModel = { provider: "test", id: "test" };
	const makeTaskSession = (name, complete) => ({ sessionFile: join(root, `${name}.jsonl`), model: extractionModel,
		messages: [{ role: "user", content: "Please fix the login" }],
		modelRuntime: { getAvailable: async () => [extractionModel], completeSimple: complete } });
	const taskA = new SessionTasks(makeTaskSession("task-A", async () => extraction), () => ({}), () => {}, assert.fail);
	const taskB = new SessionTasks(makeTaskSession("task-B", async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"tasks":["Task B"]}' }] })), () => ({}), () => {}, assert.fail);
	const pending = taskA.extract();
	assert.equal(pending, taskA.extract());
	assert.equal((await taskB.extract()).tasks[0].title, "Task B");
	finishExtraction({ stopReason: "stop", content: [{ type: "text", text: '{"tasks":["Task A"]}' }] });
	assert.equal((await pending).tasks[0].title, "Task A");
	assert.equal(taskB.get()[0].title, "Task B");
	taskA.dispose(); taskB.dispose();

	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "open"), '#!/bin/bash\nexit 0\n', { mode: 0o700 });
	const script = join(root, "install.sh");
	await writeFile(script, MAC_INSTALL_SCRIPT);
	const exec = promisify(execFile);
	await exec("/bin/bash", ["-n", script]);
	for (const failReplacement of [false, true]) {
		const folder = join(root, failReplacement ? "rollback" : "success");
		const app = join(folder, "App with spaces.app");
		const stage = join(folder, "stage");
		await mkdir(app, { recursive: true });
		await mkdir(join(stage, "next.app"), { recursive: true });
		await writeFile(join(app, "version"), "old");
		await writeFile(join(stage, "next.app", "version"), "new");
		if (failReplacement) await writeFile(join(bin, "mv"), '#!/bin/bash\nif [[ "$1" == */next.app ]]; then exit 1; fi\nexec /bin/mv "$@"\n', { mode: 0o700 });
		try {
			await exec("/bin/bash", [script, app, stage, join(root, "update.dmg"), "99999999"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 5000 });
			assert.equal(failReplacement, false);
		} catch (error) {
			if (!failReplacement) throw error;
			assert.equal(error.code, 1);
		}
		assert.equal(await readFile(join(app, "version"), "utf8"), failReplacement ? "old" : "new");
	}
	console.log("PASS: input cancellation and renderer recovery, startup snapshot ownership, project trust, prompt preflight and Stop cancellation, session-owned writes and destructive-operation races, real shutdown callback failures, expected-session sending, OAuth credential settlement and cross-runtime persistence recovery during shutdown, file-owner handoff and navigation ordering, secure model configuration, SDK model overrides, task isolation and expected-session IPC mutations, update shutdown ordering, replacement and rollback");
} finally {
	globalThis.fetch = originalFetch;
	await rm(root, { recursive: true, force: true });
}
