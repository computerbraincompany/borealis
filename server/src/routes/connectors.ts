import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getAccountId, requireAuth } from "../auth.js";
import { pool, q } from "../db.js";
import {
  processDatasetCacheCleanup,
  reserveDatasetCacheCleanup,
  wakeConnectorPrepareWorkers,
  wakeIngestionWorkers,
} from "../ingest.js";
import { py } from "../pythonClient.js";
import { PythonServiceError } from "../pythonClient.js";
import { SourceScopeError } from "../sourceScope.js";
import { sourceReferencedByActiveRun } from "../sourceMutationGuard.js";
import { connectorBodySchema, idParamsSchema } from "./schemas.js";

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/connectors", { preHandler: requireAuth }, async (req, reply) => {
    return reply.send(
      await q(`SELECT * FROM connectors WHERE account_id=$1 ORDER BY created_at DESC`, [getAccountId(req)])
    );
  });

  app.post(
    "/api/connectors",
    { preHandler: requireAuth, bodyLimit: 8 * 1024, schema: { body: connectorBodySchema } },
    async (req, reply) => {
      const account = getAccountId(req);
      let parsed: ReturnType<typeof parseConnectorBody>;
      try {
        parsed = parseConnectorBody(req.body);
      } catch (error) {
        return sendValidationError(reply, error);
      }
      const connectorId = randomUUID();
      const sourceId = randomUUID();
      const refreshVersion = randomUUID();
      const prepareLeaseToken = randomUUID();
      let connector: any;
      let reservedSource: any;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [account]);
        const collision = await client.query(`SELECT 1 FROM sources WHERE account_id=$1 AND name=$2`, [
          account,
          parsed.targetTable,
        ]);
        if (collision.rows.length) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "target_table is already in use" });
        }
        const inserted = await client.query(
          `INSERT INTO connectors
           (id, account_id, name, type, config, target_table, sync_status, sync_error)
         VALUES ($1,$2,$3,$4,$5,$6,'syncing',NULL) RETURNING *`,
          [
            connectorId,
            account,
            parsed.displayName,
            parsed.type,
            JSON.stringify({ url: parsed.url }),
            parsed.targetTable,
          ]
        );
        const insertedSource = await client.query(
          `INSERT INTO sources
           (id, account_id, name, kind, connector, display_name, url, mime, status, meta)
         VALUES ($1,$2,$3,'tabular',$4,$5,$6,$7,'index',
                 jsonb_build_object('connector_refresh_version',$8::text))
         RETURNING *`,
          [
            sourceId,
            account,
            parsed.targetTable,
            connectorId,
            parsed.displayName,
            parsed.url,
            parsed.type === "url_json" ? "application/json" : "text/csv",
            refreshVersion,
          ]
        );
        reservedSource = insertedSource.rows[0];
        await client.query(
          `INSERT INTO ingestion_jobs
             (source_id, account_id, generation, status, attempts, available_at, leased_at, lease_token, updated_at)
           VALUES ($1,$2,1,'preparing',1,now(),now(),$3,now())`,
          [sourceId, account, prepareLeaseToken]
        );
        await client.query("COMMIT");
        connector = inserted.rows[0];
      } catch (error: any) {
        await client.query("ROLLBACK").catch(() => {});
        if (error?.code === "23505") return reply.code(409).send({ error: "target_table is already in use" });
        throw error;
      } finally {
        client.release();
      }
      try {
        await syncConnector(account, connector, {
          source: reservedSource,
          refreshVersion,
          prepareLeaseToken,
        });
      } catch {
        const [failed] = await q(`SELECT * FROM connectors WHERE id=$1 AND account_id=$2`, [connectorId, account]);
        return reply.code(422).send({ ...(failed || connector), sync_error: "Connector sync failed." });
      }
      const [synced] = await q(`SELECT * FROM connectors WHERE id=$1 AND account_id=$2`, [connectorId, account]);
      return reply.send(synced || { ...connector, sync_status: "indexing" });
    }
  );

  app.post(
    "/api/connectors/:id/sync",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const account = getAccountId(req);
      const [connector] = await q(`SELECT * FROM connectors WHERE id=$1 AND account_id=$2`, [
        (req.params as any).id,
        account,
      ]);
      if (!connector) return reply.code(404).send({ error: "connector not found" });
      if (["syncing", "indexing"].includes(connector.sync_status)) {
        return reply.code(409).send({ error: "connector sync already active" });
      }
      try {
        return reply.send(await syncConnector(account, connector));
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
      const account = getAccountId(req);
      const id = (req.params as any).id;
      const client = await pool.connect();
      let connector: any;
      let paths: any[];
      try {
        await client.query("BEGIN");
        const selected = await client.query(`SELECT * FROM connectors WHERE id=$1 AND account_id=$2 FOR UPDATE`, [
          id,
          account,
        ]);
        connector = selected.rows[0];
        if (!connector) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "connector not found" });
        }
        if (["syncing", "indexing"].includes(connector.sync_status)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "connector sync is active" });
        }
        paths = (
          await client.query(
            `SELECT id, account_id, name, connector, file_path, meta FROM sources
             WHERE connector=$1 AND account_id=$2 FOR UPDATE`,
            [connector.id, account]
          )
        ).rows;
        for (const source of paths) {
          if (await sourceReferencedByActiveRun(client, account, source.id)) {
            await client.query("ROLLBACK");
            return reply.code(409).send({ error: "source is in use by an active run" });
          }
          const meta = source.meta && typeof source.meta === "object" ? source.meta : {};
          await reserveDatasetCacheCleanup(client, account, source.name, [
            source.file_path,
            typeof meta.connector_previous_location === "string" ? meta.connector_previous_location : "",
            typeof meta.connector_candidate_location === "string" ? meta.connector_candidate_location : "",
            typeof meta.connector_activation_previous_location === "string"
              ? meta.connector_activation_previous_location
              : "",
          ]);
        }
        await client.query(`DELETE FROM sources WHERE connector=$1 AND account_id=$2`, [connector.id, account]);
        await client.query(`DELETE FROM connectors WHERE id=$1 AND account_id=$2`, [connector.id, account]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      await processDatasetCacheCleanup(account, connector.target_table).catch(() => {});
      return reply.send({ ok: true });
    }
  );
}

function parseConnectorBody(body: unknown): {
  displayName: string;
  targetTable: string;
  type: "url_csv" | "url_json";
  url: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new SourceScopeError(400, "invalid connector body");
  const record = body as Record<string, unknown>;
  const allowed = new Set(["display_name", "target_table", "type", "config"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new SourceScopeError(400, "invalid connector body");
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

function sendValidationError(reply: any, error: unknown) {
  if (error instanceof SourceScopeError) return reply.code(error.statusCode).send({ error: error.message });
  throw error;
}

async function syncConnector(
  account: string,
  connector: any,
  reservation?: { source: any; refreshVersion: string; prepareLeaseToken: string }
): Promise<any> {
  let effective = connector;
  let source: any = reservation?.source;
  let configValue: any;
  let expectedFormat: "csv" | "json" = "csv";
  const refreshVersion = reservation?.refreshVersion ?? randomUUID();
  const prepareLeaseToken = reservation?.prepareLeaseToken ?? randomUUID();
  let preparedLocation = "";
  let prepared = false;
  let prepareStarted = false;
  try {
    if (!reservation) {
      const mutationClient = await pool.connect();
      let inTransaction = false;
      try {
        await mutationClient.query("BEGIN");
        inTransaction = true;
        const claimed = await mutationClient.query(
          `UPDATE connectors SET sync_status='syncing', sync_error=NULL
           WHERE id=$1 AND account_id=$2 AND sync_status NOT IN ('syncing','indexing')
           RETURNING *`,
          [connector.id, account]
        );
        if (!claimed.rows[0]) throw new SourceScopeError(409, "connector sync already active");
        effective = { ...connector, ...claimed.rows[0] };
        const selected = await mutationClient.query(
          `SELECT id, file_path, name, kind, status
         FROM sources WHERE account_id=$1 AND connector=$2 FOR UPDATE`,
          [account, effective.id]
        );
        source = selected.rows[0];
        if (!source) throw new Error("connector source reservation missing");
        if (await sourceReferencedByActiveRun(mutationClient, account, source.id)) {
          throw new SourceScopeError(409, "source is in use by an active run");
        }
        // Exclude this source from every newly accepted turn before Python can
        // switch its live registry. It becomes ready again only with atomic RAG
        // chunk promotion, preventing mixed new-SQL/old-retrieval turns.
        await mutationClient.query(
          `UPDATE sources
         SET status='index',
             meta=(meta - 'error' - 'connector_previous_location' - 'connector_candidate_location' -
                   'connector_activation_previous_location') ||
                  jsonb_build_object('connector_refresh_version',$3::text)
         WHERE id=$1 AND account_id=$2`,
          [source.id, account, refreshVersion]
        );
        await mutationClient.query(
          `INSERT INTO ingestion_jobs
           (source_id, account_id, generation, status, attempts, available_at, leased_at, lease_token, updated_at)
         VALUES ($1,$2,1,'preparing',1,now(),now(),$3,now())
         ON CONFLICT (source_id) DO UPDATE
           SET generation=ingestion_jobs.generation+1, status='preparing', attempts=1,
               available_at=now(), leased_at=now(), lease_token=$3, last_error=NULL, updated_at=now()`,
          [source.id, account, prepareLeaseToken]
        );
        await mutationClient.query("COMMIT");
        inTransaction = false;
      } catch (error) {
        if (inTransaction) await mutationClient.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        mutationClient.release();
      }
    }
    configValue = typeof effective.config === "string" ? JSON.parse(effective.config) : effective.config;
    expectedFormat = effective.type === "url_json" ? "json" : "csv";
    prepareStarted = true;
    const dataset = await py.prepareDatasetRefresh(
      account,
      effective.target_table,
      refreshVersion,
      configValue.url,
      effective.name,
      expectedFormat
    );
    if (dataset?.version !== refreshVersion || typeof dataset?.location !== "string" || !dataset.location) {
      throw new Error("connector returned an invalid prepared artifact");
    }
    prepared = true;
    preparedLocation = dataset.location;
    const activationPreviousLocation =
      typeof dataset.previous_location === "string" && dataset.previous_location ? dataset.previous_location : null;
    const cleanupPreviousLocation =
      source.file_path && source.file_path !== preparedLocation ? source.file_path : activationPreviousLocation;
    await q(
      `WITH owned_job AS (
         UPDATE ingestion_jobs
         SET status='pending', available_at=now(), leased_at=NULL, lease_token=NULL, updated_at=now()
         WHERE source_id=$1 AND account_id=$2 AND status='preparing' AND lease_token=$11
         RETURNING source_id, account_id
       ), updated_source AS (
         UPDATE sources
         SET url=$3, display_name=$4, mime=$5, status='index',
             meta=(meta - 'error' - 'connector_previous_location' - 'connector_refresh_version' -
                   'connector_candidate_location' - 'connector_activation_previous_location') ||
               jsonb_build_object(
                 'connector_refresh_version',$6::text,
                 'connector_candidate_location',$7::text,
                 'connector_activation_previous_location',to_jsonb($8::text)
               ) ||
               CASE WHEN $9::text IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('connector_previous_location',$9::text) END
         FROM owned_job j
         WHERE sources.id=j.source_id AND sources.account_id=j.account_id
           AND sources.meta->>'connector_refresh_version'=$6
         RETURNING id, account_id
       )
       UPDATE connectors
       SET sync_status='indexing', sync_error=NULL
       WHERE id=$10 AND account_id=$2 AND sync_status='syncing'
         AND EXISTS (SELECT 1 FROM updated_source)
       RETURNING id`,
      [
        source.id,
        account,
        configValue.url,
        effective.name,
        effective.type === "url_json" ? "application/json" : "text/csv",
        refreshVersion,
        preparedLocation,
        activationPreviousLocation,
        cleanupPreviousLocation,
        effective.id,
        prepareLeaseToken,
      ]
    ).then((rows) => {
      if (!rows.length) throw new Error("connector promotion reservation lost");
    });
    wakeIngestionWorkers();
    return { synced: true, processing: true };
  } catch (error) {
    if (error instanceof SourceScopeError && error.statusCode === 409 && !prepared) {
      throw error;
    }
    let abortConfirmed = !prepareStarted;
    if (prepareStarted) {
      abortConfirmed = await py
        .abortDatasetRefresh(account, effective.target_table, refreshVersion, expectedFormat)
        .then(() => true)
        .catch(() => false);
    }
    const transientPrepareFailure =
      !abortConfirmed || (error instanceof PythonServiceError && (error.status === 429 || error.status >= 500));
    if (transientPrepareFailure) {
      // The exact version intent is already durable. A lost prepare response
      // is resumed idempotently by startup/periodic reconciliation.
      if (source) {
        await q(
          `UPDATE ingestion_jobs
           SET leased_at=NULL, lease_token=NULL, available_at=now()+interval '2 seconds',
               last_error='PREPARE_TRANSIENT', updated_at=now()
           WHERE source_id=$1 AND account_id=$2 AND status='preparing' AND lease_token=$3`,
          [source.id, account, prepareLeaseToken]
        ).catch(() => {});
        wakeConnectorPrepareWorkers();
      }
      throw error;
    }
    if (source && abortConfirmed) {
      await q(
        `WITH failed_job AS (
           UPDATE ingestion_jobs
           SET status='error', leased_at=NULL, lease_token=NULL,
               last_error='PREPARE_FAILED', updated_at=now()
           WHERE source_id=$1 AND account_id=$2 AND status='preparing' AND lease_token=$3
           RETURNING source_id, account_id
         ), restored_source AS (
           UPDATE sources s
           SET status=CASE WHEN s.file_path IS NOT NULL AND EXISTS (
                        SELECT 1 FROM chunks c WHERE c.source_id=s.id
                      ) THEN 'ready' ELSE 'error' END,
               meta=(meta - 'connector_refresh_version' - 'connector_candidate_location' -
                     'connector_activation_previous_location' - 'connector_previous_location' - 'error') ||
                    CASE WHEN s.file_path IS NOT NULL AND EXISTS (
                           SELECT 1 FROM chunks c WHERE c.source_id=s.id
                         ) THEN '{}'::jsonb
                         ELSE jsonb_build_object('error','Connector sync failed.') END
           FROM failed_job j
           WHERE s.id=j.source_id AND s.account_id=j.account_id
           RETURNING s.connector, s.account_id
         )
         UPDATE connectors c SET sync_status='error', sync_error='Connector sync failed.'
         FROM restored_source s
         WHERE c.id=s.connector AND c.account_id=s.account_id
         RETURNING c.id`,
        [source.id, account, prepareLeaseToken]
      ).catch(() => {});
    } else if (abortConfirmed) {
      await q(
        `UPDATE connectors SET sync_status='error', sync_error='Connector sync failed.' WHERE id=$1 AND account_id=$2`,
        [effective.id, account]
      ).catch(() => {});
    }
    const remaining = await q(`SELECT id FROM sources WHERE account_id=$1 AND connector=$2`, [
      account,
      effective.id,
    ]).catch(() => []);
    if (!remaining.length && preparedLocation) {
      await py.abortDatasetRefresh(account, effective.target_table, refreshVersion, expectedFormat).catch(() => {});
    }
    throw error;
  }
}
