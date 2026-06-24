import { memo } from "react";
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

function blockText(content: any[]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n\n");
}

function humanErrorMessage(error: string): string {
	if (/terminated|fetch failed|network|connection|timeout|timed out|socket hang up/i.test(error)) {
		return "网络或模型服务中断，本次回复没有完成。可以重新发送；临时中断会自动重试。";
	}
	if (/overloaded|service unavailable|too many requests|rate.?limit|429|503|504/i.test(error)) {
		return "模型服务繁忙，本次回复没有完成。稍后重试即可。";
	}
	if (/aborted|abort/i.test(error)) {
		return "本次回复已停止。";
	}
	return error;
}

export const MessageItem = memo(function MessageItem({ msg }: { msg: UIMessage }) {
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
		if (!text && !msg.errorMessage) return null;
		return (
			<div className="msg msg-assistant">
				{text && (
					<div className="bubble">
						<Markdown text={text} />
					</div>
				)}
				{msg.errorMessage && <div className="msg-error">{humanErrorMessage(msg.errorMessage)}</div>}
			</div>
		);
	}

	// Tool results are process details, not human-facing conversation content.
	return null;
});
