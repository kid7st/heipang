import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo, ImageAttachment } from "../../../shared/types";

interface Attachment extends ImageAttachment {
	id: string;
	preview?: string; // data URL for image thumbnail
}

// Native attachments supported by the GUI. PDF is carried through pi's current
// image attachment channel and converted to Anthropic's document block by the
// dependency patch in scripts/patch-pi-pdf.mjs.
const SUPPORTED_ATTACHMENT_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const PDF_EXTS = new Set(["pdf"]);
// Text-like files we embed into the message body (the model API takes no
// arbitrary non-image/non-PDF file attachments).
const TEXT_EXTS = new Set([
	"txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml", "xml", "html", "htm",
	"css", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cc",
	"sh", "bash", "zsh", "sql", "toml", "ini", "env", "log", "svg", "vue", "php", "kt", "swift",
]);
const MAX_TEXT_BYTES = 512 * 1024;

function extOf(name: string): string {
	const i = name.lastIndexOf(".");
	return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function looksLikeImage(file: File): boolean {
	return file.type.startsWith("image/") || IMAGE_EXTS.has(extOf(file.name));
}

function looksLikePdf(file: File): boolean {
	return file.type === "application/pdf" || PDF_EXTS.has(extOf(file.name));
}

function looksLikeAttachment(file: File): boolean {
	return looksLikeImage(file) || looksLikePdf(file);
}

function looksLikeText(file: File): boolean {
	return (
		file.type.startsWith("text/") ||
		file.type === "application/json" ||
		file.type === "application/xml" ||
		TEXT_EXTS.has(extOf(file.name))
	);
}

// Browsers fill File.type from the extension, so a JPEG renamed *.png reports
// "image/png" while the bytes are JPEG and the API rejects the mismatch. Decode
// the leading bytes and trust the magic number instead.
function sniffAttachmentMime(base64: string): string | null {
	let head: string;
	try {
		head = atob(base64.slice(0, 32));
	} catch {
		return null;
	}
	const at = (i: number) => head.charCodeAt(i) & 0xff;
	if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
	if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
	if (
		at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
		at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
	)
		return "image/webp";
	if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) return "application/pdf";
	return null;
}

function fileToAttachment(file: File): Promise<Attachment | null> {
	return new Promise((resolve) => {
		if (!looksLikeAttachment(file)) {
			resolve(null);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			const comma = url.indexOf(",");
			const data = comma >= 0 ? url.slice(comma + 1) : url;
			// Trust the actual bytes over the OS-reported extension/type.
			const sniffed = sniffAttachmentMime(data);
			const mimeType = sniffed ?? (SUPPORTED_ATTACHMENT_MIME.has(file.type) ? file.type : null);
			if (!mimeType) {
				resolve(null); // unsupported format the API would reject anyway
				return;
			}
			const preview = mimeType.startsWith("image/") ? (sniffed && sniffed !== file.type ? `data:${sniffed};base64,${data}` : url) : undefined;
			resolve({
				id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
				preview,
				data,
				mimeType,
				name: file.name,
			});
		};
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});
}

function readTextFile(file: File): Promise<string | null> {
	return new Promise((resolve) => {
		if (file.size > MAX_TEXT_BYTES) {
			resolve(null);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => resolve(null);
		reader.readAsText(file);
	});
}

export function Composer({
	commands,
	onSend,
	onStop,
	streaming,
	disabled,
	sessionKey,
}: {
	commands: CommandInfo[];
	onSend: (text: string, images: ImageAttachment[]) => void;
	onStop: () => void;
	streaming: boolean;
	disabled: boolean;
	sessionKey: string;
}) {
	const [text, setText] = useState("");
	const [atts, setAtts] = useState<Attachment[]>([]);
	const [dragging, setDragging] = useState(false);

	// Per-session drafts: switching sessions must not carry unsent text/images
	// across. Each session keeps its own draft; returning restores it.
	const draftsRef = useRef<Record<string, { text: string; atts: Attachment[] }>>({});
	const prevKeyRef = useRef(sessionKey);
	useEffect(() => {
		if (prevKeyRef.current === sessionKey) return;
		draftsRef.current[prevKeyRef.current] = { text, atts };
		const d = draftsRef.current[sessionKey] ?? { text: "", atts: [] };
		setText(d.text);
		setAtts(d.atts);
		prevKeyRef.current = sessionKey;
	}, [sessionKey, text, atts]);
	const [paletteIdx, setPaletteIdx] = useState(0);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const slash = useMemo(() => {
		const m = /^\/([\w:-]*)$/.exec(text);
		return m ? m[1].toLowerCase() : null;
	}, [text]);
	const matches = useMemo(() => {
		if (slash === null) return [];
		return commands.filter((c) => c.name.toLowerCase().includes(slash)).slice(0, 8);
	}, [slash, commands]);
	const paletteOpen = slash !== null && matches.length > 0;
	useEffect(() => setPaletteIdx(0), [slash]);

	const addFiles = async (files: FileList | File[]) => {
		const results = await Promise.all(Array.from(files).map(fileToAttachment));
		const ok = results.filter((r): r is Attachment => r !== null);
		if (ok.length) setAtts((a) => [...a, ...ok]);
	};

	// Dropped files: images/PDFs become attachments, text/JSON files are embedded
	// into the message body. Folders and unsupported binaries are ignored.
	const addDropped = async (files: File[]) => {
		const attachments = files.filter(looksLikeAttachment);
		const texts = files.filter((f) => !looksLikeAttachment(f) && looksLikeText(f));
		if (attachments.length) await addFiles(attachments);
		for (const f of texts) {
			const content = await readTextFile(f);
			if (content == null) continue;
			const block = `\n\n${f.name}\n\`\`\`${extOf(f.name)}\n${content}\n\`\`\`\n`;
			setText((t) => t + block);
		}
	};
	// Keep the latest handler reachable from the once-bound window listeners.
	const droppedRef = useRef(addDropped);
	droppedRef.current = addDropped;

	// Accept drops anywhere in the window. Electron would otherwise navigate the
	// page to the dropped file, which is why drag-drop appeared to do nothing.
	useEffect(() => {
		const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
		let depth = 0;
		const onEnter = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth++;
			setDragging(true);
		};
		const onOver = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		};
		const onLeave = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDragging(false);
		};
		const onDrop = (e: DragEvent) => {
			e.preventDefault();
			depth = 0;
			setDragging(false);
			const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
			if (files.length) droppedRef.current(files);
		};
		window.addEventListener("dragenter", onEnter);
		window.addEventListener("dragover", onOver);
		window.addEventListener("dragleave", onLeave);
		window.addEventListener("drop", onDrop);
		return () => {
			window.removeEventListener("dragenter", onEnter);
			window.removeEventListener("dragover", onOver);
			window.removeEventListener("dragleave", onLeave);
			window.removeEventListener("drop", onDrop);
		};
	}, []);

	const submit = () => {
		const t = text.trim();
		if (!t && atts.length === 0) return;
		onSend(t, atts.map(({ data, mimeType, name }) => ({ data, mimeType, name })));
		setText("");
		setAtts([]);
		if (taRef.current) taRef.current.style.height = "auto";
	};

	const pick = (c: CommandInfo) => {
		setText(`/${c.name} `);
		taRef.current?.focus();
	};

	const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (paletteOpen) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setPaletteIdx((i) => (i + 1) % matches.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setPaletteIdx((i) => (i - 1 + matches.length) % matches.length);
				return;
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
				e.preventDefault();
				pick(matches[paletteIdx]);
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};

	const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const files: File[] = [];
		for (const item of e.clipboardData.items) {
			if (item.kind === "file") {
				const f = item.getAsFile();
				if (f && looksLikeAttachment(f)) files.push(f);
			}
		}
		if (files.length) {
			e.preventDefault();
			addFiles(files);
		}
	};

	const autoGrow = (el: HTMLTextAreaElement) => {
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
	};

	return (
		<div className="composer-wrap">
			{dragging && (
				<div className="drop-overlay">
					<div className="drop-overlay-inner">
						释放以添加文件
						<span className="drop-overlay-hint">图片/PDF 作为附件 · 文本/JSON 作为内容插入</span>
					</div>
				</div>
			)}
			{paletteOpen && (
				<div className="slash-palette">
					{matches.map((c, i) => (
						<button
							key={`${c.source}:${c.name}`}
							className={`slash-item${i === paletteIdx ? " active" : ""}`}
							onMouseEnter={() => setPaletteIdx(i)}
							onClick={() => pick(c)}
							type="button"
						>
							<span className="slash-name">/{c.name}</span>
							<span className="slash-src">{c.source}</span>
							{c.description && <span className="slash-desc">{c.description}</span>}
						</button>
					))}
				</div>
			)}

			{atts.length > 0 && (
				<div className="attach-row">
					{atts.map((a) => (
						<div className="attach-thumb" key={a.id} title={a.name || a.mimeType}>
							{a.mimeType === "application/pdf" ? (
								<div className="attach-file"><span className="attach-file-icon">PDF</span><span>{a.name || "document.pdf"}</span></div>
							) : (
								<img src={a.preview} alt="attachment" />
							)}
							<button className="attach-remove" onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))} type="button">
								×
							</button>
						</div>
					))}
				</div>
			)}

			<div className="composer">
				<input
					ref={fileRef}
					type="file"
					accept="image/*,application/pdf,.pdf"
					multiple
					style={{ display: "none" }}
					onChange={(e) => {
						if (e.target.files) addFiles(e.target.files);
						e.target.value = "";
					}}
				/>
				<button className="attach-btn" onClick={() => fileRef.current?.click()} title="Attach image or PDF" type="button" disabled={disabled}>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M12 5v14M5 12h14" />
					</svg>
				</button>
				<textarea
					ref={taRef}
					className="composer-input"
					placeholder={disabled ? "Loading…" : "Message…  ( / for commands · paste/drop or + to attach images/PDFs )"}
					value={text}
					disabled={disabled}
					onChange={(e) => {
						setText(e.target.value);
						autoGrow(e.target);
					}}
					onKeyDown={onKey}
					onPaste={onPaste}
					rows={1}
				/>
				{streaming ? (
					<button className="icon-btn stop" onClick={onStop} title="Stop" type="button">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
							<rect x="6" y="6" width="12" height="12" rx="2" />
						</svg>
					</button>
				) : (
					<button className="icon-btn send" onClick={submit} title="Send" type="button" disabled={disabled || (!text.trim() && atts.length === 0)}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M12 19V5" />
							<path d="M5 12l7-7 7 7" />
						</svg>
					</button>
				)}
			</div>
		</div>
	);
}
