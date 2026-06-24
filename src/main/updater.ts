import { app, net } from "electron";
import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UpdateCheck } from "../shared/types.js";

// Public release feed. Source code stays in the private repo; only installers
// + these small JSON files live in the public `heipang-releases` repo, so the
// app can fetch updates anonymously (no embedded token).
const RELEASE_FEED_BASE = "https://raw.githubusercontent.com/kuaai/heipang-releases/main";

function latestUrl(): string {
	return app.getName() === "SI-YOU-XIN-REN" ? `${RELEASE_FEED_BASE}/si-latest.json` : `${RELEASE_FEED_BASE}/latest.json`;
}

interface RemoteLatest {
	version: string;
	notes?: string;
	mac?: string;
	win?: string;
}

// 0.1.2 > 0.1.10? handled numerically per dotted/dashed segment.
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
				return;
			}
			res.on("data", (c) => (body += c.toString()));
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
		const data = JSON.parse(await fetchText(`${latestUrl()}?t=${Date.now()}`)) as RemoteLatest;
		const latest = String(data.version || "");
		const url = process.platform === "darwin" ? data.mac : data.win;
		const hasUpdate = !!latest && cmpVer(latest, current) > 0 && !!url;
		return { current, latest, hasUpdate, notes: data.notes, url };
	} catch (e: any) {
		return { current, hasUpdate: false, error: e?.message || "check failed" };
	}
}

function download(url: string, dest: string, onPct: (pct: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = net.request({ url, redirect: "follow" });
		req.on("response", (res) => {
			if (res.statusCode && res.statusCode >= 400) {
				reject(new Error(`HTTP ${res.statusCode}`));
				return;
			}
			const total = parseInt((res.headers["content-length"] as string) || "0", 10);
			let got = 0;
			let last = 0;
			const out = createWriteStream(dest);
			res.on("data", (chunk: Buffer) => {
				got += chunk.length;
				out.write(chunk);
				if (total) {
					const pct = Math.min(99, Math.round((got / total) * 100));
					if (pct !== last) {
						last = pct;
						onPct(pct);
					}
				}
			});
			res.on("end", () => out.end(() => resolve()));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

export type UpdatePhase = "download" | "install" | "relaunch" | "error";
type Emit = (phase: UpdatePhase, pct?: number, message?: string) => void;

export async function downloadAndInstall(url: string, emit: Emit): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "heipang-up-"));
	try {
		emit("download", 0);
		if (process.platform === "darwin") {
			const dmg = join(dir, `${app.getName()}-update.dmg`);
			await download(url, dmg, (p) => emit("download", p));
			emit("install");
			// /Applications/AppName.app/Contents/MacOS/AppName -> /Applications/AppName.app
			const appPath = `${process.execPath.split(".app/")[0]}.app`;
			const script = join(dir, "install.sh");
			writeFileSync(
				script,
				`#!/bin/bash
DMG=${JSON.stringify(dmg)}
APP=${JSON.stringify(appPath)}
sleep 1
for i in $(seq 1 40); do
  pgrep -f "$APP/Contents/MacOS/" >/dev/null || break
  sleep 1
done
MNT="$(mktemp -d)"
if hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" -quiet; then
  SRC="$(/bin/ls -d "$MNT"/*.app 2>/dev/null | head -1)"
  if [ -n "$SRC" ] && rm -rf "$APP" && cp -R "$SRC" "$(dirname "$APP")/"; then
    hdiutil detach "$MNT" -quiet || true
    xattr -cr "$APP" 2>/dev/null || true
    open "$APP"
    exit 0
  fi
  hdiutil detach "$MNT" -quiet || true
fi
# fallback: couldn't replace in place (permissions) -> open the dmg for manual drag
open "$DMG"
`,
			);
			chmodSync(script, 0o755);
			spawn("/bin/bash", [script], { detached: true, stdio: "ignore" }).unref();
			emit("relaunch");
			setTimeout(() => app.quit(), 700);
			return;
		}

		// Windows: NSIS silent update. electron-builder's installer relaunches the
		// app automatically after a `/S` silent install.
		const exe = join(dir, "HEIPANG-Setup.exe");
		await download(url, exe, (p) => emit("download", p));
		emit("install");
		spawn(exe, ["/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
		emit("relaunch");
		setTimeout(() => app.quit(), 700);
	} catch (e: any) {
		emit("error", undefined, e?.message || "update failed");
	}
}
