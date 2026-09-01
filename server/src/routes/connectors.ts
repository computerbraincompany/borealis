import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { embeddingMigrationCoordinator, EmbeddingMigrationError } from "../embeddingMigration.js";
import { catalogPageQuerySchema, catalogResponse, parseCatalogPageQuery } from "../catalogPagination.js";
import {
  SourceIngestionTransitionError,
  type ReservedConnectorPrepare,
} from "../db/stores/sourceIngestionTransitions.js";
import { SourceStoreError, type ConnectorRecord } from "../db/stores/sourceStore.js";
import { AutomationValidationError, AUTOMATION_NAME_MAX, type Automation } from "../automationStore.js";
import { listConnectorSyncs, recordConnectorSync } from "../connectorSyncHistory.js";
import { DataServiceError, dataService } from "../dataService.js";
import { wakeConnectorPrepareWorkers, wakeIngestionWorkers } from "../ingest.js";
import { completeSourceDeleteIntents } from "../sourceCleanup.js";
import { SourceScopeError } from "../sourceScope.js";
import { enforceRemoteEgressConsent } from "../egressPolicy.js";
import { auditRemoteEgress } from "../egressAudit.js";
import { storageRuntime } from "../storageRuntime.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  CONNECTOR_JSON_BODY_LIMIT_BYTES,
  IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";
import {
  CONNECTOR_DISPLAY_NAME_MAX_CHARS,
  CONNECTOR_TABLE_MAX_CHARS,
  CONNECTOR_URL_MAX_CHARS,
  catalogStatusBodySchema,
  connectorBodySchema,
  connectorScheduleBodySchema,
  idParamsSchema,
} from "./schemas.js";

const CONNECTOR_TABLE_PATTERN = new RegExp(`^[a-z][a-z0-9_]{0,${CONNECTOR_TABLE_MAX_CHARS - 1}}$`);

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/connectors",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const pageRequest = parseCatalogPageQuery("connectors", req.query);
      const accountId = getAccountId(req);
      const page = await storageRuntime().sources.listConnectors(accountId, pageRequest);
      const schedules = await storageRuntime().automations.listConnectorSyncsForTargets(
        accountId,
        page.items.map((connector) => connector.id)
      );
      const items = page.items.map((connector) => ({
        ...connectorToApi(connector),
        schedule: scheduleToApi(schedules.get(connector.id)),
      }));
      return reply.send(catalogResponse("connectors", { items, next: page.next }));
    }
  );

  app.post(
    "/api/connectors/status",
    {
      onRequest: requireAuth,
      bodyLimit: IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
      schema: { body: catalogStatusBodySchema },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const requestedIds = (req.body as { ids: string[] }).ids;
      const connectors = await storageRuntime().sources.getConnectorsByIds(accountId, requestedIds);
      const schedules = await storageRuntime().automations.listConnectorSyncsForTargets(
        accountId,
        connectors.map((connector) => connector.id)
      );
      const foundIds = new Set(connectors.map((connector) => connector.id));
      return reply.send({
        items: connectors.map((connector) => ({
          ...connectorToApi(connector),
          schedule: scheduleToApi(schedules.get(connector.id)),
        })),
        missing_ids: requestedIds.filter((id) => !foundIds.has(id)),
      });
    }
  );

  app.post(
    "/api/connectors",
    { onRequest: requireAuth, bodyLimit: CONNECTOR_JSON_BODY_LIMIT_BYTES, schema: { body: connectorBodySchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      try {
        await embeddingMigrationCoordinator().assertSourceMutationAllowed();
      } catch (error) {
        return sendConnectorError(reply, error);
      }
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
      let reservation: ReservedConnectorPrepare | undefined;
      const syncStartedAt = new Date().toISOString();
      try {
        await embeddingMigrationCoordinator().runSourceMutation(async () => {
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
          await syncConnectorUnlocked(accountId, reservation);
        });
      } catch (error) {
        if (error instanceof EmbeddingMigrationError || !reservation) return sendConnectorError(reply, error);
        await recordConnectorSync({
          accountId,
          connectorId: reservation.connector.id,
          trigger: "create",
          outcome: "failed",
          startedAt: syncStartedAt,
        });
        const failed = await storageRuntime().sources.getConnector(accountId, reservation.connector.id);
        const payload = await connectorToApiWithSchedule(accountId, failed ?? reservation.connector);
        return reply.code(422).send({ ...payload, sync_error: "Connector sync failed." });
      }
      if (!reservation) throw new Error("connector reservation was not created");
      await recordConnectorSync({
        accountId,
        connectorId: reservation.connector.id,
        trigger: "create",
        outcome: "succeeded",
        startedAt: syncStartedAt,
      });
      const synced = await storageRuntime().sources.getConnector(accountId, reservation.connector.id);
      return reply.send(await connectorToApiWithSchedule(accountId, synced ?? reservation.connector));
    }
  );

  app.post(
    "/api/connectors/:id/sync",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      if (!(await enforceRemoteEgressConsent(reply, accountId))) return;
      void auditRemoteEgress("remote_ingest", accountId);
      const connectorId = (req.params as { id: string }).id;
      const connector = await storageRuntime().sources.getConnector(accountId, connectorId);
      if (!connector) return reply.code(404).send({ error: "connector not found" });
      const syncStartedAt = new Date().toISOString();
      if (connector.syncStatus === "syncing" || connector.syncStatus === "indexing") {
        await recordConnectorSync({
          accountId,
          connectorId,
          trigger: "manual",
          outcome: "skipped",
          detail: "a sync was already active",
          startedAt: syncStartedAt,
        });
        return reply.code(409).send({ error: "connector sync already active" });
      }
      try {
        const result = await syncConnector(accountId, undefined, connectorId);
        await recordConnectorSync({
          accountId,
          connectorId,
          trigger: "manual",
          outcome: "succeeded",
          startedAt: syncStartedAt,
        });
        return reply.send(result);
      } catch (error) {
        if (error instanceof EmbeddingMigrationError) return sendConnectorError(reply, error);
        if (error instanceof SourceScopeError) {
          // A 409 scope error is the "already active" case; everything else is
          // a plain failure. Transition messages are generic and content-free.
          await recordConnectorSync({
            accountId,
            connectorId,
            trigger: "manual",
            outcome: error.statusCode === 409 ? "skipped" : "failed",
            detail: error.statusCode === 409 ? error.message : null,
            startedAt: syncStartedAt,
          });
          return sendValidationError(reply, error);
        }
        await recordConnectorSync({
          accountId,
          connectorId,
          trigger: "manual",
          outcome: "failed",
          startedAt: syncStartedAt,
        });
        return reply.code(422).send({ error: "Connector sync failed." });
      }
    }
  );

  app.get(
    "/api/connectors/:id/syncs",
    {
      onRequest: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
        },
      },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const connectorId = (req.params as { id: string }).id;
      const connector = await storageRuntime().sources.getConnector(accountId, connectorId);
      if (!connector) return reply.code(404).send({ error: "connector not found" });
      const query = (req.query as { limit?: unknown }) ?? {};
      const limit = typeof query.limit === "number" ? query.limit : 20;
      return reply.send(await listConnectorSyncs(accountId, connectorId, limit));
    }
  );

  app.put(
    "/api/connectors/:id/schedule",
    {
      onRequest: requireAuth,
      bodyLimit: 1024,
      schema: { params: idParamsSchema, body: connectorScheduleBodySchema },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      // A schedule is a standing promise of egress-capable work, so it sits
      // behind the same remote-egress consent gate as sync.
      if (!(await enforceRemoteEgressConsent(reply, accountId))) return;
      void auditRemoteEgress("remote_ingest", accountId);
      const connectorId = (req.params as { id: string }).id;
      const connector = await storageRuntime().sources.getConnector(accountId, connectorId);
      if (!connector) return reply.code(404).send({ error: "connector not found" });
      const { schedule_minutes: scheduleMinutes } = req.body as { schedule_minutes: number | null };
      const linked = (await storageRuntime().automations.listConnectorSyncsForTargets(accountId, [connectorId])).get(
        connectorId
      );
      if (linked && linked.length > 1) {
        return reply.code(409).send({
          error: "multiple connector_sync automations target this connector; clean up in Automations",
        });
      }
      try {
        if (scheduleMinutes === null) {
          // Idempotent removal; unscheduled connectors simply stay unscheduled.
          if (linked?.length === 1) await storageRuntime().automations.delete(accountId, linked[0].id);
        } else if (linked?.length === 1) {
          // Interval change only; next_run_at stays as the scheduler claimed it,
          // matching PATCH /api/automations semantics.
          await storageRuntime().automations.update(accountId, linked[0].id, { scheduleMinutes });
        } else {
          await createConnectorScheduleAutomation(accountId, connector, scheduleMinutes);
        }
      } catch (error) {
        if (sendAutomationError(reply, error)) return;
        throw error;
      }
      return reply.send(await connectorToApiWithSchedule(accountId, connector));
    }
  );

  app.delete(
    "/api/connectors/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const connectorId = (req.params as { id: string }).id;
      try {
        await embeddingMigrationCoordinator().runSourceMutation(async () => {
          const deletion = await storageRuntime().sources.deleteConnector(accountId, connectorId);
          await completeSourceDeleteIntents(deletion.intents);
        });
        // M09 teardown: the connector's derived schedule automations go with it
        // (runs and sync history cascade through their foreign keys). Best
        // effort and idempotent — connector deletion never fails or leaves a
        // dangling schedule because this cleanup stumbled.
        await storageRuntime()
          .automations.deleteConnectorAutomations(accountId, connectorId)
          .catch(() => {});
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
  if (Array.from(displayName).length < 1 || Array.from(displayName).length > CONNECTOR_DISPLAY_NAME_MAX_CHARS) {
    throw new SourceScopeError(400, "display_name must contain between 1 and 120 characters");
  }
  if (!CONNECTOR_TABLE_PATTERN.test(targetTable)) {
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
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.toString().length > CONNECTOR_URL_MAX_CHARS
  ) {
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
  if (error instanceof EmbeddingMigrationError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }
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

export async function syncConnector(
  accountId: string,
  initialReservation?: ReservedConnectorPrepare,
  connectorId?: string
): Promise<{ synced: true; processing: true }> {
  return embeddingMigrationCoordinator().runSourceMutation(() =>
    syncConnectorUnlocked(accountId, initialReservation, connectorId)
  );
}

async function syncConnectorUnlocked(
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

function sendAutomationError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof AutomationValidationError) {
    reply.code(400).send({ error: error.message });
    return true;
  }
  return false;
}

function scheduleToApi(automations: Automation[] | undefined): Record<string, unknown> | null {
  // The schedule is derived from the connector's connector_sync automation.
  // With legacy duplicates this surface reports unscheduled rather than
  // guessing; PUT /schedule answers 409 so the user cleans up in Automations.
  if (!automations || automations.length !== 1) return null;
  const automation = automations[0];
  return {
    automation_id: automation.id,
    schedule_minutes: automation.schedule_minutes,
    state: automation.state,
    next_run_at: automation.next_run_at,
    last_run_at: automation.last_run_at,
  };
}

async function connectorToApiWithSchedule(
  accountId: string,
  connector: ConnectorRecord
): Promise<Record<string, unknown>> {
  const schedules = await storageRuntime().automations.listConnectorSyncsForTargets(accountId, [connector.id]);
  return { ...connectorToApi(connector), schedule: scheduleToApi(schedules.get(connector.id)) };
}

/**
 * Creates the connector_sync automation behind a connector schedule. The name
 * is derived from the connector; on a collision with an unrelated automation a
 * numeric suffix is applied (bounded retries) so a name clash never blocks
 * scheduling. Other validation errors surface unchanged.
 */
async function createConnectorScheduleAutomation(
  accountId: string,
  connector: ConnectorRecord,
  scheduleMinutes: number
): Promise<Automation> {
  const baseName = `Connector: ${connector.name}`.trim();
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = attempt === 0 ? baseName : scheduleAutomationNameCandidate(baseName, attempt);
    try {
      return await storageRuntime().automations.create({
        accountId,
        name: candidate,
        kind: "connector_sync",
        targetId: connector.id,
        scheduleMinutes,
      });
    } catch (error) {
      // With the connector verified, no linked automation, and the interval
      // already schema-validated, a validation error here is a name collision
      // (or a rare concurrent create, which the retry loop cannot fix and
      // re-surfaces below).
      if (!(error instanceof AutomationValidationError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function scheduleAutomationNameCandidate(baseName: string, attempt: number): string {
  const suffix = ` (${attempt + 1})`;
  const stem = Array.from(baseName)
    .slice(0, AUTOMATION_NAME_MAX - suffix.length)
    .join("")
    .trim();
  return `${stem || "connector"}${suffix}`;
}
