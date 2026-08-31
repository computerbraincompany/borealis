# Plan 006: Bind egress consent and outbound calls to the current provider origin

> **Executor instructions**: Execute this plan step by step. Preserve both the
> early route gate and a same-snapshot gate at the actual model-call boundary.
> Never log prompts, source text, endpoint URLs, credentials, or provider bodies.
> Stop on any STOP condition. A reviewer maintains `advisor-plans/README.md`; do
> not edit it.
>
> **Drift check (run first)**:
> `git diff --stat f1b9293..HEAD -- server/src/db/migrations.ts server/src/db/stores/chatStore.ts server/src/settingsStore.ts server/src/egressPolicy.ts server/src/routes/consent.ts server/src/llm.ts server/src/agent.ts server/src/retrieve.ts server/src/ingestionEngine.ts server/src/ingest.ts server/src/automationRunner.ts server/src/tests/fixtures/sqlite server/src/tests/sqliteFoundation.test.ts server/src/tests/egressConsent.test.ts server/src/tests/modelRoutes.test.ts server/src/tests/sourceManagementRoutes.test.ts server/src/tests/agentModel.test.ts server/src/tests/ingestionEngine.test.ts server/src/tests/llm.test.ts server/src/tests/retrieve.test.ts server/src/tests/thinkSplitter.test.ts server/src/tests/connectorRoutes.test.ts README.md docs/API.md`
> Plan 003 and Plan 005 are declared dependencies; drift caused only by those
> plans is expected and must match their documented contracts. Other material
> drift is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/003-add-historical-migration-fixtures.md`, `advisor-plans/005-bind-provider-credentials-to-origin.md`
- **Category**: security
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Consent is currently represented only by a timestamp. Once an account
acknowledges any remote provider, the timestamp authorizes every later remote
origin. There is also a time-of-check/time-of-use gap: routes gate before
accepting a turn or upload, while the agent or background ingestion worker reads
live settings later. Bind the durable acknowledgment to the canonical remote
origin and make each payload-bearing model call authorize and use one immutable
runtime snapshot.

## Current state

- `server/src/db/migrations.ts:342-344` added only a timestamp in v4:

  ```sql
  ALTER TABLE users ADD COLUMN remote_egress_ack_at TEXT;
  ```

- `server/src/db/stores/chatStore.ts:483-502` reads that scalar and updates it
  independently:

  ```ts
  async getRemoteEgressAckAt(accountIdValue: string): Promise<string | null> {
    const row = await this.ledger.get<{ remote_egress_ack_at?: unknown }>(
      "SELECT remote_egress_ack_at FROM users WHERE id=?",
      [identity(accountIdValue, "account id")]
    );
    if (!row) throw new StoreNotFoundError("user");
    const raw = row.remote_egress_ack_at;
    return raw === null || raw === undefined ? null : requiredString(raw, "remote egress acknowledgment");
  }
  ```

  The paired write is also currently timestamp-only
  (`server/src/db/stores/chatStore.ts:494-501`):

  ```ts
  async acknowledgeRemoteEgress(accountIdValue: string, acknowledgedAtValue: string): Promise<void> {
    const acknowledgedAt = inputString(acknowledgedAtValue, "remote egress acknowledgment", 64);
    const updated = await this.ledger.run("UPDATE users SET remote_egress_ack_at=? WHERE id=?", [
      acknowledgedAt,
      identity(accountIdValue, "account id"),
    ]);
    if (updated.changes !== 1) throw new StoreNotFoundError("user");
  }
  ```

- `server/src/egressPolicy.ts:37-60` obtains live settings separately from the
  scalar acknowledgment and decides solely from `acknowledged_at`:

  ```ts
  async function stateFor(accountId: string, acknowledgedAt: string | null): Promise<RemoteEgressState> {
    const settings = await getEffectiveLlmSettings();
    const required = isRemoteProvider(settings.llmBaseUrl);
    return {
      required,
      acknowledged_at: acknowledgedAt,
      endpoint_host: required ? endpointHost(settings.llmBaseUrl) : null,
    };
  }

  /** The consent-state view for the authenticated account. */
  export async function remoteEgressState(accountId: string): Promise<RemoteEgressState> {
    const acknowledgedAt = await storageRuntime().chats.getRemoteEgressAckAt(accountId);
    return stateFor(accountId, acknowledgedAt);
  }

  /**
   * The fail-closed egress gate for payload-bearing routes. It throws only when a
   * remote provider is configured and this account has not acknowledged remote
   * egress; loopback and private-network providers never gate.
   */
  export async function requireRemoteEgressConsent(accountId: string): Promise<void> {
    const state = await remoteEgressState(accountId);
    if (state.required && !state.acknowledged_at) throw new RemoteEgressConsentRequiredError();
  }
  ```

- `server/src/routes/chats.ts:252` gates before `acceptChatTurn`, but
  `server/src/agent.ts:249` calls `streamingChat` later. The latter resolves live
  settings inside `server/src/llm.ts`, so an origin change can occur between the
  gate and the outbound request.
- `server/src/routes/sources.ts:103,164` gates before reserving ingestion, while
  `server/src/ingestionEngine.ts:183-189` can embed staged source text much later:

  ```ts
  let embeddings: number[][];
  try {
    embeddings = await this.dependencies.embed(batch.map((chunk) => chunk.content));
  } catch {
    throw new IngestionStageError("EMBEDDING_UNAVAILABLE");
  }
  ```

- `server/src/retrieve.ts:9-17` embeds the user's retrieval query without an
  account-scoped authorization at the LLM boundary.
- `server/src/automationRunner.ts:78-87` performs an early consent check before
  accepting an automated turn. Keep it, but do not rely on it as the final gate.
- `server/src/tests/egressConsent.test.ts:89-108` proves switching back to
  loopback lifts the gate, but it does not switch from acknowledged remote A to
  remote B.
- `server/src/tests/connectorRoutes.test.ts:555-558` writes the timestamp column
  directly; update direct test fixtures to include the bound origin after v12.
- Settled behavior: loopback/private providers never gate; remote provider
  payloads gate before request processing; acknowledgment takes effect without
  restart; endpoint host may be returned to the authenticated account but never
  logged.

## Target contract

- SQLite schema v12 adds nullable `users.remote_egress_ack_origin` (canonical
  bare origin, bounded text). Existing timestamp rows migrate with a null origin
  and therefore become unacknowledged until the account consents again.
- Acknowledgment writes timestamp and current canonical remote origin together.
- Public state keeps `{required,acknowledged_at,endpoint_host}`. When the stored
  origin does not match the current remote origin, `acknowledged_at` is `null`.
- Consent for remote A does not authorize remote B. The single row remembers
  only the most recently acknowledged remote origin: switching A → B without
  acknowledging B leaves A stored, so returning to A reuses it; acknowledging B
  replaces A, so a later return to A requires consent again. Loopback/private
  remains ungated and does not overwrite the remembered remote origin.
- Every payload-bearing chat or embedding call obtains one runtime settings
  snapshot, validates that exact snapshot's origin against the account's stored
  consent, and constructs/uses the client for the same snapshot. No second live
  settings read may retarget the authorized payload.
- Early route and automation gates remain for fail-fast/no-payload-processing
  behavior. The immediate LLM gate closes races and protects background work.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Migration | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts` | exit 0; all historical fixtures reach v12 |
| Consent store/policy | `pnpm --filter borealis-server exec vitest run src/tests/egressConsent.test.ts` | exit 0; a v11 timestamp without an origin is unacknowledged |
| Route regression | `pnpm --filter borealis-server exec vitest run src/tests/modelRoutes.test.ts src/tests/sourceManagementRoutes.test.ts src/tests/connectorRoutes.test.ts` | exit 0 |
| Agent/ingestion regression | `pnpm --filter borealis-server exec vitest run src/tests/agentModel.test.ts src/tests/ingestionEngine.test.ts src/tests/llm.test.ts src/tests/retrieve.test.ts src/tests/thinkSplitter.test.ts` | exit 0; mismatched origin makes no outbound call |
| Full server tests | `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration` | exit 0 |
| Static gates | `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check` | exit 0 |

Do not install, build, format, call a live provider, or inspect real credentials.

## Scope

**In scope**:

- `server/src/db/migrations.ts`
- `server/src/db/stores/chatStore.ts`
- `server/src/settingsStore.ts`
- `server/src/egressPolicy.ts`
- `server/src/routes/consent.ts`
- `server/src/llm.ts`
- `server/src/agent.ts`
- `server/src/retrieve.ts`
- `server/src/ingestionEngine.ts`
- `server/src/ingest.ts`
- `server/src/automationRunner.ts`
- `server/src/tests/fixtures/sqlite/v012.sql` (create)
- `server/src/tests/sqliteFoundation.test.ts`
- `server/src/tests/egressConsent.test.ts`
- `server/src/tests/modelRoutes.test.ts`
- `server/src/tests/sourceManagementRoutes.test.ts`
- `server/src/tests/agentModel.test.ts`
- `server/src/tests/ingestionEngine.test.ts`
- `server/src/tests/llm.test.ts`
- `server/src/tests/retrieve.test.ts`
- `server/src/tests/thinkSplitter.test.ts`
- `server/src/tests/connectorRoutes.test.ts`
- `README.md`
- `docs/API.md`

**Out of scope**:

- Schema v13 or later, and any unrelated migration.
- A consent history table, multi-provider credential vault, roles/admin UI, or
  new public consent fields.
- Changing which payload classes require consent.
- Gating body-free model discovery/health probes.
- Egress audit event payload expansion; events stay content-free.

## Git workflow

- Branch: `codex/006-bind-egress-consent-to-provider-revision`
- Recommended commits:
  1. `feat(db): bind egress consent to provider origin`
  2. `fix(security): authorize exact provider snapshots`
  3. `test(server): cover provider consent races`
- Do not push, open a PR, edit the plan index, or include endpoints/credentials
  from a real environment.

## Steps

### Step 1: Add schema v12 and its historical fixture

Set `LATEST_SQLITE_SCHEMA_VERSION` to 12. Add `SCHEMA_V12` with one nullable,
bounded text column named `remote_egress_ack_origin` on `users`, and append it as
version 12 to the ordered migration array. Do not backfill from the timestamp:
there is no trustworthy historical origin, so null is the fail-closed migration.

Add `server/src/tests/fixtures/sqlite/v012.sql` using Plan 003's exact immutable
delta format. Extend the foundation assertions for the new column and confirm a
v11 fixture user with a non-null old timestamp and null origin is not treated as
acknowledged by policy after opening through v12.

**Verify**:
`pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts`
→ exit 0; starts v1-v11 reach v12, fixture inventory is contiguous, and foreign
key checks are empty.

### Step 2: Make acknowledgment a paired store record

In `server/src/settingsStore.ts`, export one credential-free helper that parses
and returns the canonical bare model endpoint origin using the exact validation
already applied to `llm_base_url`. Do not duplicate URL rules in the store or
egress policy, and do not expose the helper through an HTTP response.

In `ChatStore`, replace scalar timestamp methods with a typed record such as:

```ts
interface RemoteEgressAcknowledgment {
  readonly acknowledgedAt: string | null;
  readonly origin: string | null;
}
```

Read both columns in one query. Write timestamp and validated canonical origin
in one UPDATE. Bound the stored origin length, reject credentials/path/query/
fragment through the same origin parser used by settings, and preserve
account-not-found behavior. Do not expose this internal origin in chat/user DTOs.

Update direct SQL test setup to set both columns when it intends an acknowledged
remote provider.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/egressConsent.test.ts`
→ exit 0 with store round-trip and old-timestamp/null-origin cases.

### Step 3: Compare consent with one current settings snapshot

Refactor `egressPolicy.ts` so state calculation receives one
`RuntimeSettingsSnapshot`, classifies its origin, and compares the stored origin
with that same canonical origin. `acknowledgeRemoteEgress` must snapshot current
settings once, write that origin with the timestamp, then re-read state; if the
origin changed concurrently, the returned state must remain unacknowledged.

Add an internal authorization function that accepts an already-captured runtime
snapshot and either returns it unchanged or throws
`RemoteEgressConsentRequiredError`. This is the primitive the LLM boundary uses;
it must not fetch settings a second time. Keep the public state shape and stable
403 envelope unchanged.

Test remote A → acknowledge → remote B (blocked/null timestamp) → remote A
(allowed because A remains the last acknowledgment); then acknowledge B and
prove a return to A is blocked because B replaced the single stored origin. Also
cover loopback/private (never gated and does not overwrite) and a settings change
during acknowledgment (fail closed). Never log the origin.

Make the acknowledgment operation return an internal result containing the
public state plus the host of the origin that was actually persisted (or null
when no remote acknowledgment was written). `routes/consent.ts` must send only
the public state and record `consent_acknowledged` against that persisted host,
never `state.endpoint_host` from a later settings reread. If settings race from
A to B after A is stored, the response is correctly unacknowledged for B while
the content-free audit event names A. A POST while the current provider is
loopback/private must not overwrite the remembered remote pair and must not
record a new consent event.

In `egressConsent.test.ts`, deterministically wrap the paired store write so it
switches settings to B after persisting A but before policy rereads state. Assert
the response describes unacknowledged B, the stored pair remains A, and the
single new audit row names A. Also POST while local/private and assert the prior
pair and audit-row count are unchanged. Do not add an endpoint to the public
response or log either host.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/egressConsent.test.ts`
→ exit 0.

### Step 4: Authorize and use the exact snapshot at each LLM boundary

Refactor account-payload LLM APIs so account identity is mandatory with one
low-churn options shape:

- `ChatOptions`/`StreamingChatOptions` carry required `accountId` alongside the
  existing model, signal, timeout-relevant fields, and tool options;
- embeddings keep `texts` as the first argument and take a required options
  object such as `{ accountId, signal? }` as the second argument; and
- the runtime/client resolver can accept a captured snapshot.

For each chat completion or embedding:

1. call `getRuntimeSettings()` exactly once;
2. authorize that exact snapshot through the policy function from Step 3; and
3. obtain/use the cached client corresponding to that snapshot revision.

Do not change body-free discovery/health behavior. Update `runAgent`,
`retrieve`, all production embedding composition, and every direct unit-test or
mock caller to pass the owner account. In particular, update
`llm.test.ts`, `thinkSplitter.test.ts`, `retrieve.test.ts`, and the LLM mocks in
`agentModel.test.ts`. Preserve model aliasing, base64/float embedding behavior,
timeouts, and error sanitization.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/llm.test.ts src/tests/agentModel.test.ts src/tests/retrieve.test.ts src/tests/thinkSplitter.test.ts`
→ exit 0. Add a controlled race test where settings changes from acknowledged A
to unacknowledged B before the outbound call; the B fixture must record zero
requests and no payload may appear in assertion output.

### Step 5: Carry account authorization through background ingestion

Change `IngestionExecutorDependencies.embed` to use the same second-argument
options object and pass `input.accountId` for every batch. Wire production
`embed` accordingly in `server/src/ingest.ts`. A stale/missing remote acknowledgment must fail before
the embedding transport sees chunk text; map the error to the existing safe
ingestion failure envelope without placing provider origin or content in durable
error detail.

Keep the route-level upload/reingest/connector gate: it prevents body processing
when already known to be blocked. The worker-bound gate is additional and covers
queued work after settings changes.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/ingestionEngine.test.ts src/tests/llm.test.ts`
→ exit 0; tests prove account ID reaches each batch and a mismatched current
origin makes zero embedding HTTP requests.

### Step 6: Retain early gates and update route regressions

Keep `enforceRemoteEgressConsent` before chat acceptance and before upload,
reingest, connector create/sync/schedule processing. Keep the automation check
before turn acceptance; the agent's immediate LLM check is the second line.

Update route tests so an acknowledgment for A cannot send a chat, create a
connector schedule, upload, or reingest after switching to B. Assert no turn,
run, source reservation, connector mutation, or provider request occurs before
the stable 403. Use in-memory/loopback fixtures only.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/modelRoutes.test.ts src/tests/sourceManagementRoutes.test.ts src/tests/connectorRoutes.test.ts`
→ exit 0.

### Step 7: Document origin-scoped re-consent

Update README privacy guidance and `docs/API.md` to state that acknowledgment is
per account and canonical remote provider origin; changing remote origins
requires consent again, old pre-v12 timestamps are intentionally unacknowledged,
and background ingestion rechecks immediately before embedding. Do not expose
the stored origin column as a new public response.

**Verify**:
`pnpm --filter borealis-server format:check` → exit 0.

### Step 8: Run the complete server gates

**Verify**:

- `pnpm --filter borealis-server test` → exit 0.
- `pnpm --filter borealis-server test:integration` → exit 0.
- `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`
  → exit 0.
- `rg -n 'remote_egress_ack_at' server/src --glob '*.ts'` → every direct write
  either belongs to the migration/store or also sets the v12 origin column.

## Test plan

- Migration: v11 timestamp migrates with null origin; v1-v11 fixtures upgrade to
  v12; new installs contain both columns.
- Store/policy: paired atomic write, malformed origin rejection, A/B mismatch,
  same-origin match, replacement semantics for the single remembered origin,
  concurrent switch, audit attribution to the origin actually persisted, and
  local/private bypass without overwriting it or recording consent.
- Route: stale consent returns the unchanged 403 before turn/source/connector
  mutation.
- Agent/LLM: same immutable snapshot authorizes and supplies the client; an
  intervening settings change produces zero remote-B requests.
- Retrieval/ingestion: account ID reaches embedding boundary; stale queued work
  cannot send query or chunk text after an origin change.
- Automation: early skip remains, and a later race is stopped by the agent LLM
  boundary.

## Done criteria

- [ ] Schema version is exactly 12, and this plan adds immutable `v012.sql`
      through Plan 003's fixture contract.
- [ ] Old timestamp-only rows are unacknowledged until re-consent.
- [ ] Consent for remote A never authorizes remote B.
- [ ] A concurrent A→B switch cannot misattribute the acknowledgment audit to B,
      and a local/private POST records no remote consent event.
- [ ] Route gates still reject before payload processing.
- [ ] Chat, retrieval, and ingestion model calls authorize/use one exact snapshot.
- [ ] Race tests prove zero outbound calls to an unacknowledged new origin.
- [ ] Public consent shape and stable error code are unchanged.
- [ ] No endpoint URL, credential, prompt, chunk, or provider body is logged.
- [ ] Unit, integration, typecheck, lint, and format gates pass.
- [ ] Only in-scope files are modified.

## STOP conditions

Stop and report if:

- Plan 003 or Plan 005 is incomplete;
- `LATEST_SQLITE_SCHEMA_VERSION` is not 11 plus only the declared dependency
  changes when this plan starts (this plan owns v12; do not renumber around an
  unrelated migration);
- another planned/landed change already owns schema version 12;
- same-snapshot authorization would require passing credentials into policy,
  stores, logs, or durable run rows;
- a production payload-bearing LLM call cannot be associated with an account;
- a background ingest can reach transport without the account-scoped boundary;
- public consent response compatibility would have to break; or
- any verification fails twice after one reasonable correction.

## Maintenance notes

- Every future payload-bearing model call must use the account-scoped,
  same-snapshot boundary. Direct use of a raw OpenAI client is not acceptable.
- If the product later supports multiple simultaneous provider origins, replace
  the single stored origin with an explicit consent set/mapping via a new
  migration; do not overload the timestamp.
- Schema v13 is reserved for later work. Coordinate migration numbers before
  merging concurrent plans.
