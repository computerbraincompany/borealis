import type { ConnectionCredentialState, ConnectionStatus } from "@/lib/api";

/**
 * Human labels and tones for the bounded connection lifecycle, keyed by the
 * server's stable `CONNECTION_*` status codes. Surfaces must render status
 * from here only — never hand-translate the status enum per screen (the
 * `sourceStatus.ts` rule, applied to connections).
 */

export type ConnectionTone = "neutral" | "positive" | "warning" | "negative";

export interface ConnectionStatusCopy {
  label: string;
  tone: ConnectionTone;
}

const STATUS_TONE_CLASS: Record<ConnectionTone, string> = {
  neutral: "border-border bg-secondary text-muted-foreground",
  positive: "border-success/30 bg-success/10 text-success",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  negative: "border-destructive/30 bg-destructive/10 text-destructive",
};

const STATUS_COPY: Record<ConnectionStatus, ConnectionStatusCopy> = {
  untested: { label: "Not tested yet", tone: "neutral" },
  ready: { label: "Ready", tone: "positive" },
  disconnected: { label: "Needs attention", tone: "warning" },
  error: { label: "Failing", tone: "negative" },
};

/** Stable server codes recorded on the connection row (never content). */
const STATUS_CODE_COPY: Record<string, ConnectionStatusCopy> = {
  CONNECTION_TIMEOUT: { label: "Timed out — check the endpoint", tone: "negative" },
  CONNECTION_HANDSHAKE_FAILED: { label: "Handshake failed", tone: "negative" },
  CONNECTION_TRANSPORT_UNAVAILABLE: { label: "Transport unavailable", tone: "negative" },
  CONNECTION_CUSTODY_UNAVAILABLE: { label: "Stored credentials unavailable", tone: "warning" },
  CONNECTION_AUTH_REQUIRED: { label: "Sign-in required", tone: "warning" },
  CONNECTION_AUTH_UNSUPPORTED: { label: "Sign-in not available", tone: "neutral" },
  CONNECTION_AUTH_DISCOVERY_FAILED: { label: "Sign-in server unreachable", tone: "warning" },
  CONNECTION_AUTH_REFRESH_FAILED: { label: "Sign-in could not renew — reauthorize", tone: "warning" },
  CONNECTION_AUTH_SESSION_EXPIRED: { label: "Sign-in expired — try again", tone: "warning" },
  CONNECTION_AUTH_DENIED: { label: "Sign-in declined", tone: "warning" },
  CONNECTION_AUTH_REPLAY_DETECTED: { label: "Sign-in link reused", tone: "warning" },
  CONNECTION_AUTH_FAILED: { label: "Sign-in failed", tone: "negative" },
  CONNECTION_DISCOVERY_OVER_LIMIT: { label: "Too many tools to publish", tone: "negative" },
  CONNECTION_DISCOVERY_INVALID: { label: "Tool catalog invalid", tone: "negative" },
};

export function connectionStatusCopy(status: ConnectionStatus, statusCode: string | null): ConnectionStatusCopy {
  if (statusCode && STATUS_CODE_COPY[statusCode]) return STATUS_CODE_COPY[statusCode];
  return STATUS_COPY[status] ?? STATUS_COPY.untested;
}

export function connectionToneClass(tone: ConnectionTone): string {
  return STATUS_TONE_CLASS[tone];
}

export function connectionCredentialCopy(state: ConnectionCredentialState): string {
  if (state === "stored") return "Stored securely — never shown again";
  if (state === "unavailable") return "Stored credentials unavailable — restore custody or re-enter them";
  return "No credentials stored";
}

/** Server codes that end a pending sign-in as a failure (observable on the row). */
const AUTH_TERMINAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "CONNECTION_AUTH_SESSION_EXPIRED",
  "CONNECTION_AUTH_DENIED",
  "CONNECTION_AUTH_REPLAY_DETECTED",
  "CONNECTION_AUTH_FAILED",
  "CONNECTION_AUTH_REFRESH_FAILED",
  "CONNECTION_AUTH_REQUIRED",
]);

export function isAuthTerminalFailureCode(code: string | null): boolean {
  return code !== null && AUTH_TERMINAL_FAILURE_CODES.has(code);
}

export interface AuthPollState {
  status: ConnectionStatus;
  statusCode: string | null;
  credentialState: ConnectionCredentialState;
}

/**
 * Terminal sign-in outcomes on the connection row, compared against the
 * baseline captured when the sign-in session started: a durable failure code
 * (denied/expired/replay/refresh) is a failure; a row that visibly moved to
 * a non-failure evidence state (ready, cleared untested, or credentials
 * stored) is a success; otherwise keep polling until the session expiry.
 * `null` = keep polling.
 */
export function authPollOutcome(
  current: AuthPollState,
  baseline: AuthPollState,
  expired: boolean,
): "success" | "failure" | null {
  const changed =
    current.status !== baseline.status ||
    current.statusCode !== baseline.statusCode ||
    current.credentialState !== baseline.credentialState;
  // A failure code that is not new evidence (the pre-existing
  // sign-in-required baseline itself) is not an outcome yet.
  if (changed && isAuthTerminalFailureCode(current.statusCode)) return "failure";
  if (
    changed &&
    (current.status === "ready" || current.status === "untested" || current.credentialState === "stored")
  ) {
    return "success";
  }
  if (expired) return "failure";
  return null;
}
