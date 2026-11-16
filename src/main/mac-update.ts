import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function prepareMacUpdate(dmg: string, appPath: string): Promise<string> {
	const mount = await mkdtemp(join(tmpdir(), "heipang-mount-"));
	let stage: string | undefined;
	let attached = false;
	try {
		await exec("/usr/bin/hdiutil", ["attach", dmg, "-nobrowse", "-mountpoint", mount, "-quiet"], { timeout: 30_000 });
		attached = true;
		const name = basename(appPath);
		if (!(await readdir(mount)).includes(name)) throw new Error(`The installer does not contain ${name}`);
		const source = join(mount, name);
		const bundleId = async (path: string) => (await exec("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(path, "Contents", "Info.plist")])).stdout.trim();
		if (await bundleId(source) !== await bundleId(appPath)) throw new Error("The installer belongs to a different application");
		stage = await mkdtemp(join(dirname(appPath), ".heipang-update-"));
		await exec("/usr/bin/ditto", [source, join(stage, "next.app")], { timeout: 120_000 });
		return stage;
	} catch (error) {
		if (stage) await rm(stage, { recursive: true, force: true });
		throw error;
	} finally {
		try {
			if (attached) await exec("/usr/bin/hdiutil", ["detach", mount, "-quiet"], { timeout: 30_000 });
		} catch (error) {
			if (stage) await rm(stage, { recursive: true, force: true });
			throw error;
		}
		await rm(mount, { recursive: true, force: true });
	}
}

export const MAC_INSTALL_SCRIPT = `#!/bin/bash
APP="$1"
STAGE="$2"
DMG="$3"
PID="$4"
BACKUP="$STAGE/previous.app"
NEXT="$STAGE/next.app"
fallback() {
  echo "Update failed. Previous application retained at $APP or $BACKUP."
  if [ -d "$APP" ]; then open "$APP"; else open "$BACKUP"; fi
  open "$DMG"
  exit 1
}
for ((i=0; i<40; i++)); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "Application did not exit; installation cancelled."
  open "$DMG"
  exit 1
fi
mv "$APP" "$BACKUP" || fallback
if ! mv "$NEXT" "$APP"; then
  mv "$BACKUP" "$APP"
  fallback
fi
xattr -cr "$APP" 2>/dev/null || true
if ! open "$APP"; then
  mv "$APP" "$NEXT" && mv "$BACKUP" "$APP"
  fallback
fi
rm -rf "$STAGE"
`;
