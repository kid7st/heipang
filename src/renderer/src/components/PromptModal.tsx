import { useState } from "react";

export interface PromptSpec {
	title: string;
	label?: string;
	value: string;
	onSubmit: (value: string) => void;
}

export function PromptModal({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
	const [value, setValue] = useState(spec.value);
	const submit = () => {
		const v = value.trim();
		onClose();
		if (v) spec.onSubmit(v);
	};
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal prompt-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>{spec.title}</h2>
				</div>
				{spec.label && <div className="memory-sub">{spec.label}</div>}
				<input
					className="request-input"
					value={value}
					autoFocus
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") submit();
						if (e.key === "Escape") onClose();
					}}
				/>
				<div className="request-actions">
					<button className="btn" onClick={onClose} type="button">
						Cancel
					</button>
					<button className="btn btn-send" onClick={submit} type="button">
						Save
					</button>
				</div>
			</div>
		</div>
	);
}
