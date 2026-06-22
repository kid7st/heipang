import { memo, useState } from "react";
import type { UIMessage } from "../../../shared/types";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";
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
				<span className="chev">{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
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

function summarizeArgs(args: any): string {
	if (!args || typeof args !== "object") return "";
	if (typeof args.path === "string") return args.path.split("/").pop() || args.path;
	if (typeof args.file_path === "string") return args.file_path.split("/").pop() || args.file_path;
	if (typeof args.command === "string") return args.command.replace(/\s+/g, " ").trim().slice(0, 90);
	if (typeof args.pattern === "string") return args.pattern;
	if (typeof args.url === "string") return args.url;
	if (typeof args.query === "string") return args.query;
	const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
	return first ? first.slice(0, 90) : "";
}

function ToolCall({ name, args }: { name: string; args: any }) {
	const [open, setOpen] = useState(false);
	const summary = summarizeArgs(args);
	return (
		<div className="tool-line-wrap">
			<button className="tool-line" onClick={() => setOpen((o) => !o)} type="button">
				<span className="chev">{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
				<span className="tool-line-name">{name}</span>
				{summary && <span className="tool-line-arg">{summary}</span>}
			</button>
			{open && <pre className="toolcall-args">{JSON.stringify(args, null, 2)}</pre>}
		</div>
	);
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
					<ToolCall key={t.id} name={t.name} args={t.arguments} />
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
