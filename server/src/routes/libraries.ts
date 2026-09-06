import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { catalogPageQuerySchema, catalogResponse, parseCatalogPageQuery } from "../catalogPagination.js";
import {
  commitDirectoryImport,
  DirectoryImportError,
  LibraryRevisionConflictError,
  libraryMembershipRevision,
  MAX_DIRECTORY_IMPORT_ITEMS,
} from "../db/stores/directoryImportStore.js";
import {
  DuplicateLibraryError,
  LibraryMemberMissingError,
  LibraryNotFoundError,
  MAX_LIBRARY_MEMBERS,
  MAX_LIBRARY_NAME_CHARS,
} from "../db/stores/libraryStore.js";
import { MAX_KNOWLEDGE_RELATIVE_PATH_CHARS } from "../db/stores/knowledgeStore.js";
import type { SourceRecord } from "../db/stores/sourceStore.js";
import { storageRuntime } from "../storageRuntime.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  COMPACT_JSON_BODY_LIMIT_BYTES,
  DIRECTORY_IMPORT_JSON_BODY_LIMIT_BYTES,
  IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";
import { idParamsSchema } from "./schemas.js";

const UUID_JSON = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const libraryBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: MAX_LIBRARY_NAME_CHARS, pattern: "\\S" },
  },
} as const;

const directoryImportBodySchema = {
  type: "object",
  required: ["operation_id", "expected_revision", "items"],
  additionalProperties: false,
  properties: {
    operation_id: { type: "string", pattern: UUID_JSON },
    expected_revision: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
    items: {
      type: "array",
      minItems: 1,
      maxItems: MAX_DIRECTORY_IMPORT_ITEMS,
      items: {
        type: "object",
        required: ["source_id", "relative_path"],
        additionalProperties: false,
        properties: {
          source_id: { type: "string", pattern: UUID_JSON },
          relative_path: { type: "string", minLength: 1, maxLength: MAX_KNOWLEDGE_RELATIVE_PATH_CHARS },
        },
      },
    },
  },
} as const;

const libraryMembersSchema = {
  type: "object",
  required: ["source_ids"],
  additionalProperties: false,
  properties: {
    source_ids: {
      type: "array",
      maxItems: MAX_LIBRARY_MEMBERS,
      uniqueItems: true,
      items: {
        type: "string",
        pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      },
    },
  },
} as const;

/** The sources DTO is shared verbatim with the Sources surface. */
function sourceToApi(source: SourceRecord): Record<string, unknown> {
  // Deliberately no `file_path`: durable local paths never join an API DTO.
  // The internal SourceRecord.filePath remains required by ingestion/cleanup.
  return {
    id: source.id,
    account_id: source.accountId,
    name: source.name,
    kind: source.kind,
    connector: source.connectorId,
    display_name: source.displayName,
    url: source.url,
    mime: source.mime,
    size_bytes: source.sizeBytes,
    status: source.status,
    meta: source.meta,
    ready_generation: source.readyGeneration,
    created_at: source.createdAt,
  };
}

function sendLibraryError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof DuplicateLibraryError) {
    reply.code(409).send({ error: "a library with this name already exists" });
    return true;
  }
  if (error instanceof LibraryNotFoundError) {
    reply.code(404).send({ error: "library not found" });
    return true;
  }
  if (error instanceof LibraryMemberMissingError) {
    reply.code(404).send({ error: "one or more sources do not exist in this account" });
    return true;
  }
  return false;
}

function sendDirectoryImportError(reply: FastifyReply, error: unknown): boolean {
  if (sendLibraryError(reply, error)) return true;
  if (error instanceof LibraryRevisionConflictError) {
    reply
      .code(error.statusCode)
      .send({ error: "the library membership changed; reload before committing", code: error.code });
    return true;
  }
  if (error instanceof DirectoryImportError) {
    reply.code(error.statusCode).send({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/libraries",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const page = await storageRuntime().libraries.listLibraries(
        getAccountId(req),
        parseCatalogPageQuery("libraries", req.query)
      );
      return reply.send(catalogResponse("libraries", page));
    }
  );

  app.post(
    "/api/libraries",
    { onRequest: requireAuth, bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES, schema: { body: libraryBodySchema } },
    async (req, reply) => {
      try {
        const library = await storageRuntime().libraries.createLibrary(getAccountId(req), (req.body as any).name);
        return reply.code(201).send(library);
      } catch (error) {
        if (sendLibraryError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get("/api/libraries/:id", { onRequest: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const accountId = getAccountId(req);
    const libraryId = (req.params as any).id;
    const library = await storageRuntime().libraries.getLibrary(accountId, libraryId);
    if (!library) return reply.code(404).send({ error: "library not found" });
    const members = await storageRuntime().libraries.listMembers(accountId, libraryId);
    // The derived membership revision is the compare-and-swap token for
    // directory imports; it changes whenever the member set changes.
    const revision = libraryMembershipRevision(
      libraryId,
      members.map((member) => member.id)
    );
    return reply.send({ ...library, revision, members: members.map(sourceToApi) });
  });

  // Browser copied-directory import (M14 stage 2): commits an idempotent,
  // operation-UUID-keyed manifest of already-uploaded owned sources against
  // the exact library membership revision. Creates no refreshable connection.
  app.post(
    "/api/libraries/:id/directory-imports",
    {
      onRequest: requireAuth,
      bodyLimit: DIRECTORY_IMPORT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: directoryImportBodySchema },
    },
    async (req, reply) => {
      try {
        const result = await commitDirectoryImport(
          storageRuntime().ledger,
          getAccountId(req),
          (req.params as any).id,
          req.body as any
        );
        return reply.send(result);
      } catch (error) {
        if (sendDirectoryImportError(reply, error)) return;
        throw error;
      }
    }
  );

  app.patch(
    "/api/libraries/:id",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: libraryBodySchema },
    },
    async (req, reply) => {
      try {
        const library = await storageRuntime().libraries.renameLibrary(
          getAccountId(req),
          (req.params as any).id,
          (req.body as any).name
        );
        if (!library) return reply.code(404).send({ error: "library not found" });
        return reply.send(library);
      } catch (error) {
        if (sendLibraryError(reply, error)) return;
        throw error;
      }
    }
  );

  app.put(
    "/api/libraries/:id/sources",
    {
      onRequest: requireAuth,
      bodyLimit: IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: libraryMembersSchema },
    },
    async (req, reply) => {
      try {
        await storageRuntime().libraries.replaceMembers(
          getAccountId(req),
          (req.params as any).id,
          (req.body as any).source_ids as readonly string[]
        );
        return reply.send({ ok: true });
      } catch (error) {
        if (sendLibraryError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete(
    "/api/libraries/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const deleted = await storageRuntime().libraries.deleteLibrary(getAccountId(req), (req.params as any).id);
      if (!deleted) return reply.code(404).send({ error: "library not found" });
      return reply.send({ ok: true });
    }
  );
}
