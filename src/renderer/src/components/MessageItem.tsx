import { memo, useState } from "react";
import type { UIMessage } from "../../../shared/types";
import { Markdown } from "./Markdown";

function userText(content: UIMessage extends { role: "user" } ? never : any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

function Collapsible({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="collapsible">
			<button className="collapsible-head" onClick={() => setOpen((o) => !o)} type="button">
				<span className="chev">{open ? "▾" : "▸"}</span>
				{title}
			</button>
			{open && <div className="collapsible-body">{children}</div>}
		</div>
	);
}

function blockText(content: any[]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n\n");
}

export const MessageItem = memo(function MessageItem({ msg }: { msg: UIMessage }) {
	if (msg.role === "user") {
		const imgs = Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "image") : [];
		const txt = userText(msg.content);
		return (
			<div className="msg msg-user">
				<div className="bubble">
					{imgs.length > 0 && (
						<div className="msg-images">
							{imgs.map((c: any, i: number) => (
								<img key={i} src={`data:${c.mimeType};base64,${c.data}`} alt="attachment" />
							))}
						</div>
					)}
					{txt && <Markdown text={txt} />}
				</div>
			</div>
		);
	}

	if (msg.role === "assistant") {
		const thinking = msg.content.filter((c) => c.type === "thinking") as { thinking: string }[];
		const tools = msg.content.filter((c) => c.type === "toolCall") as { id: string; name: string; arguments: any }[];
		const text = blockText(msg.content);
		return (
			<div className="msg msg-assistant">
				{thinking.length > 0 && (
					<Collapsible title="Thinking">
						<div className="thinking">{thinking.map((t) => t.thinking).join("\n\n")}</div>
					</Collapsible>
				)}
				{text && (
					<div className="bubble">
						<Markdown text={text} />
					</div>
				)}
				{tools.map((t) => (
					<div className="toolcall" key={t.id}>
						<div className="toolcall-head">
							<span className="tool-name">{t.name}</span>
						</div>
						<pre className="toolcall-args">{JSON.stringify(t.arguments, null, 2)}</pre>
					</div>
				))}
				{msg.errorMessage && <div className="msg-error">{msg.errorMessage}</div>}
			</div>
		);
	}

	// toolResult
	const text = msg.content
		.filter((c) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
	const title = `${msg.toolName}${msg.isError ? " (error)" : ""}`;
	return (
		<div className={`msg msg-tool${msg.isError ? " is-error" : ""}`}>
			<Collapsible title={title}>
				<pre className="tool-output">{text || "(no output)"}</pre>
			</Collapsible>
		</div>
	);
});
