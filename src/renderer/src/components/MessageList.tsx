import { useEffect, useMemo, useRef } from "react";
import { VList, type VListHandle } from "virtua";
import type { UIMessage } from "../../../shared/types";
import { MessageItem } from "./MessageItem";

export function MessageList({ messages, streaming }: { messages: UIMessage[]; streaming: boolean }) {
	const ref = useRef<VListHandle>(null);
	const stickRef = useRef(true);

	const items = useMemo(() => {
		const out: { m: UIMessage; i: number }[] = [];
		messages.forEach((m, i) => {
			if (m.role === "toolResult") return;
			if (m.role === "assistant") {
				const hasText = m.content.some((c) => c.type === "text" && c.text.trim());
				if (!hasText && !m.errorMessage) return;
			}
			out.push({ m, i });
		});
		return out;
	}, [messages]);

	// Auto-stick to bottom while streaming or when already at bottom.
	useEffect(() => {
		if (stickRef.current && ref.current && items.length > 0) {
			ref.current.scrollToIndex(items.length - 1, { align: "end" });
		}
	}, [items.length, streaming, items]);

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
			{(it) => <MessageItem key={it.i} msg={it.m} />}
		</VList>
	);
}
