import { memo } from "react";
import type { ToolCallContent, UIMessage } from "../../../shared/types";
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

function blockText(content: any[]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n\n");
}

function compact(s: unknown, max = 88): string {
	const text = String(s ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function baseName(path: unknown): string {
	const text = String(path ?? "").replace(/\/$/, "");
	if (!text) return "";
	return text.split(/[\\/]/).pop() || text;
}

function firstArg(args: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const v = args[key];
		if (typeof v === "string" && v.trim()) return v;
		if (typeof v === "number") return String(v);
	}
	return "";
}

function toolSummary(call: ToolCallContent): string {
	const name = call.name.replace(/^functions\./, "");
	const args = call.arguments || {};
	const path = firstArg(args, ["path", "file", "filePath", "cwd", "url"]);
	const shortPath = path ? baseName(path) : "";
	if (name === "read") return shortPath ? `Read file: ${shortPath}` : "Read file";
	if (name === "write") return shortPath ? `Write file: ${shortPath}` : "Write file";
	if (name === "edit") return shortPath ? `Edit file: ${shortPath}` : "Edit file";
	if (name === "bash") return `Run command${args.command ? `: ${compact(args.command)}` : ""}`;
	if (name === "grep") return `Search content${args.pattern ? `: ${compact(args.pattern, 60)}` : ""}`;
	if (name === "find") return `Find files${args.pattern ? `: ${compact(args.pattern, 60)}` : ""}`;
	if (name === "ls") return shortPath ? `List directory: ${shortPath}` : "List directory";
	if (name === "read_url") return path ? `Read web page: ${compact(path, 70)}` : "Read web page";
	return `Use tool: ${name}`;
}

function activeProgressText(line: string): string {
	return line
		.replace(/^Read file/, "Reading file")
		.replace(/^Write file/, "Writing file")
		.replace(/^Edit file/, "Editing file")
		.replace(/^Run command/, "Running command")
		.replace(/^Search content/, "Searching content")
		.replace(/^Find files/, "Finding files")
		.replace(/^List directory/, "Listing directory")
		.replace(/^Read web page/, "Reading web page")
		.replace(/^Use tool/, "Using tool");
}

function progressLines(content: any[]): string[] {
	return content
		.filter((c): c is ToolCallContent => c.type === "toolCall")
		.map(toolSummary)
		.slice(-3);
}

function humanErrorMessage(error: string): string {
	if (/terminated|fetch failed|network|connection|timeout|timed out|socket hang up/i.test(error)) {
		return "Network or model service interrupted. This response did not finish. You can send again; temporary interruptions may retry automatically.";
	}
	if (/overloaded|service unavailable|too many requests|rate.?limit|429|503|504/i.test(error)) {
		return "Model service is busy. This response did not finish. Try again later.";
	}
	if (/aborted|abort/i.test(error)) {
		return "Request was aborted.";
	}
	return error;
}

export const MessageItem = memo(function MessageItem({ msg, active }: { msg: UIMessage; active?: boolean }) {
	if (msg.role === "user") {
		const attachments = Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "image") : [];
		const imgs = attachments.filter((c: any) => c.mimeType !== "application/pdf");
		const pdfs = attachments.filter((c: any) => c.mimeType === "application/pdf");
		const txt = userText(msg.content);
		return (
			<div className="msg msg-user">
				<div className="bubble">
					{attachments.length > 0 && (
						<div className="msg-images">
							{imgs.map((c: any, i: number) => (
								<img key={`img-${i}`} src={`data:${c.mimeType};base64,${c.data}`} alt="attachment" />
							))}
							{pdfs.map((c: any, i: number) => (
								<div key={`pdf-${i}`} className="msg-file"><span className="msg-file-badge">PDF</span>{c.name || "document.pdf"}</div>
							))}
						</div>
					)}
					{txt && <Markdown text={txt} />}
				</div>
			</div>
		);
	}

	if (msg.role === "assistant") {
		const text = blockText(msg.content);
		const progress = progressLines(msg.content);
		const showLiveFallback = active && !text && progress.length === 0 && !msg.errorMessage;
		if (!text && !msg.errorMessage && progress.length === 0 && !showLiveFallback) return null;
		return (
			<div className="msg msg-assistant">
				{text && (
					<div className="bubble">
						<Markdown text={text} />
					</div>
				)}
				{(progress.length > 0 || showLiveFallback) && (
					<div className="agent-progress" title="Brief agent progress; tool output is hidden">
						{showLiveFallback ? (
							<div className="agent-step"><span className="spinner sm" />Thinking about next step…</div>
						) : (
							progress.map((line, i) => (
								<div className="agent-step" key={`${line}-${i}`}>
									{active && i === progress.length - 1 ? <span className="spinner sm" /> : <span className="agent-step-dot">✓</span>}
									<span>{active && i === progress.length - 1 ? activeProgressText(line) : line}</span>
								</div>
							))
						)}
					</div>
				)}
				{msg.errorMessage && <div className="msg-error">{humanErrorMessage(msg.errorMessage)}</div>}
			</div>
		);
	}

	// Tool results are process details, not human-facing conversation content.
	return null;
});
