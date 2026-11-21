import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { antigravityExtension, antigravityImage, antigravitySearch } from "pi-antigravity/app";
import type { InputBridge } from "./input-requests.js";
import { preferBuiltinAntigravity } from "./builtin-antigravity.js";

export async function readAntigravitySystemPrompt(path: string): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!text.trim()) throw new Error(`Antigravity system prompt override is empty: ${path}`);
	return text;
}

function extensionKeys(path: string): string[] {
	return path.startsWith("<") || path.startsWith("builtin:") ? [path] : [path, resolve(path)];
}

export function createSessionResources(cwd: string, agentDir: string, getDisabledExtensions?: () => string[]) {
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const retrySettings = settingsManager.getRetrySettings.bind(settingsManager);
	settingsManager.getRetrySettings = () => {
		const policy = retrySettings();
		return { ...policy, maxRetries: Math.min(policy.maxRetries, 2) };
	};
	settingsManager.getHttpIdleTimeoutMs = () => 120_000;
	const wrapSettings = <T extends { extensions?: string[] }>(getSettings: () => T): (() => T) => () => {
		const base = getSettings();
		const disabled = (getDisabledExtensions?.() ?? []).map((path) => `-${path}`);
		if (disabled.length === 0) return base;
		return { ...base, extensions: [...(base.extensions ?? []), ...disabled] };
	};
	settingsManager.getGlobalSettings = wrapSettings(settingsManager.getGlobalSettings.bind(settingsManager));
	settingsManager.getProjectSettings = wrapSettings(settingsManager.getProjectSettings.bind(settingsManager));

	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		extensionFactories: [
			(pi) => antigravityExtension(pi, () => readAntigravitySystemPrompt(join(agentDir, "heipang-antigravity-system-prompt.txt"))),
			antigravitySearch,
			antigravityImage,
		],
		extensionsOverride: (base) => {
			const result = preferBuiltinAntigravity(base);
			const disabled = new Set((getDisabledExtensions?.() ?? []).flatMap(extensionKeys));
			if (disabled.size === 0) return result;
			const isDisabled = (path?: string) => !!path && extensionKeys(path).some((key) => disabled.has(key));
			result.extensions = result.extensions.filter((ext) => !isDisabled(ext.path) && !isDisabled(ext.resolvedPath));
			result.errors = result.errors.filter((error) => !isDisabled(error.path));
			result.runtime.pendingProviderRegistrations = result.runtime.pendingProviderRegistrations.filter(
				(registration) => !isDisabled(registration.extensionPath),
			);
			result.runtime.pendingNativeProviderRegistrations = result.runtime.pendingNativeProviderRegistrations.filter(
				(registration) => !isDisabled(registration.extensionPath),
			);
			return result;
		},
	});
	return { settingsManager, resourceLoader };
}

export async function loadSessionResources(
	cwd: string,
	agentDir: string,
	bridge: InputBridge | undefined,
	signal: AbortSignal,
	getDisabledExtensions?: () => string[],
) {
	signal.throwIfAborted();
	const resources = createSessionResources(cwd, agentDir, getDisabledExtensions);
	const store = new ProjectTrustStore(agentDir);
	let trusted = store.get(cwd);
	if (trusted === null) {
		const policy = resources.settingsManager.getDefaultProjectTrust();
		trusted = policy === "always";
		if (policy === "ask" && hasTrustRequiringProjectResources(cwd) && bridge) {
			const choice = await bridge.requestInput("select", {
				title: "Trust project folder?",
				message: `${cwd}\n\nTrusting this folder allows project settings and resources to load, project packages to be installed, and project extensions to execute with your account's permissions.`,
				options: [
					{ id: "trust", label: "Trust this folder" },
					{ id: "skip", label: "Open without project resources" },
				],
			}, { signal });
			signal.throwIfAborted();
			if (choice !== "trust" && choice !== "skip") throw new Error("Project trust confirmation cancelled");
			trusted = choice === "trust";
			store.set(cwd, trusted);
		}
	}
	signal.throwIfAborted();
	resources.settingsManager.setProjectTrusted(trusted);
	await resources.resourceLoader.reload();
	signal.throwIfAborted();
	return resources;
}
