# Plan 006: Batch the per-chunk embedding inserts in ingest

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 86400ce..HEAD -- server/src/ingest.ts`
> If this file changed since the plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (same data, same schema; one INSERT instead of N)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `86400ce`, 2026-08-22

## Why this matters

On every upload (document or tabular file), `ingestSource` embeds the text and
then inserts the chunks into Postgres **one row at a time** — hundreds of
sequential round-trips for a long document, and the insert loop is on the
hot path of a feature the product exists for ("chat with your uploaded
documents": a 100-page PDF becomes ~300–500 chunk rows). Batching into a
single parameterized INSERT shrinks upload latency by orders of magnitude and
reduces pool churn spikes (the current loop can exhaust the single pg Pool
connection budget under concurrent uploads). It is a small, local change to
`server/src/ingest.ts`.

## Current state

`server/src/ingest.ts`, lines 102–111 (inside `ingestSource`):

```ts
    const chunks = chunkText(srcdoc, 800, 110);
    const embeddings = await embed(chunks);
    // insert in batches bypassing vector type param issues
    for (let i = 0; i < chunks.length; i++) {
      await q(
        `INSERT INTO chunks (account_id, source_id, source_name, content, embedding, meta)
         VALUES ($1, $2, $3, $4, $5::vector, $6)`,
        [accountId, sourceId, displayName, chunks[i], `[${embeddings[i].join(",")}]`, meta]
      );
    }
```

The `meta` value is a single object (same for all chunks); `displayName`,
`accountId`, `sourceId` are constants. The only per-row data are `content` and
`embedding`.

The `chunks` table (from `server/src/db.ts` SCHEMA, lines 33–41):

```sql
CREATE TABLE IF NOT EXISTS chunks (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  source_name TEXT,
  content TEXT NOT NULL,
  embedding vector(${config.embeddingDim}),
  meta JSONB NOT NULL DEFAULT '{}'
);
```

## Commands you will need

| Purpose   | Command                                    | Expected on success |
|-----------|--------------------------------------------|---------------------|
| Typecheck | `cd server && npm run typecheck`           | exit 0              |
| Args smoke | `cd server && npx tsx -e "..."` (Step 2)  | prints arrays lengths 2 & 3 |

## Scope

**In scope** (the only files you should modify):
- `server/src/ingest.ts` — replace the insert loop with a batched insert

**Out of scope** (do NOT touch):
- `server/src/db.ts` schema, indexes — no change.
- `server/src/llm.ts` embed batching — leaves it as-is (already batches 16).
- `python/` and `web/` — unrelated.
- Do not add new dependencies.

## Git workflow

- Branch: `advisor/006-batch-chunk-inserts`
- Commit message style (conventional): `perf(server): batch chunk embedding inserts`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the loop with one parameterized INSERT

In `server/src/ingest.ts`, replace the loop (lines 104–111) with:

```ts
    const rows = chunks.map((c, i) => ({
      content: c,
      embedding: `[${embeddings[i].join(",")}]`,
    }));
    if (rows.length) {
      await q(
        `INSERT INTO chunks (account_id, source_id, source_name, content, embedding, meta)
         SELECT $1, $2, $3, unnest($4::text[]), unnest($5::vector[]), $6::jsonb`,
        [accountId, sourceId, displayName, rows.map((r) => r.content), rows.map((r) => r.embedding), JSON.stringify(meta)]
      );
    }
```

Notes (match the surrounding style — no extra comments beyond the removed
one): `$6` becomes a `jsonb` from a string via `::jsonb`, which is equivalent
to what the loop passed (`meta` object → pg serializes it as `jsonb` already;
keep passing `JSON.stringify(meta)` so the cast is explicit and typed as
`jsonb` in the query text).

**Verify**: `cd server && npm run typecheck` → exit 0.

### Step 2: Smoke-test the generated params without a DB

Extract the mapping into a local check by running the exact array-building
expression the INSERT uses (this validates the unnest inputs are parallel and
correct length without needing Postgres up):

```bash
cd server && npx tsx -e "
const chunks = ['a'.repeat(900), 'b'.repeat(900), 'c'.repeat(900)];
const embeddings = [[0.1,0.2],[0.3,0.4],[0.5,0.6]];
const rows = chunks.map((c,i)=>({content:c, embedding:\`[\${embeddings[i].join(',')}]\`}));
console.log('contents:', rows.length, 'embeddings doc:', rows[0].embedding.slice(0,20));
if (rows.length !== chunks.length) process.exit(1);
if (!rows.every(r=>r.content.length>0 && r.embedding.startsWith('['))) process.exit(1);
console.log('PARAMS OK');
process.exit(0);
"
```

Expected: prints `contents: 3 ... [0.1,0.2` and `PARAMS OK`, exit 0.

### Step 3: (Optional) integration check — run against Postgres if available

If `docker compose up -d postgres` is running locally (see AGENTS.md), you can
exercise the batching end-to-end without the LLM by calling the insert helper
directly. Prepare by creating a throwaway source/source row via `psql`, then
run a one-off `npx tsx` script that calls the new INSERT with 2 fake chunks and
verifies 2 rows land. If Postgres is not up, skip this step and rely on Steps
1–2 — say so in your report.

## Test plan

- No framework exists. The machine checks are typecheck + the param smoke above.
- When a test baseline lands (see plans/README), add a unit test asserting the
  mapper returns `rows.length === chunks.length` with valid parallel arrays.

## Done criteria

ALL must hold:

- [ ] `cd server && npm run typecheck` exit 0
- [ ] Step 2 smoke prints `PARAMS OK` and exits 0
- [ ] `grep -n "unnest" server/src/ingest.ts` finds the new single INSERT
- [ ] `grep -c "INSERT INTO chunks" server/src/ingest.ts` returns 1
- [ ] No files outside `server/src/ingest.ts` modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at "Current state" doesn't match the live file.
- The batched INSERT fails with a pg type error (e.g. vector cast) — revert to
  the loop rather than improvising a schema change.
- You discover chunks can be zero-length with a non-empty `chunks` array (the
  `rows.length` guard already handles the empty case).
- The embedding count and chunk count can differ (check: `embed(chunks)`
  returns one vector per input; if a provider returns fewer, that's an
  upstream bug — STOP and report).

## Maintenance notes

- If `EMBEDDING_BATCH` or chunk-size config is added later, the unnest insert
  stays valid for any array length.
- The `::vector[]` cast requires the `vector` type array support in the
  pgvector extension; the schema already uses `vector(${dim})` so this is
  available.
- A reviewer should confirm the single INSERT sends at most a few MB per
  request (hundreds of 800-char chunks ≈ well under 1 MB of params).
