import { BrowserWindow, dialog, type BrowserWindow as BW } from "electron";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Self-contained share card (the exact Sort breakdown DOM + page CSS) is built in
// the renderer and handed here. PNG is a true pixel capture via an offscreen
// window; Copy-link uploads the HTML to Cloudflare R2 and returns a public URL.
// R2 credentials live ONLY on disk (~/.pi/agent/meta-vincent/r2.json), never in
// the binary or git, and are read in the main process only.

interface R2Config {
	accountId: string;
	bucket: string;
	endpoint: string; // <account>.r2.cloudflarestorage.com
	region: string; // "auto"
	publicBase: string; // https://pub-xxxx.r2.dev
	accessKeyId: string;
	secretAccessKey: string;
}

function r2ConfigPath(): string {
	return join(homedir(), ".pi", "agent", "meta-vincent", "r2.json");
}

function loadR2(): R2Config | null {
	const p = r2ConfigPath();
	if (!existsSync(p)) return null;
	try {
		const d = JSON.parse(readFileSync(p, "utf8"));
		if (!d.accessKeyId || !d.secretAccessKey || !d.bucket || !d.endpoint) return null;
		return { region: "auto", ...d } as R2Config;
	} catch {
		return null;
	}
}

function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}
function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}
function signingKey(secret: string, dateStamp: string, region: string): Buffer {
	const kDate = hmac(`AWS4${secret}`, dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, "s3");
	return hmac(kService, "aws4_request");
}
function amzNow(): { amzDate: string; dateStamp: string } {
	const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

async function r2Put(cfg: R2Config, key: string, body: Buffer, contentType: string): Promise<void> {
	const host = `${cfg.bucket}.${cfg.endpoint}`;
	const canonicalUri = `/${key.split("/").map((s) => encodeURIComponent(s)).join("/")}`;
	const payloadHash = sha256Hex(body);
	const { amzDate, dateStamp } = amzNow();
	const headers: Record<string, string> = {
		"content-type": contentType,
		host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
	};
	const names = Object.keys(headers).sort();
	const canonicalHeaders = names.map((h) => `${h}:${headers[h]}\n`).join("");
	const signedHeaders = names.join(";");
	const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
	const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
	const signature = hmac(signingKey(cfg.secretAccessKey, dateStamp, cfg.region), stringToSign).toString("hex");
	const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	const res = await fetch(`https://${host}${canonicalUri}`, {
		method: "PUT",
		body: new Uint8Array(body),
		headers: { ...headers, Authorization: authorization },
	});
	if (!res.ok) {
		const t = await res.text().catch(() => "");
		throw new Error(`R2 ${res.status}: ${t.slice(0, 300)}`);
	}
}

export async function metaShareLink(html: string): Promise<{ ok: boolean; url?: string; error?: string }> {
	const cfg = loadR2();
	if (!cfg) return { ok: false, error: "Share not configured (missing ~/.pi/agent/meta-vincent/r2.json)" };
	try {
		const id = randomUUID().replace(/-/g, "").slice(0, 12);
		const key = `share/${id}.html`;
		await r2Put(cfg, key, Buffer.from(html, "utf8"), "text/html; charset=utf-8");
		return { ok: true, url: `${cfg.publicBase.replace(/\/$/, "")}/${key}` };
	} catch (e: any) {
		return { ok: false, error: e?.message || "upload failed" };
	}
}

export async function metaExportHtml(
	win: BW | null,
	html: string,
	name: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await dialog.showSaveDialog(win!, {
			defaultPath: join(homedir(), "Desktop", `${name}.html`),
			filters: [{ name: "HTML", extensions: ["html"] }],
		});
		if (res.canceled || !res.filePath) return { ok: false };
		writeFileSync(res.filePath, html, "utf8");
		return { ok: true };
	} catch (e: any) {
		return { ok: false, error: e?.message || "export failed" };
	}
}

export async function metaExportPng(
	win: BW | null,
	html: string,
	name: string,
): Promise<{ ok: boolean; error?: string }> {
	let off: BrowserWindow | null = null;
	try {
		off = new BrowserWindow({
			width: 660,
			height: 1000,
			x: -20000, // park off-screen: we showInactive() so the compositor actually paints
			y: 0,
			show: false,
			paintWhenInitiallyHidden: true,
			webPreferences: { offscreen: false, sandbox: true, backgroundThrottling: false },
		});
		await off.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		// Let fonts/layout settle, then size the window to the content height.
		await new Promise((r) => setTimeout(r, 250));
		const h = (await off.webContents.executeJavaScript("Math.ceil(document.body.scrollHeight)")) as number;
		off.setContentSize(660, Math.max(200, Math.min(6000, h)));
		off.showInactive(); // off-screen, so invisible to the user but guaranteed to render
		await new Promise((r) => setTimeout(r, 180));
		const img = await off.webContents.capturePage();
		const png = img.toPNG();
		const res = await dialog.showSaveDialog(win!, {
			defaultPath: join(homedir(), "Desktop", `${name}.png`),
			filters: [{ name: "PNG", extensions: ["png"] }],
		});
		if (res.canceled || !res.filePath) return { ok: false };
		writeFileSync(res.filePath, png);
		return { ok: true };
	} catch (e: any) {
		return { ok: false, error: e?.message || "png failed" };
	} finally {
		if (off && !off.isDestroyed()) off.destroy();
	}
}
