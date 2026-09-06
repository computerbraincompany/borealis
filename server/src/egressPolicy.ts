import type { FastifyReply } from "fastify";
import { getRuntimeSettings, type RuntimeSettingsSnapshot } from "./runtimeSettings.js";
import { classifyProviderLocality, type ProviderLocality } from "./workspaceStatus.js";
import { storageRuntime } from "./storageRuntime.js";

const MAX_EGRESS_HOST_CHARS = 255;

export const REMOTE_EGRESS_CONSENT_CODE = "REMOTE_EGRESS_CONSENT_REQUIRED";
export const REMOTE_EGRESS_CONSENT_MESSAGE =
  "Acknowledgment is required before this workspace sends data to a remote model provider.";

export interface RemoteEgressState {
  /** True iff the configured model provider is a remote (public) origin. */
  readonly required: boolean;
  readonly acknowledged_at: string | null;
  /** The configured origin host when remote; null for local/private providers. */
  readonly endpoint_host: string | null;
}

/**
 * An immutable, credential-free authorization target derived from exactly one
 * captured runtime snapshot. It carries only the snapshot revision, the
 * canonical bare provider origin, its locality, and the bounded destination
 * host. It never contains an API key, model list, prompt, or any content, and
 * it is never serialized into a public response or a log line.
 */
export interface RemoteEgressTarget {
  readonly revision: number;
  /** Canonical bare origin (the same `URL.origin` form durable consent stores). */
  readonly origin: string;
  readonly locality: ProviderLocality;
  /** Bounded destination host for content-free audit attribution; null when unparseable. */
  readonly host: string | null;
}

export class RemoteEgressConsentRequiredError extends Error {
  constructor() {
    super(REMOTE_EGRESS_CONSENT_MESSAGE);
    this.name = "RemoteEgressConsentRequiredError";
  }
}

export function isRemoteProvider(baseUrl: string): boolean {
  return classifyProviderLocality(baseUrl) === "remote";
}

export function endpointHost(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).host;
    return host ? host.slice(0, MAX_EGRESS_HOST_CHARS) : null;
  } catch {
    return null;
  }
}

/**
 * Derive the authorization target from one already-captured snapshot. The
 * effective endpoint is canonical by Settings validation, so the origin here
 * is exactly the form a durable acknowledgment may match.
 */
export function remoteEgressTargetFromSnapshot(snapshot: RuntimeSettingsSnapshot): RemoteEgressTarget {
  const origin = snapshot.settings.llmBaseUrl;
  return Object.freeze({
    revision: snapshot.revision,
    origin,
    locality: classifyProviderLocality(origin),
    host: endpointHost(origin),
  });
}

/**
 * The exact-target consent primitive for internal callers. It compares the
 * account's stored timestamp/origin pair against the already-captured
 * canonical origin and never fetches Settings, so an A-authorized operation
 * can neither be re-evaluated against a switched provider nor retargeted.
 * Loopback and private providers never gate.
 */
export async function authorizeRemoteEgressTarget(
  accountId: string,
  target: RemoteEgressTarget
): Promise<RemoteEgressTarget> {
  if (target.locality !== "remote") return target;
  const stored = await storageRuntime().chats.getRemoteEgressAcknowledgment(accountId);
  if (stored.acknowledgedAt !== null && stored.origin === target.origin) return target;
  throw new RemoteEgressConsentRequiredError();
}

/** Capture one snapshot, derive its target, and authorize it for the account. */
export async function authorizeRemoteEgressOperation(accountId: string): Promise<RemoteEgressTarget> {
  return authorizeRemoteEgressTarget(accountId, remoteEgressTargetFromSnapshot(await getRuntimeSettings()));
}

async function stateForTarget(accountId: string, target: RemoteEgressTarget): Promise<RemoteEgressState> {
  const required = target.locality === "remote";
  const stored = await storageRuntime().chats.getRemoteEgressAcknowledgment(accountId);
  const matched = stored.acknowledgedAt !== null && stored.origin === target.origin;
  return {
    required,
    // A remote provider shows a timestamp only when the stored pair names this
    // exact origin. Loopback/private keeps displaying the remembered timestamp
    // for compatibility; its stored origin is never returned.
    acknowledged_at: required ? (matched ? stored.acknowledgedAt : null) : stored.acknowledgedAt,
    endpoint_host: required ? target.host : null,
  };
}

/** The consent-state view for the authenticated account, from one snapshot. */
export async function remoteEgressState(accountId: string): Promise<RemoteEgressState> {
  return stateForTarget(accountId, remoteEgressTargetFromSnapshot(await getRuntimeSettings()));
}

/**
 * The fail-closed egress gate for payload-bearing routes. It throws only when
 * a remote provider is configured and this account has not acknowledged that
 * exact canonical origin; loopback and private-network providers never gate.
 */
export async function requireRemoteEgressConsent(accountId: string): Promise<void> {
  await authorizeRemoteEgressOperation(accountId);
}

/**
 * Route adapter for the gate: sends the stable 403 consent envelope and
 * returns null when the request must stop. On success it returns the exact
 * authorized target so associated audit records its host instead of resolving
 * live Settings again.
 */
export async function enforceRemoteEgressConsent(
  reply: FastifyReply,
  accountId: string
): Promise<RemoteEgressTarget | null> {
  try {
    return await authorizeRemoteEgressOperation(accountId);
  } catch (error) {
    if (error instanceof RemoteEgressConsentRequiredError) {
      void reply.code(403).send({ error: REMOTE_EGRESS_CONSENT_MESSAGE, code: REMOTE_EGRESS_CONSENT_CODE });
      return null;
    }
    throw error;
  }
}

export interface RemoteEgressAcknowledgmentResult {
  readonly state: RemoteEgressState;
  /** The host actually persisted by this acknowledgment, for one audit row; null when nothing was stored. */
  readonly auditHost: string | null;
}

/**
 * Acknowledgment is the one intentional multi-snapshot operation: capture
 * current effective Settings; local/private writes and audits nothing and
 * preserves the remembered pair; remote atomically persists this exact
 * timestamp/origin pair; re-read the public state so a concurrent switch is
 * visible; return the public state plus only the host actually persisted. If
 * Settings race from A to B after A is stored, the response describes
 * unacknowledged B, the durable pair remains A, and the single content-free
 * audit row names A.
 */
export async function acknowledgeRemoteEgress(accountId: string): Promise<RemoteEgressAcknowledgmentResult> {
  const target = remoteEgressTargetFromSnapshot(await getRuntimeSettings());
  if (target.locality !== "remote") {
    return { state: await stateForTarget(accountId, target), auditHost: null };
  }
  const acknowledgedAt = new Date().toISOString();
  await storageRuntime().chats.acknowledgeRemoteEgress(accountId, acknowledgedAt, target.origin);
  return { state: await remoteEgressState(accountId), auditHost: target.host };
}
