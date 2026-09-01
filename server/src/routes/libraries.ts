import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { catalogPageQuerySchema, catalogResponse, parseCatalogPageQuery } from "../catalogPagination.js";
import {
  DuplicateLibraryError,
  LibraryMemberMissingError,
  LibraryNotFoundError,
  MAX_LIBRARY_MEMBERS,
  MAX_LIBRARY_NAME_CHARS,
} from "../db/stores/libraryStore.js";
import type { SourceRecord } from "../db/stores/sourceStore.js";
import { storageRuntime } from "../storageRuntime.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  COMPACT_JSON_BODY_LIMIT_BYTES,
  IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";
import { idParamsSchema } from "./schemas.js";

const libraryBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: MAX_LIBRARY_NAME_CHARS, pattern: "\\S" },
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
  return {
    id: source.id,
    account_id: source.accountId,
    name: source.name,
    kind: source.kind,
    connector: source.connectorId,
    display_name: source.displayName,
    file_path: source.filePath,
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
    return reply.send({ ...library, members: members.map(sourceToApi) });
  });

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
