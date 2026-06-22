import hljs from "highlight.js";

interface Req {
	id: number;
	code: string;
	lang?: string;
}

self.onmessage = (e: MessageEvent<Req>) => {
	const { id, code, lang } = e.data;
	let html: string;
	try {
		if (lang && hljs.getLanguage(lang)) {
			html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
		} else {
			html = hljs.highlightAuto(code).value;
		}
	} catch {
		html = escapeHtml(code);
	}
	(self as unknown as Worker).postMessage({ id, html });
};

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => {
		switch (c) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}
