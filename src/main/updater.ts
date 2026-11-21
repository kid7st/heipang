import { app, net, shell } from "electron";
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuiSettings, UpdateCheck, UpdateState } from "../shared/types.js";
import { MAC_INSTALL_SCRIPT, prepareMacUpdate } from "./mac-update.js";

const RELEASES_API = "https://api.github.com/repos/kid7st/heipang/releases?per_page=30";
const CHECK_TIMEOUT_MS = 15_000;
const STARTUP_CHECK_DELAY_MS = 4_000;
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function readChannel(): "stable" | "meta" {
	const metadata = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
	if (metadata.updateChannel === "meta") return "meta";
	if (metadata.updateChannel === "stable") return "stable";
	throw new Error("The application has no valid update channel");
}

function tagPrefix(channel: "stable" | "meta"): string {
	return channel === "meta" ? "meta-v" : "v";
}

interface GithubRelease {
	tag_name: string;
	body?: string | null;
	draft: boolean;
	prerelease: boolean;
	assets: { name: string; browser_download_url: string }[];
}

interface RemoteLatest {
	version: string;
	notes?: string;
	mac?: string;
	win?: string;
}

function latestFromReleases(releases: GithubRelease[], prefix: string): RemoteLatest {
	let best: { release: GithubRelease; version: string } | undefined;
	for (const release of releases) {
		if (release.draft || release.prerelease || !release.tag_name.startsWith(prefix)) continue;
		const version = release.tag_name.slice(prefix.length);
		if (!best || cmpVer(version, best.version) > 0) {
			best = { release, version };
		}
	}
	if (!best) throw new Error("No published release was found for this update channel");
	const asset = (extension: string) => best.release.assets.find((a) => a.name.endsWith(extension))?.browser_download_url;
	return {
		version: best.version,
		notes: best.release.body ?? undefined,
		mac: asset(".dmg"),
		win: asset(".exe"),
	};
}

function cmpVer(a: string, b: string): number {
	const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
	const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d) return d > 0 ? 1 : -1;
	}
	return 0;
}

function fetchText(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = net.request({ url, redirect: "follow", cache: "no-cache" });
		req.setHeader("Cache-Control", "no-cache");
		req.setHeader("Accept", "application/vnd.github+json");
		req.setHeader("User-Agent", `heipang/${app.getVersion()}`);
		let body = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			req.abort();
			reject(new Error("Update check timed out"));
		}, CHECK_TIMEOUT_MS);
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		req.on("response", (res) => {
			if (res.statusCode && res.statusCode >= 400) {
				req.abort();
				done(() => reject(new Error(`HTTP ${res.statusCode}`)));
				return;
			}
			res.on("data", (chunk) => (body += chunk.toString()));
			res.on("end", () => done(() => resolve(body)));
			res.on("error", (error) => done(() => reject(error)));
		});
		req.on("error", (error) => done(() => reject(error)));
		req.end();
	});
}

export function download(url: string, dest: string, onPct: (pct: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = net.request({ url, redirect: "follow" });
		let out: ReturnType<typeof createWriteStream> | undefined;
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			reject(error);
			out?.destroy();
			req.abort();
		};
		req.on("response", (res) => {
			if (res.statusCode && res.statusCode >= 400) {
				fail(new Error(`HTTP ${res.statusCode}`));
				return;
			}
			const total = Number(res.headers["content-length"]) || 0;
			let got = 0;
			let last = 0;
			out = createWriteStream(dest);
			out.on("error", fail);
			out.on("finish", () => {
				if (settled) return;
				settled = true;
				resolve();
			});
			res.on("data", (chunk: Buffer) => {
				got += chunk.length;
				out!.write(chunk);
				if (total) {
					const pct = Math.min(99, Math.round((got / total) * 100));
					if (pct !== last) { last = pct; onPct(pct); }
				}
			});
			res.on("end", () => {
				if (total && got !== total) fail(new Error("The installer download was incomplete"));
				else out!.end();
			});
			res.on("aborted", () => fail(new Error("The installer download was interrupted")));
			res.on("error", fail);
		});
		req.on("error", fail);
		req.end();
	});
}

async function launchInstaller(command: string, args: string[], logPath: string): Promise<void> {
	const log = openSync(logPath, "a", 0o600);
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(command, args, { detached: true, stdio: ["ignore", log, log] });
			child.once("error", reject);
			child.once("spawn", () => { child.unref(); resolve(); });
		});
	} finally { closeSync(log); }
}

export type UpdatePhase = "download" | "install" | "relaunch" | "error";
type Emit = (phase: UpdatePhase, pct?: number, message?: string) => void;

let installing = false;
let downloading = false;
let downloadPromise: Promise<void> | undefined;
let inFlightCheck: Promise<UpdateCheck> | undefined;
let downloadedArtifact: { url: string; filePath: string; dir: string } | undefined;
let updateState: UpdateState | undefined;
const stateListeners = new Set<(state: UpdateState) => void>();
let schedulerSettings: (() => GuiSettings) | undefined;
let periodicTimer: ReturnType<typeof setInterval> | undefined;

function ensureState(): UpdateState {
	if (!updateState) {
		let channel: "stable" | "meta" | undefined;
		try { channel = readChannel(); } catch { /* ignore */ }
		updateState = { status: "idle", current: app.getVersion(), channel };
	}
	return updateState;
}

function setUpdateState(next: UpdateState): UpdateState {
	updateState = next;
	for (const listener of stateListeners) {
		try { listener(next); } catch { /* ignore */ }
	}
	return next;
}

export function getUpdateState(): UpdateState {
	return ensureState();
}

export function cleanupDownloadedUpdate(): void {
	if (installing || !downloadedArtifact) return;
	const { dir } = downloadedArtifact;
	downloadedArtifact = undefined;
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function installerFilename(): string {
	if (process.platform === "darwin") return "update.dmg";
	if (process.platform === "win32") return "Setup.exe";
	throw new Error("Automatic updates are supported on macOS and Windows only");
}

function maybeStartAutoDownload(state: UpdateState): void {
	const settings = schedulerSettings?.();
	if (!settings?.autoDownloadUpdates) return;
	if (state.status !== "available" || !state.url || !state.latest) return;
	if (settings.skippedUpdateVersion === state.latest) return;
	void downloadUpdate(state.url, { background: true, latest: state.latest, notes: state.notes });
}

export async function checkForUpdate(options?: { background?: boolean }): Promise<UpdateCheck> {
	const background = !!options?.background;
	const current = app.getVersion();
	const prev = ensureState();

	if (prev.status === "downloading" || prev.status === "installing") {
		return {
			current,
			latest: prev.latest,
			hasUpdate: !!prev.latest && cmpVer(prev.latest, current) > 0 && !!prev.url,
			notes: prev.notes,
			url: prev.url,
		};
	}

	if (inFlightCheck) return inFlightCheck;

	const run = (async (): Promise<UpdateCheck> => {
		let channel: "stable" | "meta" | undefined = prev.channel;
		if (!background) {
			setUpdateState({ ...prev, current, status: "checking", error: undefined, manual: true });
		}
		try {
			channel = readChannel();
			const data = latestFromReleases(JSON.parse(await fetchText(RELEASES_API)) as GithubRelease[], tagPrefix(channel));
			const latest = String(data.version || "");
			const url = process.platform === "darwin" ? data.mac : data.win;
			const hasUpdate = !!latest && cmpVer(latest, current) > 0 && !!url;
			const checkedAt = Date.now();

			if (hasUpdate && url) {
				const alreadyDownloaded = downloadedArtifact?.url === url && existsSync(downloadedArtifact.filePath);
				const next = setUpdateState({
					status: alreadyDownloaded ? "downloaded" : "available",
					current,
					channel,
					latest,
					notes: data.notes,
					url,
					pct: alreadyDownloaded ? 100 : undefined,
					checkedAt,
					manual: !background,
				});
				maybeStartAutoDownload(next);
			} else {
				cleanupDownloadedUpdate();
				setUpdateState({
					status: "not-available",
					current,
					channel,
					latest: latest || undefined,
					notes: data.notes,
					checkedAt,
					manual: !background,
				});
			}
			return { current, latest, hasUpdate, notes: data.notes, url };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!background) {
				setUpdateState({
					...ensureState(),
					current,
					channel,
					status: "error",
					error: message,
					checkedAt: Date.now(),
					manual: true,
				});
			}
			return { current, hasUpdate: false, error: message };
		} finally {
			inFlightCheck = undefined;
		}
	})();

	inFlightCheck = run;
	return run;
}

export async function downloadUpdate(
	url: string,
	options?: { background?: boolean; latest?: string; notes?: string },
): Promise<void> {
	if (installing) return;
	if (downloading) return downloadPromise;
	if (downloadedArtifact?.url === url && existsSync(downloadedArtifact.filePath)) {
		const prev = ensureState();
		setUpdateState({
			...prev,
			status: "downloaded",
			url,
			latest: options?.latest ?? prev.latest,
			notes: options?.notes ?? prev.notes,
			pct: 100,
			error: undefined,
		});
		return;
	}

	downloading = true;
	const background = !!options?.background;
	const prev = ensureState();
	const latest = options?.latest ?? prev.latest;
	const notes = options?.notes ?? prev.notes;
	let dir: string | undefined;

	downloadPromise = (async () => {
		try {
			cleanupDownloadedUpdate();
			const filename = installerFilename();
			dir = mkdtempSync(join(tmpdir(), "heipang-up-"));
			const filePath = join(dir, filename);
			setUpdateState({
				...prev,
				status: "downloading",
				latest,
				notes,
				url,
				pct: 0,
				error: undefined,
				manual: !background,
			});
			await download(url, filePath, (pct) => {
				setUpdateState({
					...ensureState(),
					status: "downloading",
					latest,
					notes,
					url,
					pct,
					error: undefined,
				});
			});
			downloadedArtifact = { url, filePath, dir };
			setUpdateState({
				...ensureState(),
				status: "downloaded",
				latest,
				notes,
				url,
				pct: 100,
				error: undefined,
				manual: !background,
			});
		} catch (error) {
			if (dir) {
				try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
			const message = error instanceof Error ? error.message : String(error);
			if (background) {
				// Revert silently to "available" so the user can still trigger download manually.
				setUpdateState({
					...ensureState(),
					status: "available",
					latest,
					notes,
					url,
					pct: undefined,
					error: undefined,
					manual: false,
				});
			} else {
				setUpdateState({
					...ensureState(),
					status: "error",
					latest,
					notes,
					url,
					pct: undefined,
					error: message,
					manual: true,
				});
				throw error;
			}
		} finally {
			downloading = false;
			downloadPromise = undefined;
		}
	})();
	return downloadPromise;
}

export async function downloadAndInstall(url: string, emit: Emit, beforeInstall: () => Promise<void>): Promise<void> {
	if (installing) throw new Error("An update is already in progress");
	installing = true;
	let stage: string | undefined;
	let shutdownStarted = false;
	let tempDir: string | undefined;
	try {
		if (downloadPromise) await downloadPromise.catch(() => {});
		const cached = downloadedArtifact?.url === url && existsSync(downloadedArtifact.filePath)
			? downloadedArtifact
			: undefined;
		const dir = cached?.dir ?? mkdtempSync(join(tmpdir(), "heipang-up-"));
		if (!cached) tempDir = dir;

		const prev = ensureState();
		if (process.platform === "darwin") {
			const dmg = cached?.filePath ?? join(dir, "update.dmg");
			if (!cached) {
				emit("download", 0);
				setUpdateState({ ...prev, status: "downloading", url, pct: 0, error: undefined, manual: true });
				await download(url, dmg, (pct) => {
					emit("download", pct);
					setUpdateState({ ...ensureState(), status: "downloading", url, pct, error: undefined, manual: true });
				});
			}
			emit("install");
			setUpdateState({ ...ensureState(), status: "installing", url, pct: 100, error: undefined, manual: true });
			const boundary = process.execPath.indexOf(".app/");
			if (boundary < 0) throw new Error("Install the application before using automatic updates");
			const appPath = process.execPath.slice(0, boundary + 4);
			try {
				stage = await prepareMacUpdate(dmg, appPath);
			} catch (error) {
				const openError = await shell.openPath(dmg);
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`${reason}. ${openError ? `Could not open the manual installer: ${openError}` : "The installer has been opened for a manual update."}`);
			}
			const script = join(dir, "install.sh");
			writeFileSync(script, MAC_INSTALL_SCRIPT, { mode: 0o700 });
			shutdownStarted = true;
			await beforeInstall();
			await launchInstaller("/bin/bash", [script, appPath, stage, dmg, String(process.pid)], join(dir, "install.log"));
		} else if (process.platform === "win32") {
			const exe = cached?.filePath ?? join(dir, "Setup.exe");
			if (!cached) {
				emit("download", 0);
				setUpdateState({ ...prev, status: "downloading", url, pct: 0, error: undefined, manual: true });
				await download(url, exe, (pct) => {
					emit("download", pct);
					setUpdateState({ ...ensureState(), status: "downloading", url, pct, error: undefined, manual: true });
				});
			}
			emit("install");
			setUpdateState({ ...ensureState(), status: "installing", url, pct: 100, error: undefined, manual: true });
			shutdownStarted = true;
			await beforeInstall();
			await launchInstaller(exe, ["/S", "--force-run"], join(dir, "install.log"));
		} else {
			throw new Error("Automatic updates are supported on macOS and Windows only");
		}
		downloadedArtifact = undefined;
		emit("relaunch");
		setTimeout(() => app.quit(), 700);
	} catch (error) {
		let failure = error;
		try { if (stage) await rm(stage, { recursive: true, force: true }); }
		catch (cleanupError) {
			failure = new AggregateError([error, cleanupError], `${String(error)}; update cleanup failed: ${String(cleanupError)}`);
		}
		if (tempDir) {
			try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
		installing = false;
		const message = failure instanceof Error ? failure.message : String(failure);
		const fullMessage = `${message}${shutdownStarted ? ". Restart the application before continuing to work." : ""}`;
		setUpdateState({ ...ensureState(), status: "error", error: fullMessage, manual: true });
		emit("error", undefined, fullMessage);
	}
}

export function startAutoUpdateScheduler(options: {
	getSettings: () => GuiSettings;
	onStateChange: (state: UpdateState) => void;
}): () => void {
	schedulerSettings = options.getSettings;
	stateListeners.add(options.onStateChange);

	const runBackgroundCheck = () => {
		if (!schedulerSettings?.().autoCheckUpdates) return;
		void checkForUpdate({ background: true });
	};

	const startupTimer = setTimeout(runBackgroundCheck, STARTUP_CHECK_DELAY_MS);
	startupTimer.unref();

	if (!periodicTimer) {
		periodicTimer = setInterval(runBackgroundCheck, PERIODIC_CHECK_INTERVAL_MS);
		periodicTimer.unref();
	}

	if (typeof app.once === "function") {
		app.once("will-quit", cleanupDownloadedUpdate);
	}

	return () => {
		stateListeners.delete(options.onStateChange);
	};
}

export function syncAutoUpdateSettings(settings: GuiSettings): void {
	if (!schedulerSettings) return;
	const state = ensureState();
	if (settings.autoDownloadUpdates && state.status === "available") {
		maybeStartAutoDownload(state);
	}
}
