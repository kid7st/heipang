import type { InputRequest } from "../shared/types.js";

export interface InputOptions {
	signal?: AbortSignal;
	timeout?: number;
}

export interface InputBridge {
	openExternal(url: string): void;
	requestInput(kind: InputRequest["kind"], payload: InputRequest["payload"], options?: InputOptions): Promise<string | undefined>;
}

export class InputRequests {
	private sequence = 0;
	private pending = new Map<string, (value?: string) => void>();

	constructor(
		private send: (request: InputRequest) => void,
		private dismiss: (id: string) => void,
	) {}

	ask(kind: InputRequest["kind"], payload: InputRequest["payload"], options?: InputOptions): Promise<string | undefined> {
		if (options?.signal?.aborted) return Promise.resolve(undefined);
		if (this.pending.size) return Promise.reject(new Error("Another input dialog is already open. Complete or cancel it first."));
		const id = `req${++this.sequence}`;
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (value?: string, error?: unknown) => {
				if (!this.pending.delete(id)) return;
				if (timer) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", onAbort);
				try { this.dismiss(id); }
				catch (dismissError) {
					reject(error ? new AggregateError([error, dismissError], `${String(error)}; failed to dismiss input dialog: ${String(dismissError)}`) : dismissError);
					return;
				}
				if (error) reject(error);
				else resolve(value);
			};
			const onAbort = () => finish();
			this.pending.set(id, finish);
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			if (options?.timeout) timer = setTimeout(onAbort, options.timeout);
			try {
				this.send({ id, kind, payload });
			} catch (error) {
				finish(undefined, error);
			}
		});
	}

	respond(id: string, value?: string): void {
		this.pending.get(id)?.(value);
	}

	dismissAll(): void {
		for (const finish of this.pending.values()) finish();
	}
}
