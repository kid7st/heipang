import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { InputBridge } from "./input-requests.js";

const noop = () => {};
const identity = (text: string) => text;
const plainTheme = {
	name: "heipang",
	appearance: "dark" as const,
	colors: new Proxy({} as ExtensionUIContext["theme"]["colors"], { get: () => "" }),
	style: identity,
	fg: (_color: unknown, text: string) => text,
	bg: (_color: unknown, text: string) => text,
	bold: identity,
	italic: identity,
	underline: identity,
	inverse: identity,
	strikethrough: identity,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
	getColorMode: () => "truecolor" as const,
	getThinkingBorderColor: () => identity,
	getBashModeBorderColor: () => identity,
} as unknown as ExtensionUIContext["theme"];

export function createExtensionUI(
	bridge: InputBridge,
	notify: (message: string) => void,
	signal: AbortSignal,
): ExtensionUIContext {
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
		onTerminalInput: () => noop,
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		custom: async () => undefined as never,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		theme: plainTheme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not supported in HEIPANG" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	};
}
