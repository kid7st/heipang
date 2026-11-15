import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

export function preferBuiltinAntigravity(result: LoadExtensionsResult): LoadExtensionsResult {
	const isExternalAntigravity = (path: string): boolean => {
		if (path.startsWith("<") || path.startsWith("builtin:")) return false;
		for (let dir = dirname(path); dirname(dir) !== dir; dir = dirname(dir)) {
			const manifest = join(dir, "package.json");
			if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).name === "pi-antigravity";
		}
		return false;
	};
	result.extensions = result.extensions.filter((extension) => !isExternalAntigravity(extension.path));
	result.errors = result.errors.filter((error) => !isExternalAntigravity(error.path));
	result.runtime.pendingProviderRegistrations = result.runtime.pendingProviderRegistrations.filter(
		(registration) => !isExternalAntigravity(registration.extensionPath ?? ""),
	);
	result.runtime.pendingNativeProviderRegistrations = result.runtime.pendingNativeProviderRegistrations.filter(
		(registration) => !isExternalAntigravity(registration.extensionPath ?? ""),
	);
	return result;
}
