import { embed } from "./llm.js";
import { parseChunkLocators, type ChunkLocator } from "./sourceLocations.js";
import { storageRuntime } from "./storageRuntime.js";
import type { SqliteIngestionStore } from "./db/stores/ingestionStore.js";
import type { LanceVectorIndex } from "./vector/lance.js";

/**
 * Inspectable library-scoped source search (M14 stage 3).
 *
 * Two modes with deliberately different egress profiles:
 * - `keyword` (default) never leaves the machine: it is a scoped SQLite FTS5
 *   query whose account and exact `(source_id, generation)` predicates ride
 *   inside the search itself. The user query is compiled into a literal-only
 *   FTS5 grammar (whitespace-separated tokens, each a double-quoted phrase
 *   with quotes doubled) so raw FTS operators from a user can never reach
 *   the engine as syntax — `AND`, `OR`, `NEAR`, parentheses, and `*` match
 *   as literal tokens.
 * - `semantic` embeds the query through the ordinary account-authorized
 *   embedding boundary (`llm.embed`), so the remote-egress consent gate
 *   applies exactly as it does for chat retrieval, and the KNN itself is the
 *   existing scoped LanceDB search — never a broad vector scan filtered in
 *   JavaScript.
 *
 * Generation honesty: every search first captures the concrete ready
 * `(source_id, generation)` set and all subsequent vector/FTS/join work is
 * restricted to those exact pairs. A refresh promoting mid-search can only
 * make the captured text disappear (honest `source_changed`/`unavailable`
 * statuses), never leak newer text.
 */

export const MAX_SEARCH_QUERY_CHARS = 1_000;
export const MAX_SEARCH_HITS = 50;
export const MAX_SEARCH_EXCERPT_CHARS = 2_000;
export const MAX_SEARCH_TOTAL_CHARS = 100_000;
export const MAX_SEARCH_SCOPE_SOURCES = 100;
/** Literal-token budget for the escaped FTS5 grammar. */
export const MAX_SEARCH_FTS_TOKENS = 64;

export type SourceSearchMode = "keyword" | "semantic";

export type SourceSearchScopeStatus = "ready" | "source_changed" | "unavailable";

export interface SourceSearchScopeEntry {
  readonly source_id: string;
  readonly generation: number | null;
  readonly status: SourceSearchScopeStatus;
}

export interface SourceSearchHit {
  readonly source_id: string;
  readonly generation: number;
  readonly chunk_id: string;
  readonly label: string;
  readonly excerpt: string;
  /** Keyword mode: bm25 negation (higher is better). Semantic: cosine similarity. */
  readonly score: number;
  readonly rank: number;
  readonly locators: readonly ChunkLocator[];
}

export interface SourceSearchResult {
  readonly mode: SourceSearchMode;
  readonly query_truncated: boolean;
  readonly scope: readonly SourceSearchScopeEntry[];
  readonly hits: readonly SourceSearchHit[];
  readonly returned_char_count: number;
  readonly truncated: boolean;
}

export interface SourceSearchScopePair {
  readonly sourceId: string;
  readonly generation: number;
}

export interface SourceSearchPorts {
  readonly store?: () => SqliteIngestionStore;
  readonly vectors?: () => LanceVectorIndex;
  /** Query embedding for semantic mode; defaults to the authorized boundary. */
  readonly embedQuery?: (texts: string[], accountId: string, signal?: AbortSignal) => Promise<number[][]>;
}

export class SourceSearchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "SourceSearchError";
  }
}

/**
 * Compile a user query into the bounded literal FTS5 grammar. Each
 * whitespace/control-separated token becomes one double-quoted phrase with
 * embedded quotes doubled; consecutive phrases combine with FTS5's implicit
 * AND. Leading/trailing `*` are stripped before quoting because FTS5 applies
 * its prefix operator to a `*` even at the end of a quoted phrase — without
 * stripping, a user's `*` would silently gain operator power. Token count is
 * capped, and truncation is reported honestly rather than silently changing
 * the question.
 */
export function buildFtsLiteralQuery(
  query: string,
  maxTokens = MAX_SEARCH_FTS_TOKENS
): { ftsQuery: string | null; truncated: boolean } {
  const tokens = query
    .split(/[\s\p{Cc}]+/u)
    .filter(Boolean)
    .map((token) => token.replace(/^\*+/, "").replace(/\*+$/, ""))
    .filter((token) => token.length > 0);
  if (!tokens.length) return { ftsQuery: null, truncated: false };
  const truncated = tokens.length > maxTokens;
  const kept = tokens.slice(0, maxTokens);
  const ftsQuery = kept.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
  return { ftsQuery, truncated };
}

function excerptOf(content: string): string {
  return content.length > MAX_SEARCH_EXCERPT_CHARS ? content.slice(0, MAX_SEARCH_EXCERPT_CHARS) : content;
}

/**
 * Apply the per-hit and aggregate excerpt caps. Hits past the total budget are
 * dropped (reported via `truncated`), never returned partially beyond the cap.
 */
function packHits(hits: readonly Omit<SourceSearchHit, "rank">[]): {
  hits: readonly SourceSearchHit[];
  returnedCharCount: number;
  truncated: boolean;
} {
  const packed: SourceSearchHit[] = [];
  let returned = 0;
  let truncated = false;
  for (const hit of hits) {
    const cost = hit.excerpt.length;
    if (packed.length >= MAX_SEARCH_HITS || returned + cost > MAX_SEARCH_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    returned += cost;
    packed.push(Object.freeze({ ...hit, rank: packed.length + 1 }));
  }
  return { hits: Object.freeze(packed), returnedCharCount: returned, truncated };
}

async function defaultVectors(): Promise<LanceVectorIndex> {
  return storageRuntime().vectors;
}

/**
 * Internal operation for M15 (and ordinary library search): search exactly
 * the captured `(source_id, generation)` identities. Each pair is revalidated
 * against the store's authoritative ready generations first; anything that no
 * longer matches — deleted source, superseded generation, or not ready — is
 * reported as `source_changed` and contributes no results. Results therefore
 * can never come from a newer generation than the caller captured.
 */
export async function searchCapturedScope(
  input: {
    accountId: string;
    scopes: readonly SourceSearchScopePair[];
    query: string;
    mode: SourceSearchMode;
    signal?: AbortSignal;
  },
  ports: SourceSearchPorts = {}
): Promise<SourceSearchResult> {
  const query = input.query;
  if (typeof query !== "string" || !query.trim()) {
    throw new SourceSearchError("SEARCH_QUERY_INVALID", "query must be a non-empty string");
  }
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    throw new SourceSearchError(
      "SEARCH_QUERY_TOO_LONG",
      `query is limited to ${MAX_SEARCH_QUERY_CHARS} characters`,
      400
    );
  }
  if (!["keyword", "semantic"].includes(input.mode)) {
    throw new SourceSearchError("SEARCH_MODE_INVALID", "mode must be keyword or semantic");
  }
  if (input.scopes.length > MAX_SEARCH_SCOPE_SOURCES) {
    throw new SourceSearchError(
      "SEARCH_SCOPE_TOO_BROAD",
      `a search may capture at most ${MAX_SEARCH_SCOPE_SOURCES} sources`,
      400
    );
  }
  const store = ports.store ? ports.store() : storageRuntime().ingestion;
  const scopePairs = [...new Map(input.scopes.map((scope) => [scope.sourceId, scope])).values()];

  // Authoritative revalidation: only pairs that are still the ready
  // generation of an owned, ready source are searchable.
  const live = await store.readyGenerationScopes(
    input.accountId,
    scopePairs.map((scope) => scope.sourceId)
  );
  const liveBySource = new Map(live.map((scope) => [scope.sourceId, scope.generation]));
  const statusBySource = new Map<string, SourceSearchScopeStatus>();
  const validPairs: SourceSearchScopePair[] = [];
  for (const scope of scopePairs) {
    if (liveBySource.get(scope.sourceId) === scope.generation) {
      validPairs.push(scope);
      statusBySource.set(scope.sourceId, "ready");
    } else {
      statusBySource.set(scope.sourceId, "source_changed");
    }
  }
  const scopeResult: readonly SourceSearchScopeEntry[] = Object.freeze(
    scopePairs.map((scope) =>
      Object.freeze({
        source_id: scope.sourceId,
        generation: scope.generation,
        status: statusBySource.get(scope.sourceId) ?? "source_changed",
      })
    )
  );

  if (!validPairs.length || input.signal?.aborted) {
    return Object.freeze({
      mode: input.mode,
      query_truncated: false,
      scope: scopeResult,
      hits: Object.freeze([]),
      returned_char_count: 0,
      truncated: false,
    });
  }

  if (input.mode === "keyword") {
    const { ftsQuery, truncated } = buildFtsLiteralQuery(query);
    if (!ftsQuery) {
      return Object.freeze({
        mode: input.mode,
        query_truncated: truncated,
        scope: scopeResult,
        hits: Object.freeze([]),
        returned_char_count: 0,
        truncated: false,
      });
    }
    const rows = await store.keywordSearchChunks({
      accountId: input.accountId,
      scopes: validPairs,
      ftsQuery,
      limit: MAX_SEARCH_HITS,
    });
    // The FTS rows carry the stored chunk text, but label/locator truth is
    // re-joined through SQLite under the same captured pairs (fail-closed).
    const metaByChunk = await store.loadSearchChunks({
      accountId: input.accountId,
      scopes: validPairs,
      chunkIds: rows.map((row) => row.chunkId),
    });
    const ranked = rows.flatMap((row) => {
      const joined = metaByChunk.get(row.chunkId);
      if (!joined) return [];
      return [
        {
          source_id: row.sourceId,
          generation: row.generation,
          chunk_id: row.chunkId,
          label: joined.label,
          excerpt: excerptOf(joined.content),
          score: -row.rank,
          locators: parseChunkLocators(joined.meta),
        },
      ];
    });
    const packed = packHits(ranked);
    return Object.freeze({
      mode: input.mode,
      query_truncated: truncated,
      scope: scopeResult,
      hits: packed.hits,
      returned_char_count: packed.returnedCharCount,
      truncated: packed.truncated,
    });
  }

  // Semantic mode: one embedding of the query through the account-authorized
  // boundary (remote consent applies there), then the existing scoped Lance
  // KNN restricted to the exact captured pairs, then the SQLite text join.
  const vectors = ports.vectors ? await ports.vectors() : await defaultVectors();
  const embedQuery = ports.embedQuery ?? ((texts, accountId, signal) => embed(texts, { accountId, signal }));
  const [vector] = await embedQuery([query], input.accountId, input.signal);
  if (input.signal?.aborted) throw input.signal.reason;
  if (!Array.isArray(vector)) {
    throw new SourceSearchError("SEARCH_EMBEDDING_UNAVAILABLE", "query embedding is unavailable", 503);
  }
  const hits = await vectors.search({
    accountId: input.accountId,
    sourceIds: validPairs.map((scope) => scope.sourceId),
    sourceGenerations: validPairs,
    vector,
    limit: MAX_SEARCH_HITS,
  });
  const metaByChunk = await store.loadSearchChunks({
    accountId: input.accountId,
    scopes: validPairs,
    chunkIds: hits.map((hit) => hit.chunkId),
  });
  const ranked = hits.flatMap((hit) => {
    const joined = metaByChunk.get(hit.chunkId);
    if (!joined || !Number.isFinite(hit.distance)) return [];
    return [
      {
        source_id: joined.sourceId,
        generation: joined.generation,
        chunk_id: hit.chunkId,
        label: joined.label,
        excerpt: excerptOf(joined.content),
        score: 1 - hit.distance,
        locators: parseChunkLocators(joined.meta),
      },
    ];
  });
  const packed = packHits(ranked);
  return Object.freeze({
    mode: input.mode,
    query_truncated: false,
    scope: scopeResult,
    hits: packed.hits,
    returned_char_count: packed.returnedCharCount,
    truncated: packed.truncated,
  });
}

/**
 * Ordinary library search: capture the concrete ready source/generation set
 * at acceptance from the (already server-validated) source-id list and run
 * the captured-scope search. Members that exist but are not ready are
 * reported `unavailable`; an empty resolved scope is an empty page and never
 * makes a model request or widens to account content.
 */
export async function searchLibraryScope(
  input: {
    accountId: string;
    /** Source ids already proven owned and library-scoped by the route. */
    sourceIds: readonly string[];
    query: string;
    mode: SourceSearchMode;
    signal?: AbortSignal;
  },
  ports: SourceSearchPorts = {}
): Promise<SourceSearchResult> {
  const store = ports.store ? ports.store() : storageRuntime().ingestion;
  const sourceIds = [...new Set(input.sourceIds)];
  if (sourceIds.length > MAX_SEARCH_SCOPE_SOURCES) {
    throw new SourceSearchError(
      "SEARCH_SCOPE_TOO_BROAD",
      `a search may cover at most ${MAX_SEARCH_SCOPE_SOURCES} sources`,
      400
    );
  }
  const live = await store.readyGenerationScopes(input.accountId, sourceIds);
  const liveBySource = new Map(live.map((scope) => [scope.sourceId, scope]));
  const unready: readonly SourceSearchScopeEntry[] = Object.freeze(
    sourceIds
      .filter((sourceId) => !liveBySource.has(sourceId))
      .map((sourceId) => Object.freeze({ source_id: sourceId, generation: null, status: "unavailable" as const }))
  );
  const result = await searchCapturedScope(
    {
      accountId: input.accountId,
      scopes: live,
      query: input.query,
      mode: input.mode,
      signal: input.signal,
    },
    ports
  );
  return Object.freeze({
    ...result,
    scope: Object.freeze([...unready, ...result.scope]),
  });
}
