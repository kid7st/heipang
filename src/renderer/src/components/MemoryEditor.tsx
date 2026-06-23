import { useEffect, useState } from "react";
import { CloseIcon } from "./icons";

export function MemoryEditor({
	cwd,
	label,
	onClose,
}: {
	cwd?: string;
	label: string;
	onClose: () => void;
}) {
	const [text, setText] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		window.pi.readMemory(cwd).then((c) => {
			setText(c);
			setLoaded(true);
		});
	}, [cwd]);

	const save = async () => {
		await window.pi.writeMemory(text, cwd);
		setSaved(true);
		setTimeout(() => setSaved(false), 1500);
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal memory-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>Memory · {label}</h2>
					<button className="btn btn-icon" onClick={onClose} type="button">
						<CloseIcon />
					</button>
				</div>
				<div className="memory-sub">
					Notes here are fed to the agent automatically at the start of every conversation
					{cwd ? " in this folder" : " (all conversations)"}. Plain text / Markdown. Saved as AGENTS.md.
				</div>
				<textarea
					className="memory-text"
					value={text}
					disabled={!loaded}
					placeholder={loaded ? "e.g. Always reply in Chinese. The product is a vintage shop. Prefer concise answers…" : "Loading…"}
					onChange={(e) => setText(e.target.value)}
				/>
				<div className="memory-actions">
					{saved && <span className="memory-saved">Saved</span>}
					<button className="btn btn-send" onClick={save} disabled={!loaded} type="button">
						Save
					</button>
				</div>
			</div>
		</div>
	);
}
