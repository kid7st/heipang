import { useEffect, useRef } from "react";
import { VList, type VListHandle } from "virtua";
import type { UIMessage } from "../../../shared/types";
import { MessageItem } from "./MessageItem";

export function MessageList({ messages, streaming }: { messages: UIMessage[]; streaming: boolean }) {
	const ref = useRef<VListHandle>(null);
	const stickRef = useRef(true);

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
			</div>
		);
	}

	return (
		<VList
			ref={ref}
			className="msg-list"
			data={messages}
			onScroll={() => {
				const el = ref.current;
				if (!el) return;
				const dist = el.scrollSize - (el.scrollOffset + el.viewportSize);
				stickRef.current = dist < 80;
			}}
		>
			{(msg, i) => <MessageItem key={i} msg={msg} />}
		</VList>
	);
}
