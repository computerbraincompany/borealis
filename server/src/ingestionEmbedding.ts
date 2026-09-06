import { authorizeRemoteEgressTarget, remoteEgressTargetFromSnapshot } from "./egressPolicy.js";
import { recordEgressEvent } from "./egressAudit.js";
import { createEmbeddingExecutor } from "./llm.js";
import { getRuntimeSettings } from "./runtimeSettings.js";

export type IngestionEmbeddingSession = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;

/**
 * Authorize one durable ingestion job against one immutable provider snapshot
 * and its exact acknowledged origin. Exactly one runtime snapshot is read,
 * immediately before the job's first embedding transport: the captured target
 * is authorized for the owning account, the audit names that target's host,
 * and the executor is built from the same settings object. Every batch in the
 * returned session uses that exact client/model pair, so a live Settings
 * change cannot redirect already-authorized content elsewhere — later batches
 * never re-read Settings or re-authorize. A remote origin whose stored consent
 * pair does not name this exact canonical origin throws
 * RemoteEgressConsentRequiredError before any transport; the ingestion engine
 * maps it to the stable ingestion detail.
 */
export async function createAuthorizedIngestionEmbeddingSession(accountId: string): Promise<IngestionEmbeddingSession> {
  const snapshot = await getRuntimeSettings();
  const target = remoteEgressTargetFromSnapshot(snapshot);
  await authorizeRemoteEgressTarget(accountId, target);
  if (target.locality === "remote") {
    await recordEgressEvent("remote_ingest", accountId, target.host);
  }
  return createEmbeddingExecutor(snapshot.settings, snapshot.settings.embedModel);
}
