import { isRecord } from "./util.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The relay receives every request and the relay key, so it must be a plain https origin (or loopback). */
export function assertSafeRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ANTIGRAVITY_RELAY_URL: ${raw}`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new Error(`ANTIGRAVITY_RELAY_URL must use https (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("ANTIGRAVITY_RELAY_URL must not include credentials");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("ANTIGRAVITY_RELAY_URL must be an origin only, like https://relay.example.com");
  }
  return url.origin;
}

/** Redact bearer tokens, refresh tokens, and similar secrets from diagnostics/errors. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
    .replace(/\b1\/[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*)[^\s&,}]+/gi,
      "$1[redacted]",
    );
}

const VALIDATION_URL_HOST = "accounts.google.com";

/** Accept only the Google account-verification host, never an arbitrary redirect. */
export function safeValidationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /\s/.test(value))
    return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  if (url.hostname !== VALIDATION_URL_HOST) return undefined;
  return url.toString();
}

/** Pull `validation_url` from a 403 body before message slicing can drop it. */
export function extractValidationUrl(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { details?: unknown } };
    const details = parsed.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (!isRecord(detail) || !isRecord(detail.metadata)) continue;
        const safe = safeValidationUrl(detail.metadata.validation_url);
        if (safe) return safe;
      }
    }
  } catch {
    // not JSON
  }
  const match = text.match(/https:\/\/accounts\.google\.com\/[^\s"'<>\\]+/);
  return match ? safeValidationUrl(match[0].replace(/[),.;]+$/, "")) : undefined;
}

/** Keep session-bearing verification links out of doctor output and stored diagnostics. */
export function stripValidationUrls(text: string): string {
  return text
    .replace(/https:\/\/accounts\.google\.com\/[^\s"'<>\\]+/g, "[redacted-validation-url]")
    .replace(
      / Open this link in a browser signed in to the same Google account to verify: \[redacted-validation-url\]/g,
      "",
    );
}

export function maskEmail(email: string | undefined): string | undefined {
  if (!email || typeof email !== "string") return undefined;
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "[redacted-email]";
  const name = parts[0];
  const domain = parts[1];
  const lastChar = name.at(-1) || "";
  const maskedName = name.length > 2 ? `${name[0]}***${lastChar}` : `${name[0]}***`;
  return `${maskedName}@${domain}`;
}

export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw);
}
