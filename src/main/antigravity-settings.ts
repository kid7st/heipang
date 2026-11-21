import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import { assertSafeRelayUrl, configureRelay, verifyRelayConnection } from "pi-antigravity/app";
import type { AntigravitySettings, AntigravitySettingsInput } from "../shared/types.js";

export class AntigravitySettingsStore {
	private readonly path: string;
	private saved?: { url: string; key: string };
	private loadError?: string;

	constructor(agentDir: string) {
		this.path = join(agentDir, "heipang-antigravity.json");
		if (existsSync(this.path)) {
			try {
				const stored = JSON.parse(readFileSync(this.path, "utf8"));
				const url = assertSafeRelayUrl(stored.url);
				if (typeof stored.encryptedKey !== "string" || !stored.encryptedKey) throw new Error("Missing encrypted key");
				const key = safeStorage.decryptString(Buffer.from(stored.encryptedKey, "base64"));
				if (!key.trim()) throw new Error("Empty decrypted key");
				this.saved = { url, key };
			} catch {
				this.loadError = "Could not read or decrypt the saved relay settings. The original file has been kept. Enter the relay URL and key to reconnect.";
			}
		}
		configureRelay(this.saved ?? null);
	}

	get(): AntigravitySettings {
		return {
			relayUrl: this.saved?.url ?? "",
			hasKey: Boolean(this.saved?.key),
			...(this.loadError ? { error: this.loadError } : {}),
		};
	}

	async save(input: AntigravitySettingsInput): Promise<void> {
		const url = assertSafeRelayUrl(input.relayUrl.trim());
		const key = input.relayKey.trim() || this.saved?.key;
		if (!key) throw new Error("Enter the Antigravity relay key.");
		if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
			throw new Error("Secure credential storage is unavailable on this system.");
		}
		await verifyRelayConnection(url, key);
		const encryptedKey = safeStorage.encryptString(key).toString("base64");
		const temporary = `${this.path}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ url, encryptedKey }, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
		} finally {
			rmSync(temporary, { force: true });
		}
		this.loadError = undefined;
		this.saved = { url, key };
		configureRelay(this.saved);
	}

	clear(): void {
		rmSync(this.path, { force: true });
		this.loadError = undefined;
		this.saved = undefined;
		configureRelay(null);
	}
}
