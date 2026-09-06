import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { RemoteEgressConsentRequiredError, enforceRemoteEgressConsent } from "../egressPolicy.js";
import { LibraryNotFoundError } from "../db/stores/libraryStore.js";
import {
  MAX_SEARCH_QUERY_CHARS,
  SourceSearchError,
  searchLibraryScope,
  type SourceSearchMode,
} from "../sourceSearch.js";
import { parseChunkLocators } from "../sourceLocations.js";
import { storageRuntime } from "../storageRuntime.js";
import { BODYLESS_MUTATION_LIMIT_BYTES, SOURCE_SEARCH_JSON_BODY_LIMIT_BYTES } from "./bodyLimits.js";
import { idParamsSchema } from "./schemas.js";

/**
 * Routes for inspectable source search (M14 stage 3):
 * - `POST /api/libraries/:id/search` — library-scoped keyword (default, no
 *   model request) or semantic (explicit; the authorized embedding boundary
 *   applies remote-egress consent) search over the concrete ready
 *   source/generation set captured at acceptance. Filters are validated
 *   against library membership and account; a selected-empty filter is an
 *   empty page, never all account content.
 * - `GET /api/sources/:id/passages/:chunkId` — the owned current chunk with
 *   its typed locators and bounded neighboring text; honest 410 when the
 *   chunk was pruned or belongs to a superseded generation.
 * - `GET /api/sources/:id/passages/:chunkId/neighboring-context` — just the
 *   bounded neighboring context at a caller-chosen width.
 */

const UUID_JSON = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const MAX_SEARCH_FILTER_IDS = 100;
const NEIGHBOR_CONTEXT_DEFAULT_CHARS = 400;
const NEIGHBOR_CONTEXT_MAX_CHARS = 4_000;
const PASSAGE_NEIGHBOR_CHARS = 800;

const searchBodySchema = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: MAX_SEARCH_QUERY_CHARS, pattern: "\\S" },
    mode: { type: "string", enum: ["keyword", "semantic"] },
    source_ids: {
      type: "array",
      maxItems: MAX_SEARCH_FILTER_IDS,
      uniqueItems: true,
      items: { type: "string", pattern: UUID_JSON },
    },
    kind: { type: "string", enum: ["document", "tabular"] },
  },
} as const;

const neighboringQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    context_chars: { type: "integer", minimum: 0, maximum: NEIGHBOR_CONTEXT_MAX_CHARS },
  },
} as const;

const passageParamsSchema = {
  type: "object",
  required: ["id", "chunkId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_JSON },
    chunkId: { type: "string", pattern: UUID_JSON },
  },
} as const;

function sendSourceSearchError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof LibraryNotFoundError) {
    reply.code(404).send({ error: "library not found" });
    return true;
  }
  if (error instanceof SourceSearchError) {
    reply.code(error.statusCode).send({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof RemoteEgressConsentRequiredError) {
    reply.code(403).send({
      error: "remote model-provider consent is required before this request leaves the machine",
      code: "REMOTE_EGRESS_CONSENT_REQUIRED",
    });
    return true;
  }
  return false;
}

export async function sourceSearchRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/libraries/:id/search",
    {
      onRequest: requireAuth,
      bodyLimit: SOURCE_SEARCH_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: searchBodySchema },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const body = req.body as {
        query: string;
        mode?: SourceSearchMode;
        source_ids?: string[];
        kind?: "document" | "tabular";
      };
      const mode: SourceSearchMode = body.mode ?? "keyword";
      try {
        const runtime = storageRuntime();
        const library = await runtime.libraries.getLibrary(accountId, (req.params as { id: string }).id);
        if (!library) return reply.code(404).send({ error: "library not found" });
        // Semantic mode makes one query-embedding request through the
        // account-authorized boundary; the consent gate fails closed before
        // any store work, exactly like chat turns and ingestion.
        if (mode === "semantic") {
          const target = await enforceRemoteEgressConsent(reply, accountId);
          if (!target) return;
        }
        const members = await runtime.libraries.listMembers(accountId, library.id);
        const memberById = new Map(members.map((member) => [member.id, member]));
        const ignoredSourceIds: string[] = [];
        let candidates = members;
        if (body.source_ids !== undefined) {
          const selected: string[] = [];
          for (const sourceId of body.source_ids) {
            if (memberById.has(sourceId)) selected.push(sourceId);
            else ignoredSourceIds.push(sourceId);
          }
          candidates = selected.flatMap((sourceId) => {
            const member = memberById.get(sourceId)!;
            return [member];
          });
        }
        if (body.kind) candidates = candidates.filter((member) => member.kind === body.kind);
        const sourceIds = candidates.map((member) => member.id);
        // Selected-empty (or a filter with no in-library matches) is an empty
        // page; it never falls back to all library or account content and
        // semantic mode must not spend an embedding request on an empty scope.
        if (!sourceIds.length) {
          return reply.send({
            mode,
            query_truncated: false,
            captured_scope: [],
            ignored_source_ids: ignoredSourceIds,
            hits: [],
            returned_char_count: 0,
            truncated: false,
          });
        }
        const result = await searchLibraryScope({
          accountId,
          sourceIds,
          query: body.query,
          mode,
        });
        return reply.send({
          mode: result.mode,
          query_truncated: result.query_truncated,
          captured_scope: result.scope,
          ignored_source_ids: ignoredSourceIds,
          hits: result.hits.map((hit) => ({
            source_id: hit.source_id,
            generation: hit.generation,
            chunk_id: hit.chunk_id,
            label: hit.label,
            excerpt: hit.excerpt,
            score: hit.score,
            rank: hit.rank,
            locators: hit.locators,
          })),
          returned_char_count: result.returned_char_count,
          truncated: result.truncated,
        });
      } catch (error) {
        if (sendSourceSearchError(reply, error)) return;
        throw error;
      }
    }
  );

  const passageHandler = async (req: FastifyRequest, reply: FastifyReply, neighborsOnly: boolean) => {
    const accountId = getAccountId(req);
    const { id: sourceId, chunkId } = req.params as { id: string; chunkId: string };
    const contextCharsRaw = (req.query as { context_chars?: number }).context_chars;
    const contextChars = neighborsOnly
      ? Math.min(contextCharsRaw ?? NEIGHBOR_CONTEXT_DEFAULT_CHARS, NEIGHBOR_CONTEXT_MAX_CHARS)
      : PASSAGE_NEIGHBOR_CHARS;
    try {
      const store = storageRuntime().ingestion;
      const passage = await store.getChunkPassage({ accountId, sourceId, chunkId });
      if (passage.found === false && passage.source === false) {
        return reply.code(404).send({ error: "source not found" });
      }
      const source = passage.source;
      if (passage.found === false) {
        // Owned source, but this exact chunk is pruned or was never promoted:
        // an honest unavailable-passage answer, never a newer-generation read.
        return reply
          .code(410)
          .send({ error: "passage is unavailable for this source's current generation", code: "PASSAGE_UNAVAILABLE" });
      }
      if (passage.chunk.generation !== source.readyGeneration) {
        return reply
          .code(410)
          .send({ error: "passage is unavailable for this source's current generation", code: "PASSAGE_UNAVAILABLE" });
      }
      const neighbors = await store.getChunkNeighbors({
        accountId,
        sourceId,
        generation: passage.chunk.generation,
        seq: passage.chunk.seq,
      });
      const shapeNeighbor = (neighbor: Readonly<{ chunkId: string; seq: number; content: string }> | null) =>
        neighbor
          ? {
              chunk_id: neighbor.chunkId,
              seq: neighbor.seq,
              content: neighbor.content.slice(0, contextChars),
            }
          : null;
      const before = shapeNeighbor(neighbors.before);
      const after = shapeNeighbor(neighbors.after);
      if (neighborsOnly) {
        return reply.send({
          chunk_id: chunkId,
          source_id: sourceId,
          generation: passage.chunk.generation,
          neighbors: { before, after },
          context_chars: contextChars,
        });
      }
      const locators = parseChunkLocators(passage.chunk.meta);
      return reply.send({
        source: { id: sourceId, label: source.label, status: source.status, ready_generation: source.readyGeneration },
        chunk: {
          chunk_id: passage.chunk.chunkId,
          source_id: passage.chunk.sourceId,
          generation: passage.chunk.generation,
          seq: passage.chunk.seq,
          content: passage.chunk.content,
          locators,
        },
        neighbors: { before, after },
      });
    } catch (error) {
      if (sendSourceSearchError(reply, error)) return;
      throw error;
    }
  };

  app.get(
    "/api/sources/:id/passages/:chunkId",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: passageParamsSchema } },
    async (req, reply) => passageHandler(req, reply, false)
  );

  app.get(
    "/api/sources/:id/passages/:chunkId/neighboring-context",
    {
      onRequest: requireAuth,
      bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES,
      schema: { params: passageParamsSchema, querystring: neighboringQuerySchema },
    },
    async (req, reply) => passageHandler(req, reply, true)
  );
}
