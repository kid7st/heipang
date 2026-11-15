import { fetch as undiciFetch, getGlobalDispatcher, type Dispatcher } from "undici";
import { relayUrl } from "./relay.js";

const filteredDispatchers = new WeakMap<Dispatcher, Dispatcher>();
const FETCH_HEADERS = new Set(["accept", "accept-language", "sec-fetch-mode"]);

function requestDispatcher(): Dispatcher {
  const shared = getGlobalDispatcher();
  let filtered = filteredDispatchers.get(shared);
  if (!filtered) {
    filtered = shared.compose((dispatch) => (options, handler) => {
      // Undici fetch supplies a normalized header record at this boundary.
      const headers = Object.fromEntries(
        Object.entries(options.headers ?? {}).filter(
          ([name]) => !FETCH_HEADERS.has(name.toLowerCase()),
        ),
      );
      // agy offers only http/1.1 in ALPN, so a request must not negotiate h2.
      return dispatch(
        { ...options, headers, allowH2: false } as Dispatcher.DispatchOptions,
        handler,
      );
    });
    filteredDispatchers.set(shared, filtered);
  }
  return filtered;
}

/** Nothing leaves this machine except to the relay. */
function assertRelayOrigin(url: string): void {
  const origin = new URL(url).origin;
  if (origin !== relayUrl())
    throw new Error(`Refusing to send a request to ${origin}: only the relay is allowed.`);
}

export const antigravityTransport = {
  fetch: (url: string, init: RequestInit): Promise<Response> => {
    assertRelayOrigin(url);
    return undiciFetch(url, { ...init, redirect: "error", dispatcher: requestDispatcher() } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  },
};
