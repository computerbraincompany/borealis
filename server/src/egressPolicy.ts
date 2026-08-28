import type { FastifyReply } from "fastify";
import { getEffectiveLlmSettings } from "./runtimeSettings.js";
import { classifyProviderLocality } from "./workspaceStatus.js";
import { storageRuntime } from "./storageRuntime.js";

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
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

async function stateFor(accountId: string, acknowledgedAt: string | null): Promise<RemoteEgressState> {
  const settings = await getEffectiveLlmSettings();
  const required = isRemoteProvider(settings.llmBaseUrl);
  return {
    required,
    acknowledged_at: acknowledgedAt,
    endpoint_host: required ? endpointHost(settings.llmBaseUrl) : null,
  };
}

/** The consent-state view for the authenticated account. */
export async function remoteEgressState(accountId: string): Promise<RemoteEgressState> {
  const acknowledgedAt = await storageRuntime().chats.getRemoteEgressAckAt(accountId);
  return stateFor(accountId, acknowledgedAt);
}

/**
 * The fail-closed egress gate for payload-bearing routes. It throws only when a
 * remote provider is configured and this account has not acknowledged remote
 * egress; loopback and private-network providers never gate.
 */
export async function requireRemoteEgressConsent(accountId: string): Promise<void> {
  const state = await remoteEgressState(accountId);
  if (state.required && !state.acknowledged_at) throw new RemoteEgressConsentRequiredError();
}

/**
 * Route adapter for the gate: sends the stable 403 consent envelope and returns
 * false when the request must stop, true when the handler may proceed.
 */
export async function enforceRemoteEgressConsent(reply: FastifyReply, accountId: string): Promise<boolean> {
  try {
    await requireRemoteEgressConsent(accountId);
    return true;
  } catch (error) {
    if (error instanceof RemoteEgressConsentRequiredError) {
      void reply.code(403).send({ error: REMOTE_EGRESS_CONSENT_MESSAGE, code: REMOTE_EGRESS_CONSENT_CODE });
      return false;
    }
    throw error;
  }
}

export async function acknowledgeRemoteEgress(accountId: string): Promise<RemoteEgressState> {
  const acknowledgedAt = new Date().toISOString();
  await storageRuntime().chats.acknowledgeRemoteEgress(accountId, acknowledgedAt);
  return stateFor(accountId, acknowledgedAt);
}
