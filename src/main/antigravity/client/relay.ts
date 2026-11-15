import { assertSafeRelayUrl } from "../utils/security.js";
import { antigravityEnv } from "../utils/util.js";

export const RELAY_HELP =
  "Set ANTIGRAVITY_RELAY_URL and ANTIGRAVITY_RELAY_KEY to the address and key of your pi-antigravity relay.";

let configuredRelay: { url: string; key: string } | undefined;

export function configureRelay(value: { url: string; key: string } | undefined): void {
  configuredRelay = value;
}

export function hasRelayConfiguration(): boolean {
  try {
    return Boolean(relayUrl() && relayKey());
  } catch {
    return false;
  }
}

/** Origin of the relay every request goes to. There is no direct route to Google. */
export function relayUrl(): string {
  const raw = configuredRelay?.url ?? antigravityEnv("RELAY_URL")?.trim();
  if (!raw) throw new Error(`ANTIGRAVITY_RELAY_URL is not set. ${RELAY_HELP}`);
  return assertSafeRelayUrl(raw);
}

export function relayKey(): string {
  const key = configuredRelay?.key ?? antigravityEnv("RELAY_KEY")?.trim();
  if (!key) throw new Error(`ANTIGRAVITY_RELAY_KEY is not set. ${RELAY_HELP}`);
  return key;
}
