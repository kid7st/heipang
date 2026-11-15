import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { streamAntigravity } from "../stream/stream.js";
import { parseRequestState, requestStateFromHistory, type RequestHistoryEvent } from "./session.js";

export const REQUEST_STATE_ENTRY = "antigravity.request-state";

function requestHistory(branch: readonly SessionEntry[]): RequestHistoryEvent[] {
  return branch.flatMap((entry): RequestHistoryEvent[] => {
    if (entry.type === "custom" && entry.customType === REQUEST_STATE_ENTRY) {
      return [{ role: "antigravity_request", state: parseRequestState(entry.data) }];
    }
    if (entry.type === "message") return convertToLlm([entry.message]);
    if (entry.type === "custom_message") {
      return [{ role: "user", content: entry.content, timestamp: Date.parse(entry.timestamp) }];
    }
    return [];
  });
}

export function bindSessionStream(pi: ExtensionAPI): typeof streamAntigravity {
  let active: ExtensionContext | undefined;
  pi.on("session_start", (_event, ctx) => {
    active = ctx;
  });
  pi.on("session_shutdown", () => {
    active = undefined;
  });

  return (model, context, options) => {
    const session = active;
    if (!session || options?.sessionId !== session.sessionManager.getSessionId()) {
      return streamAntigravity(model, context, options);
    }
    return streamAntigravity(model, context, {
      ...options,
      reserveRequestState: () => {
        if (active !== session)
          throw new Error("Antigravity session changed before the request was sent.");
        const state = requestStateFromHistory(
          requestHistory(session.sessionManager.getBranch()),
          session.sessionManager.getSessionId(),
        );
        // Reserve before network I/O so an interrupted or omitted response still advances the next attempt.
        pi.appendEntry(REQUEST_STATE_ENTRY, state);
        return state;
      },
    });
  };
}
