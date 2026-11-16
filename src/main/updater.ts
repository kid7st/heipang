import { app, net, shell } from "electron";
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateCheck } from "../shared/types.js";
import { MAC_INSTALL_SCRIPT, prepareMacUpdate } from "./mac-update.js";

const RELEASES_API = "https://api.github.com/repos/kid7st/heipang/releases?per_page=30";

function tagPrefix(): string {
	const metadata = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
	if (metadata.updateChannel === "meta") return "meta-v";
	if (metadata.updateChannel === "stable") return "v";
	throw new Error("The application has no valid update channel");
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
	const release = releases.find((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(prefix));
	if (!release) throw new Error("No published release was found for this update channel");
	const asset = (extension: string) => release.assets.find((a) => a.name.endsWith(extension))?.browser_download_url;
	return {
		version: release.tag_name.slice(prefix.length),
		notes: release.body ?? undefined,
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
		let body = "";
		req.on("response", (res) => {
			if (res.statusCode && res.statusCode >= 400) {
				reject(new Error(`HTTP ${res.statusCode}`));
				req.abort();
				return;
			}
			res.on("data", (chunk) => (body += chunk.toString()));
			res.on("end", () => resolve(body));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

export async function checkForUpdate(): Promise<UpdateCheck> {
	const current = app.getVersion();
	try {
		const data = latestFromReleases(JSON.parse(await fetchText(RELEASES_API)) as GithubRelease[], tagPrefix());
		const latest = String(data.version || "");
		const url = process.platform === "darwin" ? data.mac : data.win;
		const hasUpdate = !!latest && cmpVer(latest, current) > 0 && !!url;
		return { current, latest, hasUpdate, notes: data.notes, url };
	} catch (error) {
		return { current, hasUpdate: false, error: error instanceof Error ? error.message : String(error) };
	}
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

export async function downloadAndInstall(url: string, emit: Emit, beforeInstall: () => Promise<void>): Promise<void> {
	if (installing) throw new Error("An update is already in progress");
	installing = true;
	let stage: string | undefined;
	let shutdownStarted = false;
	try {
		const dir = mkdtempSync(join(tmpdir(), "heipang-up-"));
		emit("download", 0);
		if (process.platform === "darwin") {
			const dmg = join(dir, "update.dmg");
			await download(url, dmg, (pct) => emit("download", pct));
			emit("install");
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
			const exe = join(dir, "Setup.exe");
			await download(url, exe, (pct) => emit("download", pct));
			emit("install");
			shutdownStarted = true;
			await beforeInstall();
			await launchInstaller(exe, ["/S", "--force-run"], join(dir, "install.log"));
		} else {
			throw new Error("Automatic updates are supported on macOS and Windows only");
		}
		emit("relaunch");
		setTimeout(() => app.quit(), 700);
	} catch (error) {
		let failure = error;
		try { if (stage) await rm(stage, { recursive: true, force: true }); }
		catch (cleanupError) {
			failure = new AggregateError([error, cleanupError], `${String(error)}; update cleanup failed: ${String(cleanupError)}`);
		}
		installing = false;
		const message = failure instanceof Error ? failure.message : String(failure);
		emit("error", undefined, `${message}${shutdownStarted ? ". Restart the application before continuing to work." : ""}`);
	}
}
