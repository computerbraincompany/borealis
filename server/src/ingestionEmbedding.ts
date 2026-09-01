import { endpointHost, isRemoteProvider, RemoteEgressConsentRequiredError } from "./egressPolicy.js";
import { recordEgressEvent } from "./egressAudit.js";
import { createEmbeddingExecutor } from "./llm.js";
import { getRuntimeSettings } from "./runtimeSettings.js";
import { storageRuntime } from "./storageRuntime.js";

export type IngestionEmbeddingSession = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;

/**
 * Authorize one durable ingestion job against one immutable provider snapshot.
 * Every batch in the returned session uses that exact client/model pair, so a
 * live Settings change cannot redirect already-authorized content elsewhere.
 */
export async function createAuthorizedIngestionEmbeddingSession(accountId: string): Promise<IngestionEmbeddingSession> {
  const snapshot = await getRuntimeSettings();
  if (isRemoteProvider(snapshot.settings.llmBaseUrl)) {
    const acknowledgedAt = await storageRuntime().chats.getRemoteEgressAckAt(accountId);
    if (!acknowledgedAt) throw new RemoteEgressConsentRequiredError();
    await recordEgressEvent("remote_ingest", accountId, endpointHost(snapshot.settings.llmBaseUrl));
  }
  return createEmbeddingExecutor(snapshot.settings, snapshot.settings.embedModel);
}
