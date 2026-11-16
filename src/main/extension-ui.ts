import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { InputBridge } from "./input-requests.js";

export function createExtensionUI(
	bridge: InputBridge,
	notify: (message: string) => void,
	signal: AbortSignal,
): ExtensionUIContext {
	const unsupported = (): never => { throw new Error("This extension requires terminal UI, which HEIPANG does not support."); };
	return {
		select: (title, options, opts) => bridge.requestInput("select", {
			title, message: title, options: options.map((value) => ({ id: value, label: value })),
		}, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal }),
		confirm: async (title, message, opts) => (await bridge.requestInput("select", {
			title, message, options: [{ id: "yes", label: "Confirm" }, { id: "no", label: "Cancel" }],
		}, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })) === "yes",
		input: (title, placeholder, opts) => bridge.requestInput("prompt", { title, message: title, placeholder },
			{ ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal }),
		notify,
		onTerminalInput: unsupported,
		setStatus: unsupported,
		setWorkingMessage: unsupported,
		setWorkingVisible: unsupported,
		setWorkingIndicator: unsupported,
		setHiddenThinkingLabel: unsupported,
		setWidget: unsupported,
		setFooter: unsupported,
		setHeader: unsupported,
		setTitle: unsupported,
		custom: unsupported,
		pasteToEditor: unsupported,
		setEditorText: unsupported,
		getEditorText: unsupported,
		editor: unsupported,
		addAutocompleteProvider: unsupported,
		setEditorComponent: unsupported,
		getEditorComponent: unsupported,
		theme: new Proxy({} as ExtensionUIContext["theme"], { get: unsupported }),
		getAllThemes: unsupported,
		getTheme: unsupported,
		setTheme: unsupported,
		getToolsExpanded: unsupported,
		setToolsExpanded: unsupported,
	};
}
