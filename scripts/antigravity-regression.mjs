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

let openedUrl = "";
let dialogShown = false;
let dismissed = false;
driver.oauthBridge = {
	openExternal: (url) => { openedUrl = url; },
	requestInput: async (_kind, payload) => { dialogShown = true; return payload.placeholder; },
	dismissInputs: () => { dismissed = true; },
};
driver.runtime = async () => ({
	login: async (providerId, type, interaction) => {
		assert.equal(providerId, "antigravity");
		assert.equal(type, "oauth");
		// The provider opens the Google authorization URL.
		interaction.notify({ type: "auth_url", url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" });
		// The provider also offers a paste-callback prompt for sign-in that cannot
		// reach the local callback. HEIPANG must surface that prompt, not hide it.
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
assert.match(openedUrl, /accounts\.google\.com/);
assert.equal(dialogShown, true); // the paste dialog IS offered
assert.equal(dismissed, true); // and closed after login settles

await rm(root, { recursive: true, force: true });
console.log("PASS: Antigravity OAuth opens the browser, offers the paste dialog, dismisses it after login");
