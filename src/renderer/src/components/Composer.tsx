import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo, ImageAttachment } from "../../../shared/types";

interface Attachment extends ImageAttachment {
	id: string;
	preview: string; // data URL for thumbnail
}

function fileToAttachment(file: File): Promise<Attachment | null> {
	return new Promise((resolve) => {
		if (!file.type.startsWith("image/")) {
			resolve(null);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			const comma = url.indexOf(",");
			resolve({
				id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
				preview: url,
				data: comma >= 0 ? url.slice(comma + 1) : url,
				mimeType: file.type,
			});
		};
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});
}

export function Composer({
	commands,
	onSend,
	onStop,
	streaming,
	disabled,
}: {
	commands: CommandInfo[];
	onSend: (text: string, images: ImageAttachment[]) => void;
	onStop: () => void;
	streaming: boolean;
	disabled: boolean;
}) {
	const [text, setText] = useState("");
	const [atts, setAtts] = useState<Attachment[]>([]);
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

	const submit = () => {
		const t = text.trim();
		if (!t && atts.length === 0) return;
		onSend(t, atts.map(({ data, mimeType }) => ({ data, mimeType })));
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
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const f = item.getAsFile();
				if (f) files.push(f);
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
						<div className="attach-thumb" key={a.id}>
							<img src={a.preview} alt="attachment" />
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
					accept="image/*"
					multiple
					style={{ display: "none" }}
					onChange={(e) => {
						if (e.target.files) addFiles(e.target.files);
						e.target.value = "";
					}}
				/>
				<button className="attach-btn" onClick={() => fileRef.current?.click()} title="Attach image" type="button" disabled={disabled}>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M12 5v14M5 12h14" />
					</svg>
				</button>
				<textarea
					ref={taRef}
					className="composer-input"
					placeholder={disabled ? "Loading…" : "Message…  ( / for commands · paste or + to attach images )"}
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
