import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import { fetch } from "undici";
import { antigravityHeaders, extractProjectId, LOAD_CODE_ASSIST_BODY } from "./antigravity/client/client.js";
import { configureRelay } from "./antigravity/client/relay.js";
import { assertSafeRelayUrl } from "./antigravity/utils/security.js";
import type { AntigravitySettings, AntigravitySettingsInput } from "../shared/types.js";

export class AntigravitySettingsStore {
	private readonly path: string;
	private saved?: { url: string; key: string };

	constructor(agentDir: string) {
		this.path = join(agentDir, "heipang-antigravity.json");
		if (existsSync(this.path)) {
			const stored = JSON.parse(readFileSync(this.path, "utf8"));
			this.saved = {
				url: assertSafeRelayUrl(stored.url),
				key: safeStorage.decryptString(Buffer.from(stored.encryptedKey, "base64")),
			};
		}
		configureRelay(this.saved ?? { url: "", key: "" });
	}

	get(): AntigravitySettings {
		return {
			relayUrl: this.saved?.url ?? "",
			hasKey: Boolean(this.saved?.key),
		};
	}

	async save(input: AntigravitySettingsInput): Promise<void> {
		const url = assertSafeRelayUrl(input.relayUrl.trim());
		const key = input.relayKey.trim() || this.saved?.key;
		if (!key) throw new Error("Enter the Antigravity relay key.");
		if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
			throw new Error("Secure credential storage is unavailable on this system.");
		}
		const response = await fetch(`${url}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers: antigravityHeaders(key),
			body: LOAD_CODE_ASSIST_BODY,
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Antigravity relay verification failed (HTTP ${response.status}). Check the relay URL, key and relay account.`);
		if (!extractProjectId(await response.json())) throw new Error("The relay account returned no Antigravity project.");
		const encryptedKey = safeStorage.encryptString(key).toString("base64");
		const temporary = `${this.path}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ url, encryptedKey }, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
		} finally {
			rmSync(temporary, { force: true });
		}
		this.saved = { url, key };
		configureRelay(this.saved);
	}

	clear(): void {
		rmSync(this.path, { force: true });
		this.saved = undefined;
		configureRelay({ url: "", key: "" });
	}
}
