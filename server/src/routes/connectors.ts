import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import {
  SourceIngestionTransitionError,
  type ReservedConnectorPrepare,
} from "../db/stores/sourceIngestionTransitions.js";
import { SourceStoreError, type ConnectorRecord } from "../db/stores/sourceStore.js";
import { DataServiceError, dataService } from "../dataService.js";
import { wakeConnectorPrepareWorkers, wakeIngestionWorkers } from "../ingest.js";
import { completeSourceDeleteIntents } from "../sourceCleanup.js";
import { SourceScopeError } from "../sourceScope.js";
import { enforceRemoteEgressConsent } from "../egressPolicy.js";
import { auditRemoteEgress } from "../egressAudit.js";
import { storageRuntime } from "../storageRuntime.js";
import { connectorBodySchema, idParamsSchema } from "./schemas.js";

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/connectors", { preHandler: requireAuth }, async (req, reply) => {
    const connectors = await storageRuntime().sources.listConnectors(getAccountId(req));
    return reply.send(connectors.map(connectorToApi));
  });

  app.post(
    "/api/connectors",
    { preHandler: requireAuth, bodyLimit: 8 * 1024, schema: { body: connectorBodySchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      if (!(await enforceRemoteEgressConsent(reply, accountId))) return;
      void auditRemoteEgress("remote_ingest", accountId);
      let parsed: ReturnType<typeof parseConnectorBody>;
      try {
        parsed = parseConnectorBody(req.body);
      } catch (error) {
        return sendValidationError(reply, error);
      }
      const refreshVersion = randomUUID();
      const leaseToken = randomUUID();
      let reservation: ReservedConnectorPrepare;
      try {
        reservation = await storageRuntime().sourceIngestion.createConnectorPrepare(accountId, {
          connectorId: randomUUID(),
          sourceId: randomUUID(),
          displayName: parsed.displayName,
          targetTable: parsed.targetTable,
          type: parsed.type,
          url: parsed.url,
          refreshVersion,
          leaseToken,
        });
      } catch (error) {
        return sendConnectorError(reply, error);
      }
      try {
        await syncConnector(accountId, reservation);
      } catch {
        const failed = await storageRuntime().sources.getConnector(accountId, reservation.connector.id);
        return reply.code(422).send({
          ...connectorToApi(failed ?? reservation.connector),
          sync_error: "Connector sync failed.",
        });
      }
      const synced = await storageRuntime().sources.getConnector(accountId, reservation.connector.id);
      return reply.send(connectorToApi(synced ?? reservation.connector));
    }
  );

  app.post(
    "/api/connectors/:id/sync",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      if (!(await enforceRemoteEgressConsent(reply, accountId))) return;
      void auditRemoteEgress("remote_ingest", accountId);
      const connectorId = (req.params as { id: string }).id;
      const connector = await storageRuntime().sources.getConnector(accountId, connectorId);
      if (!connector) return reply.code(404).send({ error: "connector not found" });
      if (connector.syncStatus === "syncing" || connector.syncStatus === "indexing") {
        return reply.code(409).send({ error: "connector sync already active" });
      }
      try {
        return reply.send(await syncConnector(accountId, undefined, connectorId));
      } catch (error) {
        if (error instanceof SourceScopeError) return sendValidationError(reply, error);
        return reply.code(422).send({ error: "Connector sync failed." });
      }
    }
  );

  app.delete(
    "/api/connectors/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        const deletion = await storageRuntime().sources.deleteConnector(
          getAccountId(req),
          (req.params as { id: string }).id
        );
        await completeSourceDeleteIntents(deletion.intents);
        return reply.send({ ok: true });
      } catch (error) {
        return sendConnectorError(reply, error);
      }
    }
  );
}

function parseConnectorBody(body: unknown): {
  displayName: string;
  targetTable: string;
  type: "url_csv" | "url_json";
  url: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SourceScopeError(400, "invalid connector body");
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(["display_name", "target_table", "type", "config"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new SourceScopeError(400, "invalid connector body");
  }
  const displayName = typeof record.display_name === "string" ? record.display_name.trim() : "";
  const targetTable = typeof record.target_table === "string" ? record.target_table.trim().toLowerCase() : "";
  if (Array.from(displayName).length < 1 || Array.from(displayName).length > 120) {
    throw new SourceScopeError(400, "display_name must contain between 1 and 120 characters");
  }
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(targetTable)) {
    throw new SourceScopeError(
      400,
      "target_table must start with a letter and contain only letters, digits, and underscores"
    );
  }
  if (record.type !== "url_csv" && record.type !== "url_json") {
    throw new SourceScopeError(400, "unsupported connector type");
  }
  const connectorConfig = record.config;
  if (!connectorConfig || typeof connectorConfig !== "object" || Array.isArray(connectorConfig)) {
    throw new SourceScopeError(400, "config.url required");
  }
  const configRecord = connectorConfig as Record<string, unknown>;
  if (Object.keys(configRecord).some((key) => key !== "url") || typeof configRecord.url !== "string") {
    throw new SourceScopeError(400, "config.url required");
  }
  let url: URL;
  try {
    url = new URL(configRecord.url);
  } catch {
    throw new SourceScopeError(400, "config.url must be an HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.toString().length > 2_000) {
    throw new SourceScopeError(400, "config.url must be an HTTP(S) URL");
  }
  url.hash = "";
  return { displayName, targetTable, type: record.type, url: url.toString() };
}

function sendValidationError(reply: FastifyReply, error: unknown) {
  if (error instanceof SourceScopeError) return reply.code(error.statusCode).send({ error: error.message });
  throw error;
}

function sendConnectorError(reply: FastifyReply, error: unknown) {
  const code =
    error instanceof SourceStoreError || error instanceof SourceIngestionTransitionError ? error.code : undefined;
  if (code === "SOURCE_STORE_CONNECTOR_NOT_FOUND" || code === "SOURCE_TRANSITION_CONNECTOR_NOT_FOUND") {
    return reply.code(404).send({ error: "connector not found" });
  }
  if (code === "SOURCE_STORE_SOURCE_IN_USE" || code === "SOURCE_TRANSITION_SOURCE_IN_USE") {
    return reply.code(409).send({ error: "source is in use by an active run" });
  }
  if (code === "SOURCE_STORE_CONNECTOR_SYNC_ACTIVE" || code === "SOURCE_TRANSITION_CONNECTOR_SYNC_ACTIVE") {
    return reply.code(409).send({ error: "connector sync is active" });
  }
  if (code === "SOURCE_TRANSITION_TARGET_CONFLICT" || code === "SOURCE_STORE_CONNECTOR_TARGET_CONFLICT") {
    return reply.code(409).send({ error: "target_table is already in use" });
  }
  throw error;
}

async function syncConnector(
  accountId: string,
  initialReservation?: ReservedConnectorPrepare,
  connectorId?: string
): Promise<{ synced: true; processing: true }> {
  let reservation = initialReservation;
  let expectedFormat: "csv" | "json" = "csv";
  let prepareStarted = false;
  try {
    if (!reservation) {
      reservation = await storageRuntime().sourceIngestion.beginConnectorRefresh({
        accountId,
        connectorId: connectorId ?? "",
        refreshVersion: randomUUID(),
        leaseToken: randomUUID(),
      });
    }
    const connector = reservation.connector;
    const config = connectorConfig(connector.config);
    expectedFormat = connector.type === "url_json" ? "json" : "csv";
    prepareStarted = true;
    const dataset = await dataService.prepareDatasetRefresh(
      accountId,
      connector.targetTable,
      reservation.refreshVersion,
      config.url,
      connector.name,
      expectedFormat
    );
    if (dataset?.version !== reservation.refreshVersion || typeof dataset?.location !== "string" || !dataset.location) {
      throw new Error("connector returned an invalid prepared artifact");
    }
    const activationPreviousLocation =
      typeof dataset.previous_location === "string" && dataset.previous_location ? dataset.previous_location : null;
    const cleanupPreviousLocation =
      reservation.source.filePath && reservation.source.filePath !== dataset.location
        ? reservation.source.filePath
        : activationPreviousLocation;
    await storageRuntime().sourceIngestion.activatePreparedConnector({
      accountId,
      connectorId: connector.id,
      sourceId: reservation.source.id,
      generation: reservation.generation,
      leaseToken: reservation.leaseToken,
      refreshVersion: reservation.refreshVersion,
      url: config.url,
      displayName: connector.name,
      mime: connector.type === "url_json" ? "application/json" : "text/csv",
      candidateLocation: dataset.location,
      activationPreviousLocation,
      cleanupPreviousLocation,
    });
    wakeIngestionWorkers();
    return { synced: true, processing: true };
  } catch (error) {
    if (!reservation) {
      if (
        error instanceof SourceIngestionTransitionError &&
        (error.code === "SOURCE_TRANSITION_CONNECTOR_SYNC_ACTIVE" || error.code === "SOURCE_TRANSITION_SOURCE_IN_USE")
      ) {
        throw new SourceScopeError(409, error.message);
      }
      if (connectorId) {
        await storageRuntime()
          .sources.updateConnectorSyncState(accountId, connectorId, {
            status: "error",
            syncError: "Connector sync failed.",
            expectedStatuses: ["idle", "error"],
          })
          .catch(() => {});
      }
      throw error;
    }
    let abortConfirmed = !prepareStarted;
    if (prepareStarted) {
      abortConfirmed = await dataService
        .abortDatasetRefresh(accountId, reservation.connector.targetTable, reservation.refreshVersion, expectedFormat)
        .then(() => true)
        .catch(() => false);
    }
    const transient =
      !abortConfirmed || (error instanceof DataServiceError && (error.status === 429 || error.status >= 500));
    if (transient) {
      await storageRuntime()
        .sourceIngestion.deferConnectorPrepare({
          accountId,
          sourceId: reservation.source.id,
          generation: reservation.generation,
          leaseToken: reservation.leaseToken,
        })
        .catch(() => false);
      wakeConnectorPrepareWorkers();
      throw error;
    }
    await storageRuntime()
      .sourceIngestion.failConnectorPrepare({
        accountId,
        connectorId: reservation.connector.id,
        sourceId: reservation.source.id,
        generation: reservation.generation,
        leaseToken: reservation.leaseToken,
        errorCode: "PREPARE_FAILED",
      })
      .catch(() => false);
    throw error;
  }
}

function connectorConfig(value: unknown): { url: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("connector config is invalid");
  const url = (value as Record<string, unknown>).url;
  if (typeof url !== "string" || !url) throw new Error("connector config is invalid");
  return { url };
}

function connectorToApi(connector: ConnectorRecord): Record<string, unknown> {
  return {
    id: connector.id,
    account_id: connector.accountId,
    name: connector.name,
    type: connector.type,
    config: connector.config,
    target_table: connector.targetTable,
    last_sync: connector.lastSync,
    sync_status: connector.syncStatus,
    sync_error: connector.syncError,
    created_at: connector.createdAt,
  };
}
