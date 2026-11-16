import { useState } from "react";

import type { InputRequest } from "../../../shared/types";

export function RequestDialog({ req, onClose }: { req: InputRequest; onClose: () => void }) {
	const [value, setValue] = useState("");

	const message = req.payload?.message ?? (req.kind === "code" ? "Paste the authorization code" : "Input required");
	const options: Array<{ id: string; label: string }> = Array.isArray(req.payload?.options) ? req.payload.options : [];

	const respond = (v: string | undefined) => {
		window.pi.respondRequest(req.id, v);
		onClose();
	};

	return (
		<div className="modal-backdrop nested">
			<div className="modal request-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>{req.payload.title ?? "Sign in"}</h2>
				</div>
				<div className="request-msg">{message}</div>

				{options.length > 0 ? (
					<div className="request-options">
						{options.map((o) => (
							<button className="btn" key={o.id} onClick={() => respond(o.id)} type="button">
								{o.label}
							</button>
						))}
						<button className="btn" onClick={() => respond(undefined)} type="button">
							Cancel
						</button>
					</div>
				) : (
					<>
						<input
							className="request-input"
							type={req.kind === "secret" ? "password" : "text"}
							autoComplete="off"
							spellCheck={false}
							value={value}
							autoFocus
							placeholder={req.payload?.placeholder ?? ""}
							onChange={(e) => setValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") respond(value);
								if (e.key === "Escape") respond(undefined);
							}}
						/>
						<div className="request-actions">
							<button className="btn" onClick={() => respond(undefined)} type="button">
								Cancel
							</button>
							<button className="btn btn-send" onClick={() => respond(value)} type="button">
								Submit
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
