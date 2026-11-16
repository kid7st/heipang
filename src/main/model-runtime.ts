import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";

class CredentialPersistenceError extends Error {
	constructor(provider: string, cause: unknown, readonly isRecovered: () => boolean) {
		super(`Could not save credentials for ${provider}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
	}
}

export function unresolvedCredentialErrors(error: unknown): unknown[] {
	if (error instanceof CredentialPersistenceError && error.isRecovered()) return [];
	if (error instanceof AggregateError) {
		const errors = error.errors.flatMap(unresolvedCredentialErrors);
		if (errors.length !== error.errors.length || errors.some((entry, index) => entry !== error.errors[index])) return errors;
	}
	return [error];
}

export async function createPersistentModelRuntime(agentDir: string, signal: AbortSignal, credentialRevisions: Map<string, symbol>): Promise<ModelRuntime> {
	// The pinned SDK does not export its file store; retain its CLI locking and key-command semantics.
	const moduleUrl = new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
	const { AuthStorage } = await import(moduleUrl.href) as { AuthStorage: { create(path: string): CredentialStore } };
	const credentials = AuthStorage.create(join(agentDir, "auth.json"));
	const failures = new Map<string, CredentialPersistenceError>();
	const saved = (provider: string) => {
		credentialRevisions.set(provider, Symbol());
		failures.delete(provider);
	};
	const modify = credentials.modify.bind(credentials);
	credentials.modify = async (provider, fn, options) => {
		let callbackFailed = false;
		let changed = false;
		let revision = credentialRevisions.get(provider);
		try {
			const result = await modify(provider, async (current) => {
				revision = credentialRevisions.get(provider);
				try {
					const next = await fn(current);
					changed = next !== undefined;
					return next;
				} catch (error) {
					callbackFailed = true;
					throw error;
				}
			}, options);
			if (changed) saved(provider);
			return result;
		} catch (error) {
			const signal = options?.signal;
			const cancelled = signal?.aborted && (error === signal.reason
				|| (error instanceof Error && error.name === "AbortError" && error.cause === signal.reason));
			if (!callbackFailed && !cancelled) {
				failures.set(provider, new CredentialPersistenceError(provider, error,
					() => revision !== credentialRevisions.get(provider)));
			}
			throw error;
		}
	};
	const remove = credentials.delete.bind(credentials);
	credentials.delete = async (provider, options) => {
		await remove(provider, options);
		saved(provider);
	};
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		signal,
	});
	const settle = runtime.settleCredentialWrites.bind(runtime);
	runtime.settleCredentialWrites = async () => {
		await settle();
		const errors: Error[] = [];
		for (const [provider, failure] of failures) {
			if (failure.isRecovered()) failures.delete(provider);
			else errors.push(failure);
		}
		if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
	};
	return runtime;
}
