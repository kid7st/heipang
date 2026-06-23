import { useEffect, useMemo, useRef } from "react";
import { VList, type VListHandle } from "virtua";
import type { UIMessage, UIToolResultMessage } from "../../../shared/types";
import { MessageItem } from "./MessageItem";

export function MessageList({ messages, streaming }: { messages: UIMessage[]; streaming: boolean }) {
	const ref = useRef<VListHandle>(null);
	const stickRef = useRef(true);

	// Pair each tool result with its call so a tool shows as ONE collapsible line
	// (args + output together), instead of a separate "bash" result row.
	const results = useMemo(() => {
		const m = new Map<string, UIToolResultMessage>();
		for (const x of messages) if (x.role === "toolResult") m.set(x.toolCallId, x);
		return m;
	}, [messages]);
	const items = useMemo(() => {
		const out: { m: UIMessage; i: number }[] = [];
		messages.forEach((m, i) => {
			if (m.role !== "toolResult") out.push({ m, i });
		});
		return out;
	}, [messages]);

	// Auto-stick to bottom while streaming or when already at bottom.
	useEffect(() => {
		if (stickRef.current && ref.current) {
			ref.current.scrollToIndex(messages.length - 1, { align: "end" });
		}
	}, [messages.length, streaming, messages]);

	if (messages.length === 0) {
		return (
			<div className="empty-conv">
				<div className="empty-title">Vibe, Engage, Deliver</div>
				<div className="empty-sub">就 是 干</div>
			</div>
		);
	}

	return (
		<VList
			ref={ref}
			className="msg-list"
			data={items}
			onScroll={() => {
				const el = ref.current;
				if (!el) return;
				const dist = el.scrollSize - (el.scrollOffset + el.viewportSize);
				stickRef.current = dist < 80;
			}}
		>
			{(it) => <MessageItem key={it.i} msg={it.m} results={results} />}
		</VList>
	);
}
