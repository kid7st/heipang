import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "heipang-updater-test-"));

try {
	await writeFile(join(root, "package.json"), JSON.stringify({ updateChannel: "meta" }));

	const updaterBundle = await build({
		stdin: {
			contents: 'export * from "./src/main/updater.ts"; export { registerIpc } from "./src/main/ipc.ts";',
			resolveDir: process.cwd(),
		},
		bundle: true,
		platform: "node",
		format: "cjs",
		write: false,
		define: { "process.platform": '"win32"', setTimeout: "globalThis.__heipangUpdaterHooks.schedule" },
		plugins: [{
			name: "updater-fixtures",
			setup(builder) {
				builder.onResolve({ filter: /^electron$|^node:(child_process|os)$|^\.\/mac-update\.js$/ }, (args) => ({
					path: args.path,
					namespace: "updater-fixture",
				}));
				builder.onLoad({ filter: /.*/, namespace: "updater-fixture" }, (args) => {
					if (args.path === "electron") {
						return {
							contents: "export const { app, net, shell, ipcMain, dialog, Notification } = globalThis.__heipangUpdaterHooks;",
						};
					}
					if (args.path === "node:os") {
						return { contents: "export const tmpdir = () => globalThis.__heipangUpdaterHooks.root; export const homedir = tmpdir;" };
					}
					if (args.path === "node:child_process") {
						return { contents: "export const spawn = (...args) => globalThis.__heipangUpdaterHooks.spawn(...args);" };
					}
					return { contents: 'export const MAC_INSTALL_SCRIPT = ""; export const prepareMacUpdate = () => { throw new Error("Unexpected macOS update"); };' };
				});
			},
		}],
	});

	const release = (tag, body = `Notes for ${tag}`, overrides = {}) => ({
		tag_name: tag,
		body,
		draft: false,
		prerelease: false,
		assets: [
			{ name: "HEIPANG-Meta-arm64.dmg", browser_download_url: `https://example.test/${tag}/mac` },
			{ name: "HEIPANG-Meta-Setup.exe", browser_download_url: `https://example.test/${tag}/win` },
		],
		...overrides,
	});

	const loadBundle = async (name, hooks) => {
		globalThis.__heipangUpdaterHooks = hooks;
		const entry = join(root, `${name}.cjs`);
		await writeFile(entry, updaterBundle.outputFiles[0].text);
		return createRequire(import.meta.url)(entry);
	};

	const makeRequestTransport = (responder) => ({
		urls: [],
		request(options) {
			this.urls.push(options.url);
			const req = new EventEmitter();
			req.setHeader = () => {};
			req.abort = () => {};
			req.end = () => queueMicrotask(() => responder(options.url, req));
			return req;
		},
	});

	// 1. Semver selection, silent background failure vs manual failure, auto-download, and skip guard.
	{
		const states = [];
		const settings = { autoCheckUpdates: true, autoDownloadUpdates: false, skippedUpdateVersion: undefined };
		let mode = "error";
		const transport = makeRequestTransport((url, req) => {
			const res = new EventEmitter();
			if (mode === "error") {
				res.statusCode = 503;
				res.headers = {};
				req.emit("response", res);
				return;
			}
			if (url.includes("/releases")) {
				res.statusCode = 200;
				const body = JSON.stringify([
					release("meta-v0.4.15", "Older release"),
					release("meta-v0.4.18", "Newest release"),
					release("meta-v0.4.17", "Middle release"),
					release("v0.9.0", "Wrong channel"),
					release("meta-v0.9.9", "Draft release", { draft: true }),
				]);
				res.headers = { "content-length": String(Buffer.byteLength(body)) };
				req.emit("response", res);
				res.emit("data", Buffer.from(body));
				res.emit("end");
				return;
			}
			res.statusCode = 200;
			res.headers = { "content-length": "9" };
			req.emit("response", res);
			res.emit("data", Buffer.from("installer"));
			res.emit("end");
		});

		const scheduled = [];
		const mod = await loadBundle("states", {
			root,
			dialog: {},
			shell: {},
			Notification: class {},
			ipcMain: { handle() {}, on() {} },
			app: { getAppPath: () => root, getVersion: () => "0.4.16", once() {}, quit() {} },
			net: transport,
			spawn: () => assert.fail("Unexpected installer spawn"),
			schedule: (fn, ms) => {
				const t = { fn, ms, unref() {} };
				scheduled.push(t);
				return t;
			},
		});

		const stop = mod.startAutoUpdateScheduler({
			getSettings: () => settings,
			onStateChange: (s) => states.push(s),
		});

		// Background check error stays silent and keeps idle state.
		const bgFail = await mod.checkForUpdate({ background: true });
		assert.equal(bgFail.hasUpdate, false);
		assert.match(bgFail.error, /HTTP 503/);
		assert.equal(mod.getUpdateState().status, "idle");

		// Manual check failure sets error state with manual=true.
		const manualFail = await mod.checkForUpdate();
		assert.equal(manualFail.hasUpdate, false);
		assert.equal(mod.getUpdateState().status, "error");
		assert.equal(mod.getUpdateState().manual, true);

		// Highest semver (0.4.18) is picked even when listed after 0.4.15.
		mode = "ok";
		const found = await mod.checkForUpdate({ background: true });
		assert.equal(found.hasUpdate, true);
		assert.equal(found.latest, "0.4.18");
		assert.equal(mod.getUpdateState().status, "available");

		// If skippedUpdateVersion matches, enabling autoDownloadUpdates does not download it.
		settings.skippedUpdateVersion = "0.4.18";
		settings.autoDownloadUpdates = true;
		mod.syncAutoUpdateSettings(settings);
		await new Promise((r) => setImmediate(r));
		assert.equal(mod.getUpdateState().status, "available");

		// Clearing skip triggers automatic background download to "downloaded".
		settings.skippedUpdateVersion = undefined;
		mod.syncAutoUpdateSettings(settings);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(mod.getUpdateState().status, "downloaded");
		assert.equal(mod.getUpdateState().pct, 100);
		assert.ok(states.some((s) => s.status === "downloading"));
		assert.equal(states.at(-1).status, "downloaded");

		stop();
	}

	// 2. Artifact reuse during installUpdate (downloaded in background -> restart & update skips re-download).
	{
		const events = [];
		const handlers = new Map();
		const settings = { autoCheckUpdates: true, autoDownloadUpdates: true };
		let quit;
		let installerRequests = 0;
		let shutdownCalls = 0;

		const transport = makeRequestTransport((url, req) => {
			const res = new EventEmitter();
			if (url.includes("/releases")) {
				res.statusCode = 200;
				const body = JSON.stringify([release("meta-v0.4.19", "Ready update")]);
				res.headers = { "content-length": String(Buffer.byteLength(body)) };
				req.emit("response", res);
				res.emit("data", Buffer.from(body));
				res.emit("end");
				return;
			}
			installerRequests++;
			res.statusCode = 200;
			res.headers = { "content-length": "9" };
			req.emit("response", res);
			res.emit("data", Buffer.from("installer"));
			res.emit("end");
		});

		const mod = await loadBundle("reuse", {
			root,
			dialog: {},
			shell: {},
			Notification: class {},
			ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} },
			app: { getAppPath: () => root, getVersion: () => "0.4.16", once() {}, quit: () => events.push("quit") },
			net: transport,
			schedule: (fn, ms) => {
				if (ms === 700) quit = fn;
				return { unref() {} };
			},
			spawn: (cmd, args) => {
				assert.equal(cmd.endsWith("Setup.exe"), true);
				assert.deepEqual(args, ["/S", "--force-run"]);
				events.push("spawned");
				const child = new EventEmitter();
				child.unref = () => {};
				queueMicrotask(() => child.emit("spawn"));
				return child;
			},
		});

		mod.registerIpc(
			{
				setHandlers() {},
				getGuiSettings: () => settings,
				setGuiSettings: (p) => Object.assign(settings, p),
				shutdown: async () => {
					shutdownCalls++;
					events.push("shutdown");
				},
			},
			() => ({ isDestroyed: () => false, webContents: { send: (_ch, ev) => events.push(ev) } }),
		);

		const check = await handlers.get("pi:checkForUpdate")({}, { background: true });
		assert.equal(check.latest, "0.4.19");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(installerRequests, 1);
		assert.equal(mod.getUpdateState().status, "downloaded");

		// Installing the already-downloaded URL must not re-download the installer.
		await handlers.get("pi:installUpdate")({}, check.url);
		assert.equal(installerRequests, 1);
		assert.equal(shutdownCalls, 1);
		assert.ok(events.includes("shutdown"));
		assert.ok(events.includes("spawned"));
		assert.equal(events.at(-1).phase, "relaunch");
		quit();
		assert.equal(events.at(-1), "quit");
	}

	// 3. Renderer component check (UpdateBanner & UpdateNotesModal compile and render expected actions).
	{
		const uiBundle = await build({
			entryPoints: [resolve("src/renderer/src/components/UpdatePrompt.tsx")],
			bundle: true,
			platform: "node",
			format: "cjs",
			write: false,
			jsx: "automatic",
			plugins: [{
				name: "ui-fixtures",
				setup(builder) {
					builder.onResolve({ filter: /^react|^react-markdown|^remark-gfm|\.\/Markdown\.js$|\.\/Markdown$/ }, (args) => ({
						path: args.path,
						namespace: "ui-fixture",
					}));
					builder.onLoad({ filter: /.*/, namespace: "ui-fixture" }, (args) => {
						if (args.path === "react/jsx-runtime") {
							return { contents: "export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;" };
						}
						if (args.path.includes("Markdown")) {
							return { contents: 'export const Markdown = ({ text }) => ({ type: "markdown", props: { text } });' };
						}
						return { contents: "export const memo = (x) => x;" };
					});
				},
			}],
		});
		const uiPath = join(root, "update-prompt.cjs");
		await writeFile(uiPath, uiBundle.outputFiles[0].text);
		const { UpdateBanner, UpdateNotesModal } = createRequire(import.meta.url)(uiPath);

		assert.equal(UpdateBanner({ updateState: null, dismissed: false }), null);
		assert.equal(UpdateBanner({ updateState: { status: "available", current: "0.4.16", latest: "0.4.17", url: "u" }, dismissed: true }), null);
		assert.equal(
			UpdateBanner({
				updateState: { status: "available", current: "0.4.16", latest: "0.4.17", url: "u" },
				dismissed: false,
				skippedVersion: "0.4.17",
			}),
			null,
		);

		const readyText = JSON.stringify(
			UpdateBanner({
				updateState: { status: "downloaded", current: "0.4.16", latest: "0.4.17", url: "u", notes: "## Fixes" },
				dismissed: false,
			}),
		);
		assert.match(readyText, /Restart & update/);
		assert.match(readyText, /Release notes/);

		const modalText = JSON.stringify(
			UpdateNotesModal({
				updateState: { status: "available", current: "0.4.16", latest: "0.4.17", channel: "meta", url: "u", notes: "## Fixes" },
				onClose() {},
				onInstall() {},
				onSkip() {},
			}),
		);
		assert.match(modalText, /Skip this version/);
		assert.match(modalText, /Download & update/);
		assert.match(modalText, /## Fixes/);
	}

	console.log("PASS: update semver check, silent vs manual error handling, auto-download, skip guard, artifact reuse, and UI prompt rendering");
} finally {
	delete globalThis.__heipangUpdaterHooks;
	await rm(root, { recursive: true, force: true });
}
