import { createHash } from "node:crypto";
import {
  antigravityEndpoint,
  antigravityHeaders,
  extractProjectId,
  jsonOrTextError,
  LOAD_CODE_ASSIST_BODY,
} from "../client/client.js";
import { relayKey, relayUrl } from "../client/relay.js";
import { antigravityTransport } from "../client/transport.js";

export const RELAY_AUTH_SOURCE = "pi-antigravity relay (ANTIGRAVITY_RELAY_KEY)";

/** A stopped relay machine boots on the first request, which takes longer than a warm one. */
const DISCOVERY_TIMEOUT_MS = 30_000;
const PROJECT_TTL_MS = 30 * 60 * 1000;

let cachedProject: { key: string; projectId: string; expiresAt: number } | undefined;

/**
 * The credential every request carries. The relay key stands in for the access token: the
 * relay swaps in the account's real token, so nothing on this machine can reach Google.
 * The project id comes from the relay's own loadCodeAssist.
 */
export async function resolveRelayApiKey(signal?: AbortSignal): Promise<string> {
  const key = relayKey();
  const cacheKey = JSON.stringify([relayUrl(), key]);
  let projectId =
    cachedProject?.key === cacheKey && cachedProject.expiresAt > Date.now()
      ? cachedProject.projectId
      : undefined;
  if (!projectId) {
    const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    const response = await antigravityTransport.fetch(
      `${antigravityEndpoint()}/v1internal:loadCodeAssist`,
      {
        method: "POST",
        headers: antigravityHeaders(key),
        body: LOAD_CODE_ASSIST_BODY,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      },
    );
    if (!response.ok) {
      const detail = jsonOrTextError(await response.text()).slice(0, 300);
      if (response.status === 401 || response.status === 403) {
        throw new Error(`The Antigravity relay refused the request: ${detail}`);
      }
      throw new Error(`Antigravity project discovery failed (${response.status}). Retry later.`);
    }
    projectId = extractProjectId(await response.json());
    if (!projectId) {
      throw new Error("Antigravity returned no project for the relay's account.");
    }
    cachedProject = { key: cacheKey, projectId, expiresAt: Date.now() + PROJECT_TTL_MS };
  }
  const account = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return JSON.stringify({ token: key, projectId, account });
}
