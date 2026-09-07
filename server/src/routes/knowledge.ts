import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { catalogPageQuerySchema, catalogResponse, parseCatalogPageQuery } from "../catalogPagination.js";
import { connectionSecretStore } from "../connections/service.js";
import { DesktopFolderGrantUnavailableError } from "../knowledge/grants.js";
import { createDesktopFolderConnection, desktopFolderKnowledgeAdapter } from "../knowledge/folder.js";
import { WEBDAV_APPLICATION_PASSWORD_ENV_KEY, webDavKnowledgeAdapter } from "../knowledge/webdav.js";
import {
  KNOWLEDGE_REFRESH_ITEM_STATUSES,
  KnowledgeConnectionNotFoundError,
  KnowledgeConnectionRevisionConflictError,
  KnowledgeStore,
  MAX_KNOWLEDGE_CONNECTION_NAME_CHARS,
  MAX_MANAGED_ITEMS_PER_CONNECTION,
  MAX_PREVIEW_SCAN_ENTRIES,
  KnowledgeRefreshConflictError,
  type KnowledgeConnectionRecord,
  type KnowledgePreviewEntryRecord,
  type KnowledgePreviewRecord,
  type KnowledgeRefreshItemRecord,
  type KnowledgeRefreshRecord,
} from "../db/stores/knowledgeStore.js";
import {
  DEFAULT_KNOWLEDGE_SCAN_BOUNDS,
  knowledgeRefreshService,
  KnowledgeScanFailureError,
  registerKnowledgeTransportAdapter,
} from "../knowledgeRefresh.js";
import { KnowledgeWatchPump, type KnowledgeWatchTarget } from "../knowledgeWatch.js";
import { storageRuntime } from "../storageRuntime.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
  KNOWLEDGE_APPLY_JSON_BODY_LIMIT_BYTES,
  KNOWLEDGE_CONNECTION_JSON_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";
import { idParamsSchema } from "./schemas.js";
import { MAX_SECRET_VALUE_CHARS } from "../connections/secrets.js";

/**
 * Living-knowledge workflow routes (M14 stage 4).
 *
 * These are the typed surfaces over the knowledge ledger, the shared
 * `refreshAndWaitReady` service, and the stage-2 transports:
 *
 * - `POST/GET /api/knowledge-connections` — create (desktop folder strictly
 *   from a consumed native-picker grant; WebDAV from a validated form whose
 *   application password goes straight to the shared MCP-era custody) and
 *   the endpoint-bound keyset catalog (default 25, max 100).
 * - `PATCH /api/knowledge-connections/:id` — version-checked name/watch edit
 *   with optional credential replacement; `DELETE` cancels active work,
 *   removes the mapping/custody record/watch, and retains sources, library
 *   membership, and every artifact.
 * - `POST /api/knowledge-connections/:id/previews` — durable bounded scan
 *   through the transport adapter; returns the pending preview plus its run
 *   id immediately. `GET /api/knowledge-previews/:id` reads the exact-account
 *   diff; `POST /api/knowledge-previews/:id/apply` commits the selected
 *   entry tokens against the exact preview revision (stale 409, expired 410)
 *   and registers one durable `apply` refresh.
 * - `POST /api/knowledge-connections/:id/refreshes` starts a manual refresh
 *   (one active per connection, coalesced by the service);
 *   `GET /api/knowledge-connections/:id/refreshes` is the bounded history;
 *   `GET/DELETE /api/knowledge-refreshes/:id` is the exact-target status and
 *   the durable, idempotent cancellation request.
 *
 * DTOs are structurally incapable of carrying credentials or a desktop
 * folder's absolute root path: public fields name stable `KNOWLEDGE_*`
 * states only, and every failure is a stable code with a fixed generic
 * message — upstream detail, paths, and secret material never reach clients.
 *
 * The watch pump runs only in the trusted desktop composition
 * (`desktop: true` from server startup); browser mode persists the setting
 * but starts no background scan. All background drives are bound to a
 * per-app abort controller closed on `onClose`, so no work outlives shutdown.
 */

export interface KnowledgeRoutesOptions {
  /** Trusted desktop composition mode; the watch pump never starts without it. */
  readonly desktop?: boolean;
}

const UUID_JSON = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const GRANT_ID_JSON = "^[0-9a-f]{64}$";
const SELECTION_TOKEN_JSON = "^[0-9a-f]{64}$";
const KNOWLEDGE_WEBDAV_URL_MAX_CHARS = 2_000;
const KNOWLEDGE_WEBDAV_USERNAME_MAX_CHARS = 256;

/** Fixed public copy per stable code; upstream detail never reaches clients. */
const KNOWLEDGE_PUBLIC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  KNOWLEDGE_CONNECTION_CONFIG_INVALID: "knowledge connection configuration is invalid",
  KNOWLEDGE_CONNECTION_NAME_TAKEN: "a knowledge connection with this name already exists",
  KNOWLEDGE_CONNECTION_NOT_FOUND: "knowledge connection not found",
  KNOWLEDGE_CONNECTION_REVISION_CONFLICT: "the knowledge connection changed since it was loaded",
  KNOWLEDGE_ITEM_NOT_FOUND: "managed knowledge item not found",
  KNOWLEDGE_QUOTA_EXCEEDED: "the knowledge connection quota is reached",
  KNOWLEDGE_LIBRARY_UNAVAILABLE: "the target library is unavailable",
  KNOWLEDGE_LIBRARY_FULL: "the target library is full",
  KNOWLEDGE_SCAN_OVER_LIMIT: "the preview scan exceeded its recorded bounds",
  KNOWLEDGE_SCAN_LIMIT: "the preview scan exceeded its bounds",
  KNOWLEDGE_NAME_EXHAUSTED: "no source name is available for the managed import",
  KNOWLEDGE_PREVIEW_NOT_FOUND: "knowledge preview not found",
  KNOWLEDGE_PREVIEW_STALE: "the preview revision or a selected entry no longer matches the scan",
  KNOWLEDGE_PREVIEW_EXPIRED: "the knowledge preview expired",
  KNOWLEDGE_PREVIEW_SELECTION_INVALID: "the preview selection is invalid",
  KNOWLEDGE_REFRESH_ACTIVE: "a refresh is already active for this connection",
  KNOWLEDGE_REFRESH_NOT_FOUND: "knowledge refresh not found",
  DESKTOP_FOLDER_GRANT_INVALID: "the folder selection grant is missing, expired, or already used",
  KNOWLEDGE_TRANSPORT_UNAVAILABLE: "the knowledge transport is unavailable",
  KNOWLEDGE_UPSTREAM_UNAUTHORIZED: "the knowledge upstream rejected the stored credentials",
  KNOWLEDGE_CREDENTIALS_MISSING: "the connection has no stored credentials",
  KNOWLEDGE_UPSTREAM_REDIRECT_REFUSED: "the knowledge upstream issued a refused redirect",
  KNOWLEDGE_UPSTREAM_XML_INVALID: "the knowledge upstream returned invalid metadata",
  KNOWLEDGE_UPSTREAM_NOT_FOUND: "the knowledge upstream path does not exist",
  KNOWLEDGE_UPSTREAM_UNAVAILABLE: "the knowledge upstream is unavailable",
  KNOWLEDGE_UPSTREAM_TIMEOUT: "the knowledge upstream request timed out",
  KNOWLEDGE_FOLDER_UNAVAILABLE: "the granted folder is unavailable",
  KNOWLEDGE_FOLDER_RESELECT_REQUIRED: "the granted folder must be selected again in the desktop app",
  KNOWLEDGE_FILE_TOO_LARGE: "a managed file exceeds the per-file upload budget",
  CONNECTION_CONFIG_INVALID: "connection credentials are invalid",
  CONNECTION_CUSTODY_UNAVAILABLE: "stored connection credentials are unavailable",
});

/** Status overrides for stable codes whose default error class status is wrong for HTTP. */
const KNOWLEDGE_STATUS_OVERRIDES: Readonly<Record<string, number>> = Object.freeze({
  KNOWLEDGE_SCAN_LIMIT: 413,
  KNOWLEDGE_FILE_TOO_LARGE: 413,
  KNOWLEDGE_UPSTREAM_TIMEOUT: 504,
  KNOWLEDGE_CREDENTIALS_MISSING: 409,
  KNOWLEDGE_UPSTREAM_NOT_FOUND: 404,
});

function sendKnowledgeError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof KnowledgeScanFailureError) {
    const message = KNOWLEDGE_PUBLIC_MESSAGES[error.code] ?? "the knowledge upstream operation failed";
    reply.code(KNOWLEDGE_STATUS_OVERRIDES[error.code] ?? 502).send({ error: message, code: error.code });
    return true;
  }
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof code !== "string") return false;
  if (!code.startsWith("KNOWLEDGE_") && !code.startsWith("DESKTOP_FOLDER_") && !code.startsWith("CONNECTION_")) {
    return false;
  }
  const status = typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599 ? statusCode : 400;
  reply
    .code(KNOWLEDGE_STATUS_OVERRIDES[code] ?? status)
    .send({ error: KNOWLEDGE_PUBLIC_MESSAGES[code] ?? "knowledge request failed", code });
  return true;
}

// ------------------------------------------------------------------ DTOs

function connectionToApi(connection: KnowledgeConnectionRecord): Record<string, unknown> {
  // Never `root_path`, never credential material: the folder DTO carries
  // only the picker's display label; the WebDAV DTO carries the non-secret
  // endpoint shape (the password lives only in shared custody).
  const base: Record<string, unknown> = {
    id: connection.id,
    name: connection.name,
    kind: connection.kind,
    library_id: connection.library_id,
    revision: connection.revision,
    watch_enabled: connection.watch_enabled,
    credential_configured: connection.credential_configured,
    status: connection.status,
    status_code: connection.status_code,
    created_at: connection.created_at,
    updated_at: connection.updated_at,
  };
  if (connection.kind === "desktop_folder") {
    base.label = connection.config.kind === "desktop_folder" ? connection.config.display_label : "";
  } else {
    base.label = connection.config.kind === "webdav" ? new URL(connection.config.url).hostname : "";
    base.webdav = connection.config.kind === "webdav" ? connection.config : null;
  }
  return base;
}

function previewToApi(preview: KnowledgePreviewRecord): Record<string, unknown> {
  return {
    id: preview.id,
    connection_id: preview.connection_id,
    revision: preview.revision,
    status: preview.status,
    error_code: preview.error_code,
    visited_entries: preview.visited_entries,
    directories: preview.directories,
    aggregate_bytes: preview.aggregate_bytes,
    new_count: preview.new_count,
    changed_count: preview.changed_count,
    unchanged_count: preview.unchanged_count,
    duplicate_count: preview.duplicate_count,
    missing_count: preview.missing_count,
    unsupported_count: preview.unsupported_count,
    skipped_count: preview.skipped_count,
    created_at: preview.created_at,
    updated_at: preview.updated_at,
    expires_at: preview.expires_at,
    applied_at: preview.applied_at,
  };
}

function previewEntryToApi(entry: KnowledgePreviewEntryRecord): Record<string, unknown> {
  return {
    entry_id: entry.entry_id,
    ordinal: entry.ordinal,
    relative_path: entry.relative_path,
    classification: entry.classification,
    content_hash: entry.content_hash,
    size_bytes: entry.size_bytes,
    existing_source_id: entry.existing_source_id,
    mtime_hint: entry.mtime_hint,
    etag_hint: entry.etag_hint,
    selection_token: entry.selection_token,
  };
}

function refreshToApi(refresh: KnowledgeRefreshRecord): Record<string, unknown> {
  return {
    id: refresh.id,
    connection_id: refresh.connection_id,
    requested_by: refresh.requested_by,
    expected_connection_revision: refresh.expected_connection_revision,
    status: refresh.status,
    cancel_requested: refresh.cancel_requested,
    error_code: refresh.error_code,
    created_at: refresh.created_at,
    started_at: refresh.started_at,
    finished_at: refresh.finished_at,
  };
}

function refreshItemToApi(item: KnowledgeRefreshItemRecord): Record<string, unknown> {
  return {
    item_id: item.item_id,
    source_id: item.source_id,
    relative_path: item.relative_path,
    status: item.status,
    error_code: item.error_code,
    current_ready_generation: item.current_ready_generation,
    expected_generation: item.expected_generation,
    promoted_generation: item.promoted_generation,
  };
}

function refreshCounts(items: readonly KnowledgeRefreshItemRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of KNOWLEDGE_REFRESH_ITEM_STATUSES) counts[status] = 0;
  for (const item of items) counts[item.status] += 1;
  return counts;
}

// ------------------------------------------------------------------ schemas

const knowledgeConnectionCreateBodySchema = {
  type: "object",
  required: ["name", "kind", "library_id"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: MAX_KNOWLEDGE_CONNECTION_NAME_CHARS, pattern: "\\S" },
    kind: { type: "string", enum: ["desktop_folder", "webdav"] },
    library_id: { type: "string", pattern: UUID_JSON },
    watch_enabled: { type: "boolean" },
    grant_id: { type: "string", pattern: GRANT_ID_JSON },
    config: {
      type: "object",
      required: ["url", "username", "password"],
      additionalProperties: false,
      properties: {
        url: { type: "string", minLength: 1, maxLength: KNOWLEDGE_WEBDAV_URL_MAX_CHARS },
        username: { type: "string", minLength: 1, maxLength: KNOWLEDGE_WEBDAV_USERNAME_MAX_CHARS },
        password: { type: "string", minLength: 1, maxLength: MAX_SECRET_VALUE_CHARS },
      },
    },
  },
} as const;

const knowledgeConnectionPatchBodySchema = {
  type: "object",
  required: ["expected_revision"],
  minProperties: 2,
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: MAX_KNOWLEDGE_CONNECTION_NAME_CHARS, pattern: "\\S" },
    watch_enabled: { type: "boolean" },
    // An object replaces the application password; null removes it.
    credentials: {
      oneOf: [
        {
          type: "object",
          required: ["password"],
          additionalProperties: false,
          properties: { password: { type: "string", minLength: 1, maxLength: MAX_SECRET_VALUE_CHARS } },
        },
        { type: "null" },
      ],
    },
    expected_revision: { type: "integer", minimum: 1, maximum: 9_007_199_254_740_991 },
  },
} as const;

const applyPreviewBodySchema = {
  type: "object",
  required: ["expected_revision", "selections"],
  additionalProperties: false,
  properties: {
    expected_revision: { type: "integer", minimum: 1, maximum: 9_007_199_254_740_991 },
    selections: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PREVIEW_SCAN_ENTRIES,
      items: {
        type: "object",
        required: ["entry_id", "selection_token"],
        additionalProperties: false,
        properties: {
          entry_id: { type: "string", pattern: UUID_JSON },
          selection_token: { type: "string", pattern: SELECTION_TOKEN_JSON },
        },
      },
    },
  },
} as const;

const refreshCreateBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    expected_connection_revision: { type: "integer", minimum: 1, maximum: 9_007_199_254_740_991 },
    item_ids: {
      type: "array",
      minItems: 1,
      maxItems: MAX_MANAGED_ITEMS_PER_CONNECTION,
      uniqueItems: true,
      items: { type: "string", pattern: UUID_JSON },
    },
  },
} as const;

// ------------------------------------------------------------------ plugin

export async function knowledgeRoutes(app: FastifyInstance, options: KnowledgeRoutesOptions = {}): Promise<void> {
  // Stage-4 composition point: register the real transports exactly once per
  // registration (the registry is a per-kind Map, so this is idempotent). A
  // service composed with an explicit `adapter` port (tests) never consults
  // the registry.
  registerKnowledgeTransportAdapter(desktopFolderKnowledgeAdapter);
  registerKnowledgeTransportAdapter(webDavKnowledgeAdapter);

  const store = (): KnowledgeStore => storageRuntime().knowledge;
  const desktop = options.desktop === true;
  // All background preview/refresh drives are bound to this controller and
  // are cut off when the app closes: no daemon runs after Borealis quits.
  const background = new AbortController();
  const backgroundWork = new Set<Promise<unknown>>();
  const trackBackground = (work: Promise<unknown>): void => {
    backgroundWork.add(work);
    void work.then(
      () => backgroundWork.delete(work),
      () => backgroundWork.delete(work)
    );
  };

  let pump: KnowledgeWatchPump | undefined;
  if (desktop) {
    pump = new KnowledgeWatchPump({
      listConnections: async (): Promise<readonly KnowledgeWatchTarget[]> =>
        (await store().listWatchEnabledConnections()).map((entry) => ({
          accountId: entry.accountId,
          connectionId: entry.connectionId,
        })),
      scan: async (target, signal) => {
        const ledger = store();
        const connection = await ledger.getConnection(target.accountId, target.connectionId);
        if (!connection || !connection.watch_enabled) return;
        // One durable scheduled refresh per pass; a competing active refresh
        // is coalesced by the shared service rather than competed with.
        try {
          await ledger.beginRefresh(target.accountId, {
            connection_id: connection.id,
            expected_connection_revision: connection.revision,
            requested_by: "scheduled",
          });
        } catch (error) {
          // A competing active refresh coalesces via the service below; a
          // concurrent revision edit means this pass is stale — skip it.
          if (
            !(error instanceof KnowledgeRefreshConflictError) &&
            !(error instanceof KnowledgeConnectionNotFoundError) &&
            !(error instanceof KnowledgeConnectionRevisionConflictError)
          ) {
            throw error;
          }
        }
        await knowledgeRefreshService().refreshAndWaitReady({
          accountId: target.accountId,
          connections: [
            {
              connection_id: connection.id,
              expected_connection_revision: connection.revision,
            },
          ],
          signal,
        });
      },
    });
    pump.start();
  }
  app.addHook("onClose", async () => {
    background.abort(new Error("knowledge routes closing"));
    // Abort-aware transports unwind before their durable status finalizers.
    // Keep stores open until those finalizers and watch passes have settled.
    await Promise.all([pump?.stop(), Promise.allSettled([...backgroundWork])]);
    pump = undefined;
  });

  // ------------------------------------------------------- connections

  app.post(
    "/api/knowledge-connections",
    {
      onRequest: requireAuth,
      bodyLimit: KNOWLEDGE_CONNECTION_JSON_BODY_LIMIT_BYTES,
      schema: { body: knowledgeConnectionCreateBodySchema },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const body = req.body as {
        name: string;
        kind: "desktop_folder" | "webdav";
        library_id: string;
        watch_enabled?: boolean;
        grant_id?: string;
        config?: { url: string; username: string; password: string };
      };
      try {
        if (body.kind === "desktop_folder") {
          // The ONLY path that may install a local root: a consumed grant.
          // No HTTP body may name an absolute path.
          if (typeof body.grant_id !== "string" || body.config !== undefined) {
            return reply.code(400).send({
              error: KNOWLEDGE_PUBLIC_MESSAGES.DESKTOP_FOLDER_GRANT_INVALID,
              code: "DESKTOP_FOLDER_GRANT_INVALID",
            });
          }
          const created = await createDesktopFolderConnection(store(), {
            accountId,
            grantId: body.grant_id,
            name: body.name,
            libraryId: body.library_id,
            watchEnabled: body.watch_enabled === true,
          });
          const connection = created.connection as KnowledgeConnectionRecord;
          return reply.code(201).send(connectionToApi(connection));
        }
        // WebDAV: the password crosses only from this body into shared
        // custody; the ledger row keeps the boolean evidence alone.
        if (body.grant_id !== undefined || !body.config) {
          return reply.code(400).send({
            error: KNOWLEDGE_PUBLIC_MESSAGES.KNOWLEDGE_CONNECTION_CONFIG_INVALID,
            code: "KNOWLEDGE_CONNECTION_CONFIG_INVALID",
          });
        }
        const connection = await store().createConnection(accountId, {
          name: body.name,
          kind: "webdav",
          config: { url: body.config.url, username: body.config.username },
          library_id: body.library_id,
          watch_enabled: body.watch_enabled,
        });
        try {
          await connectionSecretStore().put(accountId, connection.id, {
            headers: {},
            env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: body.config.password },
          });
          await store().setCredentialConfigured(accountId, connection.id, true);
        } catch (error) {
          // Compensation: a connection whose password could not reach
          // custody must not exist half-configured.
          await store()
            .deleteConnection(accountId, connection.id)
            .catch(() => false);
          throw error;
        }
        return reply.code(201).send(connectionToApi(connection));
      } catch (error) {
        if (error instanceof DesktopFolderGrantUnavailableError) {
          return reply
            .code(400)
            .send({ error: KNOWLEDGE_PUBLIC_MESSAGES.DESKTOP_FOLDER_GRANT_INVALID, code: error.code });
        }
        if (sendKnowledgeError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/knowledge-connections",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const query = (req.query ?? {}) as Record<string, unknown>;
      const page = parseCatalogPageQuery("knowledge_connections", req.query);
      const request = query.limit === undefined ? { ...page, limit: Math.min(page.limit, 25) } : page;
      const catalog = await store().listConnections(getAccountId(req), request);
      return reply.send(catalogResponse("knowledge_connections", catalogStorePageOf(catalog, connectionToApi)));
    }
  );

  app.patch(
    "/api/knowledge-connections/:id",
    {
      onRequest: requireAuth,
      bodyLimit: KNOWLEDGE_CONNECTION_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: knowledgeConnectionPatchBodySchema },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const connectionId = (req.params as { id: string }).id;
      const body = req.body as {
        name?: string;
        watch_enabled?: boolean;
        credentials?: { password: string } | null;
        expected_revision: number;
      };
      try {
        // Kind/credential-shape validation happens before any write so a
        // refused edit has no side effect.
        const before = await store().requireConnection(accountId, connectionId);
        if (body.credentials !== undefined && before.kind !== "webdav") {
          return reply.code(400).send({
            error: KNOWLEDGE_PUBLIC_MESSAGES.KNOWLEDGE_CONNECTION_CONFIG_INVALID,
            code: "KNOWLEDGE_CONNECTION_CONFIG_INVALID",
          });
        }
        await store().updateConnection(accountId, connectionId, {
          expected_revision: body.expected_revision,
          name: body.name,
          watch_enabled: body.watch_enabled,
        });
        if (body.credentials !== undefined) {
          // Credential edits apply only after the revision-checked edit
          // commits, so a stale edit never silently rewrites custody state.
          if (body.credentials === null) {
            await connectionSecretStore().remove(accountId, connectionId);
            await store().setCredentialConfigured(accountId, connectionId, false);
          } else {
            await connectionSecretStore().put(accountId, connectionId, {
              headers: {},
              env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: body.credentials.password },
            });
            await store().setCredentialConfigured(accountId, connectionId, true);
          }
        }
        const current = await store().requireConnection(accountId, connectionId);
        return reply.send(connectionToApi(current));
      } catch (error) {
        if (sendKnowledgeError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete(
    "/api/knowledge-connections/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const connectionId = (req.params as { id: string }).id;
      try {
        const ledger = store();
        const connection = await ledger.getConnection(accountId, connectionId);
        if (!connection)
          return reply.code(404).send({
            error: KNOWLEDGE_PUBLIC_MESSAGES.KNOWLEDGE_CONNECTION_NOT_FOUND,
            code: "KNOWLEDGE_CONNECTION_NOT_FOUND",
          });
        // Cancel in-flight durable work first (best effort — the cascade
        // below also strands any driver that races this delete).
        const active = await ledger.getActiveRefresh(accountId, connectionId);
        if (active) await ledger.requestRefreshCancellation(accountId, active.id).catch(() => false);
        const deleted = await ledger.deleteConnection(accountId, connectionId);
        if (!deleted) {
          return reply.code(404).send({
            error: KNOWLEDGE_PUBLIC_MESSAGES.KNOWLEDGE_CONNECTION_NOT_FOUND,
            code: "KNOWLEDGE_CONNECTION_NOT_FOUND",
          });
        }
        // Custody removal is post-commit best effort (same rule as the MCP
        // connection surface). Sources, library membership, and artifacts
        // are never touched here.
        await connectionSecretStore()
          .remove(accountId, connectionId)
          .catch(() => undefined);
        return reply.send({ ok: true });
      } catch (error) {
        if (sendKnowledgeError(reply, error)) return;
        throw error;
      }
    }
  );

  // ----------------------------------------------------------- previews

  app.post(
    "/api/knowledge-connections/:id/previews",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      try {
        const { preview, run } = await knowledgeRefreshService().beginPreview(
          accountId,
          (req.params as { id: string }).id,
          DEFAULT_KNOWLEDGE_SCAN_BOUNDS,
          { signal: background.signal }
        );
        // The scan runs durably in the background; the pending row plus its
        // run id return immediately and the client polls the preview route.
        trackBackground(run);
        return reply.code(202).send({ preview: previewToApi(preview), run_id: preview.id });
      } catch (error) {
        if (sendKnowledgeError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/knowledge-previews/:id",
    { onRequest: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      try {
        const ledger = store();
        const preview = await ledger.getPreview(accountId, (req.params as { id: string }).id);
        if (!preview) {
          return reply.code(404).send({
            error: KNOWLEDGE_PUBLIC_MESSAGES.KNOWLEDGE_PREVIEW_NOT_FOUND,
            code: "KNOWLEDGE_PREVIEW_NOT_FOUND",
          });
        }
        const entries = preview.status === "pending" ? [] : await ledger.listPreviewEntries(accountId, preview.id);
        return reply.send({ preview: previewToApi(preview), entries: entries.map(previewEntryToApi) });
      } catch (error) {
        if (sendKnowledgeError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/knowledge-previews/:id/apply",
    {
      onRequest: requireAuth,
      bodyLimit: KNOWLEDGE_APPLY_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: applyPreviewBodySchema },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const body = req.body as {
        expected_revision: number;
        selections: { entry_id: string; selection_token: string }[];
      };
      try {
        const applied = await knowledgeRefreshService().applyPreview(
          accountId,
          (req.params as { id: string }).id,
          { expected_revision: body.expected_revision, selections: body.selections },
          { signal: background.signal }
        );
        // The commit registered durable work only; open one `apply` refresh
        // so its generations actually promote (coalesce onto an active one).
        let refreshId: string | null = null;
        const ledger = store();
        const connection = await ledger.requireConnection(accountId, applied.preview.connection_id);
        try {
          const begun = await ledger.beginRefresh(accountId, {
            connection_id: connection.id,
            expected_connection_revision: connection.revision,
            requested_by: "apply",
          });
          refreshId = begun.refresh.id;
        } catch (error) {
          if (error instanceof KnowledgeRefreshConflictError) {
            refreshId = (await ledger.getActiveRefresh(accountId, connection.id))?.id ?? null;
          } else {
            throw error;
          }
        }
        trackBackground(
          knowledgeRefreshService().refreshAndWaitReady({
            accountId,
            connections: [{ connection_id: connection.id, expected_connection_revision: connection.revision }],
            signal: background.signal,
          })
        );
        return reply.send({
          preview: previewToApi(applied.preview),
          items: applied.items.map((item) => ({ ...item })),
          refresh_id: refreshId,
        });
      } catch (error) {
        if (sendKnowledgeError(reply, error)) return;
        throw error;
      }
    }
  );

  // ---------------------------------------------------------- refreshes

  app.post(
    "/api/knowledge-connections/:id/refreshes",
    {
      onRequest: requireAuth,
      bodyLimit: IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: refreshCreateBodySchema },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const body = (req.body ?? {}) as { expected_connection_revision?: number; item_ids?: string[] };
      try {
        const ledger = store();
        const connection = await ledger.requireConnection(accountId, (req.params as { id: string }).id);
        const expected = body.expected_connection_revision ?? connection.revision;
        const begun = await ledger.beginRefresh(accountId, {
          connection_id: connection.id,
          expected_connection_revision: expected,
          requested_by: "manual",
          item_ids: body.item_ids,
        });
        trackBackground(
          knowledgeRefreshService().refreshAndWaitReady({
            accountId,
            connections: [
              {
                connection_id: connection.id,
                expected_connection_revision: expected,
                item_ids: body.item_ids,
              },
            ],
            signal: background.signal,
          })
        );
        return reply.code(202).send({ refresh: refreshToApi(begun.refresh) });
      } catch (error) {
        if (sendKnowledgeError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/knowledge-connections/:id/refreshes",
    { onRequest: requireAuth, schema: { params: idParamsSchema, querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const catalog = await store().listRefreshes(
        accountId,
        (req.params as { id: string }).id,
        parseCatalogPageQuery("knowledge_refreshes", req.query)
      );
      return reply.send(catalogResponse("knowledge_refreshes", catalogStorePageOf(catalog, refreshToApi)));
    }
  );

  app.get(
    "/api/knowledge-refreshes/:id",
    { onRequest: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      try {
        const ledger = store();
        const refresh = await ledger.getRefresh(accountId, (req.params as { id: string }).id);
        if (!refresh) {
          return reply.code(404).send({
            error: KNOWLEDGE_PUBLIC_MESSAGES.KNOWLEDGE_REFRESH_NOT_FOUND,
            code: "KNOWLEDGE_REFRESH_NOT_FOUND",
          });
        }
        const items = await ledger.listRefreshItems(accountId, refresh.id);
        return reply.send({
          refresh: refreshToApi(refresh),
          counts: refreshCounts(items),
          items: items.map(refreshItemToApi),
        });
      } catch (error) {
        if (sendKnowledgeError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete(
    "/api/knowledge-refreshes/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      try {
        const ledger = store();
        const refresh = await ledger.getRefresh(accountId, (req.params as { id: string }).id);
        if (!refresh) {
          return reply.code(404).send({
            error: KNOWLEDGE_PUBLIC_MESSAGES.KNOWLEDGE_REFRESH_NOT_FOUND,
            code: "KNOWLEDGE_REFRESH_NOT_FOUND",
          });
        }
        // Durable cancellation request; idempotent — a repeat on a refresh
        // that already finished reports the settled state, never an error.
        await ledger.requestRefreshCancellation(accountId, refresh.id);
        const current = await ledger.requireRefresh(accountId, refresh.id);
        return reply.send({
          ok: true,
          cancel_requested: current.cancel_requested,
          status: current.status,
        });
      } catch (error) {
        if (sendKnowledgeError(reply, error)) return;
        throw error;
      }
    }
  );
}

/** Re-shapes a store page's items without recomputing the keyset position. */
function catalogStorePageOf<T, R>(
  page: { items: readonly T[]; next: { timestamp: string; id: string } | null },
  map: (item: T) => R
): { items: R[]; next: { timestamp: string; id: string } | null } {
  return { items: page.items.map(map), next: page.next };
}
