import { jsonOrTextError } from "../client/client.js";
import { extractValidationUrl, redactSecrets } from "../utils/security.js";

/**
 * One Antigravity failure, classified once.
 *
 * Pi decides whether to restart a turn by matching the assistant error text against
 * its own retry patterns, and there is no structured channel for that decision. The
 * rendered message is therefore also the retry signal: a retryable failure carries
 * its status digits, a non-retryable one never does. `retryable` states the intent
 * here, and the tests assert the rendered text agrees with Pi's classifier.
 */
export type AntigravityFailure = {
  rule: string;
  retryable: boolean;
  status?: number;
  /** Backend text, redacted and bounded. */
  detail: string;
  /** User-facing explanation of this rule. */
  message: string;
  resetHint?: string;
  verifyUrl?: string;
};

type FailureInput = Pick<AntigravityFailure, "status" | "detail" | "resetHint" | "verifyUrl">;

type Rule = {
  name: string;
  retryable?: boolean;
  when: (input: FailureInput) => boolean;
  message: (input: FailureInput) => string;
};

const RATE_LIMIT_WORDS = /rate.?limit|too many requests/i;
const QUOTA_WORDS = /quota exceeded|exceeded your|limit reached|reached your|daily limit/i;

/** First match wins, so the specific rules come before the status-only fallbacks. */
const RULES: Rule[] = [
  {
    name: "boundary-trailing-model-turn",
    when: ({ status, detail }) =>
      status === 400 && /Requests ending with a model turn are not supported/i.test(detail),
    message: () =>
      "Antigravity rejected an invalid conversation message boundary. Next: update the extension or add a user message / start a new session, then retry.",
  },
  {
    name: "boundary-function-call",
    when: ({ status, detail }) =>
      status === 400 &&
      /function call turn comes immediately after a user turn or after a function response turn/i.test(
        detail,
      ),
    message: () =>
      "Antigravity rejected an invalid function-call message boundary. Next: update the extension or start a new session, then retry; re-login is not required.",
  },
  {
    name: "expired-credentials",
    when: ({ status, detail }) =>
      status === 400 && /API key not valid|API_KEY_INVALID/i.test(detail),
    message: () =>
      "Antigravity login expired or credentials are invalid. Next: run /login antigravity, then retry.",
  },
  {
    name: "unsupported-request-format",
    when: ({ status, detail }) =>
      status === 400 && /Invalid JSON payload|Unknown name/i.test(detail),
    message: ({ detail }) =>
      `Antigravity request format was rejected by the backend (${detail}). Next: switch to a simpler model or retry after updating the extension.`,
  },
  {
    name: "rejected-argument",
    when: ({ status, detail }) =>
      status === 400 && /Request contains an invalid argument/i.test(detail),
    message: ({ detail }) =>
      `Antigravity rejected this request (${detail}). Next: retry once; if it keeps failing, switch models or re-login.`,
  },
  {
    name: "bad-request",
    when: ({ status }) => status === 400,
    message: ({ detail }) =>
      `Bad request from Antigravity. Next: retry once, then run /login antigravity if it keeps failing. Backend said: ${detail}`,
  },
  {
    name: "authentication-failed",
    when: ({ status }) => status === 401,
    message: () => "Antigravity authentication failed. Next: run /login antigravity, then retry.",
  },
  {
    name: "verification-required",
    when: ({ status, verifyUrl }) => status === 403 && Boolean(verifyUrl),
    message: ({ detail, verifyUrl }) =>
      `Antigravity denied this request. Next: re-login or try another model. Backend said: ${detail} Open this link in a browser signed in to the same Google account to verify: ${verifyUrl}`,
  },
  {
    name: "access-denied",
    when: ({ status, detail }) => status === 403 && /permission|forbidden|access/i.test(detail),
    message: () =>
      "Antigravity access was denied for this account or project. Next: try another model, re-login, or use an account with access.",
  },
  {
    name: "forbidden",
    when: ({ status }) => status === 403,
    message: ({ detail }) =>
      `Antigravity denied this request. Next: re-login or try another model. Backend said: ${detail}`,
  },
  {
    name: "model-not-found",
    when: ({ status, detail }) => status === 404 && /Requested entity was not found/i.test(detail),
    message: () =>
      "This model is not available right now. Next: switch to gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-3.1-pro, or another working model.",
  },
  {
    name: "not-found",
    when: ({ status }) => status === 404,
    message: ({ detail }) =>
      `Antigravity could not find the requested resource. Next: retry or switch models. Backend said: ${detail}`,
  },
  {
    name: "request-timeout",
    retryable: true,
    when: ({ status }) => status === 408,
    message: () => "Antigravity timed out. Next: retry the same request.",
  },
  {
    name: "conflict",
    when: ({ status }) => status === 409,
    message: () =>
      "Antigravity reported a conflict for this request. Next: retry once or start a new chat session.",
  },
  {
    name: "quota-wall",
    when: ({ status, detail, resetHint }) =>
      status === 429 &&
      (Boolean(resetHint) || (!RATE_LIMIT_WORDS.test(detail) && QUOTA_WORDS.test(detail))),
    message: ({ resetHint }) =>
      `Quota reached.${resetHint ? ` Please wait ${resetHint}.` : ""} Next: switch models or retry after the reset.`,
  },
  {
    name: "throttle",
    retryable: true,
    when: ({ status, detail }) => status === 429 && RATE_LIMIT_WORDS.test(detail),
    message: () =>
      "Rate limited by Antigravity. Next: retrying automatically; if it persists, switch models.",
  },
  {
    name: "model-unavailable",
    when: ({ status }) => status === 429,
    message: ({ detail }) =>
      `This model is unavailable right now (${detail || "resource exhausted"}). Next: switch to gemini-3.8-flash or another Flash model. This is not necessarily an account quota wall.`,
  },
  {
    name: "server-error",
    retryable: true,
    when: ({ status }) => status === 500,
    message: () =>
      "Antigravity had an internal server error. Next: retry in a moment or switch models.",
  },
  {
    name: "bad-gateway",
    retryable: true,
    when: ({ status }) => status === 502,
    message: () => "Antigravity returned a bad gateway error. Next: retry in a moment.",
  },
  {
    name: "capacity-unavailable",
    retryable: true,
    when: ({ status, detail }) => status === 503 && /No capacity available/i.test(detail),
    message: () =>
      "This model has no capacity right now. Next: retry later or switch to another model.",
  },
  {
    name: "temporarily-unavailable",
    retryable: true,
    when: ({ status }) => status === 503,
    message: () =>
      "Antigravity is temporarily unavailable. Next: retry in a moment or switch models.",
  },
  {
    name: "upstream-timeout",
    retryable: true,
    when: ({ status }) => status === 504,
    message: () => "Antigravity timed out upstream. Next: retry in a moment.",
  },
  {
    name: "unclassified",
    when: () => true,
    message: ({ detail }) => detail,
  },
];

export function classifyAntigravityFailure(
  status: number | undefined,
  text: string,
): AntigravityFailure {
  const detail = redactSecrets(jsonOrTextError(text)).slice(0, 500);
  const input: FailureInput = {
    status,
    detail,
    resetHint: detail.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim() || undefined,
    verifyUrl: extractValidationUrl(text),
  };
  const rule = RULES.find((candidate) => candidate.when(input)) ?? RULES[RULES.length - 1];
  return {
    rule: rule.name,
    retryable: Boolean(rule.retryable),
    message: rule.message(input),
    ...input,
  };
}

/**
 * Rendered text for the user, and the retry signal for Pi. Status digits appear only
 * on retryable failures: Pi restarts a turn whose error text carries a 5xx or 429, so
 * adding them to a terminal failure would retry a dead model or a spent quota.
 */
export function renderAntigravityFailure(failure: AntigravityFailure): string {
  return failure.retryable && failure.status !== undefined
    ? `${failure.message} (${failure.status})`
    : failure.message;
}

export function describeAntigravityFailure(status: number | undefined, text: string): string {
  return renderAntigravityFailure(classifyAntigravityFailure(status, text));
}
