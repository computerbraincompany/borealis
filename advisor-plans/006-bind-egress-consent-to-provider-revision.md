# Plan 006: Bind egress consent and outbound calls to the current provider origin

> **Executor instructions**: Execute this plan step by step. Preserve both the
> early route/automation gate and an exact-snapshot authorization at every
> workspace-content model boundary. Never log prompts, source text, recognized
> OCR text, endpoint URLs, credentials, raw provider output, or provider error
> bodies. Preserve Plans 034-036 exactly as described below; in particular, do
> not turn qualification into durable consent, weaken embedding-migration
> identity checks, or replace the durable ingestion embedding-session contract
> with per-batch live Settings reads. Stop on any STOP condition. A reviewer
> maintains `advisor-plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat f1b9293..HEAD -- server/src/db/migrations.ts server/src/db/stores/chatStore.ts server/src/settingsStore.ts server/src/runtimeSettings.ts server/src/egressPolicy.ts server/src/egressAudit.ts server/src/routes/consent.ts server/src/routes/chats.ts server/src/routes/connectors.ts server/src/routes/models.ts server/src/routes/embeddingMigration.ts server/src/llm.ts server/src/agent.ts server/src/retrieve.ts server/src/ingestionEmbedding.ts server/src/ingestionEngine.ts server/src/ingest.ts server/src/embeddingMigration.ts server/src/automationRunner.ts server/src/tests/fixtures/sqlite server/src/tests/sqliteFoundation.test.ts server/src/tests/egressConsent.test.ts server/src/tests/modelRoutes.test.ts server/src/tests/sourceManagementRoutes.test.ts server/src/tests/agentModel.test.ts server/src/tests/ingestionEmbedding.test.ts server/src/tests/ingestionEngine.test.ts server/src/tests/embeddingMigration.test.ts server/src/tests/embeddingMigrationRoutes.test.ts server/src/tests/llm.test.ts server/src/tests/retrieve.test.ts server/src/tests/thinkSplitter.test.ts server/src/tests/connectorRoutes.test.ts server/src/tests/automations.test.ts README.md docs/API.md AGENTS.md`
> Plans 003 and 005 are prerequisites. Completed Plans 031, 034, 035, and 036
> are required baseline drift and must match the contracts recorded here. Any
> other material drift is a STOP condition.

## Status

- **State**: TODO
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/003-add-historical-migration-fixtures.md`, `advisor-plans/005-bind-provider-credentials-to-origin.md`, `advisor-plans/031-paginate-resource-catalogs.md`
- **Preserve completed baseline**: Plans 031, 034, 035, and 036
- **Category**: security
- **Planned at**: commit `f1b9293`, 2026-08-30; rebased onto the
  2026-09-01 Plan 031/034/035/036 baseline

## Why this matters

Durable consent is currently only a timestamp. Once an account acknowledges one
remote provider, that scalar authorizes every later remote origin. Regular chat
and retrieval calls also resolve live Settings inside the LLM helper after the
route gate, so an origin can change between authorization and transport.

Completed Plan 036 closed this race for queued ingestion in a narrow and correct
way: each durable job creates one account-authorized embedding session from one
immutable provider snapshot immediately before its first embedding transport,
then every batch stays on that session. The session still accepts any non-null
timestamp, however. Completed Plan 035 has the same residual defect in its
affected-account migration checks. This plan binds those existing exact-snapshot
flows to the acknowledged origin and closes the remaining chat, retrieval, and
scheduled-connector gaps without reopening their architecture.

## Current state after Plans 031 and 034-036

- Plan 031 owns SQLite schema v12 exclusively for the account/order catalog
  indexes. This plan owns v14; v15 and v16 remain reserved for Plans 012 and 020.
- Schema v4 added only `users.remote_egress_ack_at`. `ChatStore` reads and
  writes that scalar independently, so no durable destination is remembered.
- `egressPolicy.ts` reads the timestamp and live effective Settings separately.
  `requireRemoteEgressConsent(accountId)` therefore proves only that _some_
  remote provider was acknowledged.
- Protected chat, upload, reingest, connector create/sync/schedule, embedding-
  migration start, and agent-turn automation paths have early gates. Keep those
  gates for fail-fast behavior and for preventing request-body or durable
  mutation work when the mismatch is already known.
- `streamingChat`, `chatOnce`, and `embed` do not require an account. Their
  internal runtime resolver calls `getRuntimeSettings()`, and `retrieve` calls
  the account-less embed helper. A Settings change after an early gate can
  therefore retarget prompt/history/tool context or a retrieval query.
- `createAuthorizedIngestionEmbeddingSession(accountId)` already captures one
  `RuntimeSettingsSnapshot`, checks the owning account, builds one embedding
  executor from that exact settings object, and returns it to
  `IngestionExecutorDependencies.createEmbeddingSession`. Every durable batch,
  including OCR-derived text, uses that session. Its only defect is the scalar
  timestamp check.
- Plan 035's migration captures a qualified baseline/target provider snapshot,
  persists a content-free provider revision, validates live/staged/backup index
  identity, and embeds through one target executor. Its bounded manifest-account
  checks still query only `remote_egress_ack_at`.
- Plan 034 qualification is intentionally different from workspace consent. A
  remote draft requires an explicit request-local acknowledgment of the exact
  canonical draft origin, sends only fixed synthetic probes, and persists no
  consent. That contract is already complete.
- Manual connector operations and schedule creation gate early, but a due
  `connector_sync` automation can call `syncConnector` without a consent check.
  The later ingestion session prevents model transport, but scheduled work must
  also fail fast before it reserves or downloads a refresh.
- Existing public behavior remains settled: loopback/private providers never
  gate; the consent response is
  `{required,acknowledged_at,endpoint_host}`; the stable denial is
  `403 REMOTE_EGRESS_CONSENT_REQUIRED`; endpoint host may be returned to its
  authenticated account or stored in the content-free audit ledger, but no
  endpoint URL or host is logged.

## Target contract

- SQLite schema v14 adds nullable `users.remote_egress_ack_origin`, containing
  only the canonical bare remote origin and bounded to the Settings endpoint
  limit. Existing timestamp rows migrate with a null origin and are therefore
  unacknowledged for every remote provider until the account consents again.
- A remote acknowledgment writes timestamp and canonical origin atomically.
  Consent for remote A never authorizes remote B. The row remembers one most-
  recently acknowledged remote origin: A -> B without acknowledging B remains
  blocked; returning to A reuses A until B is acknowledged; acknowledging B
  replaces A. A POST while the effective provider is loopback/private neither
  overwrites the remembered pair nor emits a consent event.
- Public state keeps its existing shape. For a remote provider,
  `acknowledged_at` is non-null only when the stored timestamp and stored origin
  match the exact current canonical origin. Loopback/private remains ungated
  and may continue displaying the remembered timestamp for compatibility; its
  `endpoint_host` remains null. The stored origin is never returned.
- Durable consent is bound to an origin, not to a model or credential revision.
  Runtime revision is instead the time-of-check/time-of-use authority: every
  ordinary chat or retrieval transport captures one immutable
  `RuntimeSettingsSnapshot`, authorizes a credential-free projection containing
  that snapshot's revision and canonical origin, and obtains the SDK client for
  that same snapshot. No second Settings read may retarget the authorized
  payload.
- Plan 005's credential-origin binding remains authoritative. The consent
  policy may inspect only the credential-free origin/revision projection; it
  must not persist, return, compare, or log credential material.
- Durable ingestion preserves Plan 036's one-session-per-job contract. Session
  creation authorizes the exact captured snapshot against the stored origin,
  records the exact host, and constructs the existing operation-scoped
  executor. It does not re-read live Settings per batch and does not replace
  `createEmbeddingSession` with a direct `dependencies.embed(...)` API.
- Embedding migration preserves Plan 035's qualification snapshot, provider-
  revision admission check, immutable manifest, target executor, index identity
  markers/receipts, and journaled swap. Every affected account must acknowledge
  the exact migration provider origin, with a bounded fail-fast manifest check
  at start/retry and a check for the accounts represented in each batch
  immediately before transport. Qualification is evidence of capability, never
  consent.
- Early request and automation gates remain. A scheduled connector refresh with
  missing or stale consent records a bounded generic skipped outcome before
  connector reservation, download, or provider work. A refresh already queued
  across a Settings change still relies on the exact durable ingestion session
  before any extracted, tabular, or OCR-derived content reaches embeddings.
- Content-free audit attribution uses the host from the exact authorized target
  or persisted acknowledgment. No audit helper may re-read live Settings and
  attribute an A-authorized operation to B.

## Commands you will need

| Purpose                     | Command                                                                                                                                                                                                | Expected on success                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Migration                   | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts`                                                                               | exit 0; all v1-v12 starts reach v14                                       |
| Consent store/policy        | `pnpm --filter borealis-server exec vitest run src/tests/egressConsent.test.ts`                                                                                                                        | exit 0; a v12 timestamp without origin is unacknowledged                  |
| Chat/retrieval boundary     | `pnpm --filter borealis-server exec vitest run src/tests/llm.test.ts src/tests/agentModel.test.ts src/tests/retrieve.test.ts src/tests/thinkSplitter.test.ts`                                          | exit 0; no unacknowledged destination receives a request                  |
| Ingestion/migration         | `pnpm --filter borealis-server exec vitest run src/tests/ingestionEmbedding.test.ts src/tests/ingestionEngine.test.ts src/tests/embeddingMigration.test.ts src/tests/embeddingMigrationRoutes.test.ts` | exit 0; existing immutable sessions and migration snapshots remain intact |
| Route/automation regression | `pnpm --filter borealis-server exec vitest run src/tests/modelRoutes.test.ts src/tests/sourceManagementRoutes.test.ts src/tests/connectorRoutes.test.ts src/tests/automations.test.ts`                 | exit 0; stale consent mutates nothing                                     |
| Full server tests           | `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration`                                                                                                                 | exit 0                                                                    |
| Static gates                | `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`                                                                          | exit 0                                                                    |

Do not install dependencies, call a live provider, inspect real credentials, or
run a broad formatter. Use generated loopback test providers only.

## Scope

**In scope**:

- `server/src/db/migrations.ts`
- `server/src/db/stores/chatStore.ts`
- `server/src/settingsStore.ts` only if Plan 005's canonical, credential-free
  origin helper needs to be exported
- `server/src/runtimeSettings.ts`
- `server/src/egressPolicy.ts`
- `server/src/egressAudit.ts`
- `server/src/routes/consent.ts`
- `server/src/routes/chats.ts`
- `server/src/routes/connectors.ts`
- `server/src/routes/embeddingMigration.ts`
- `server/src/llm.ts`
- `server/src/agent.ts`
- `server/src/retrieve.ts`
- `server/src/ingestionEmbedding.ts`
- `server/src/embeddingMigration.ts`
- `server/src/automationRunner.ts`
- `server/src/tests/fixtures/sqlite/v014.sql` (create)
- the focused server tests named in the commands table
- `README.md`
- `docs/API.md`
- `AGENTS.md`

**Out of scope**:

- Schema v15 or later, or any unrelated migration.
- Replacing the single remembered origin with a consent history/set, adding a
  revoke API, multi-provider credentials, roles/admin UI, or public consent
  fields.
- Changing which classes of workspace content require remote-provider consent.
- Gating body-free model discovery/health probes.
- Changing Plan 034's fixed synthetic qualification probes, request-local draft
  acknowledgment, streamed tool-call validation, or vector checks.
- Changing Plan 035's model-pair qualification, provider snapshot, embedding-
  identity marker/receipt, staged-index, swap, or recovery contracts.
- Changing OCR classification, helper execution, recognized-text budgets, or
  packaging. OCR text inherits the ingestion session exactly like parsed text.
- Replacing `IngestionExecutorDependencies.createEmbeddingSession`, adding a
  direct per-batch production embed dependency, or re-reading live Settings for
  every durable ingestion batch.
- Expanding egress audit payloads; they remain content-free and best effort.

## Git workflow

- Branch: `codex/006-bind-egress-consent-to-provider-revision`
- Recommended commits:
  1. `feat(db): bind egress consent to provider origin`
  2. `fix(security): authorize exact provider snapshots`
  3. `test(server): cover provider consent races`
- Do not push, open a PR, edit the plan index, or include real endpoint or
  credential values in commits.

## Steps

### Step 1: Add schema v14 and its immutable historical fixture

Require the starting `LATEST_SQLITE_SCHEMA_VERSION` to be exactly 13, with v12
containing only Plan 031's catalog indexes and v13 containing the agent editor foundation. Add `SCHEMA_V14` with one nullable
`users.remote_egress_ack_origin` column. Apply the same endpoint-length ceiling
used by Settings with a column CHECK, and append exactly `{version: 14, ...}` to
the ordered migration list. Do not backfill the column: the old timestamp does
not identify a trustworthy destination.

Add `server/src/tests/fixtures/sqlite/v014.sql` through Plan 003's immutable
delta contract. Extend the foundation assertions for the column and prove that
a v12 fixture user with a non-null timestamp upgrades with a null origin, while
seeded historical data and foreign keys remain intact.

**Verify**:
`pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts`
-> exit 0; fixture inventory is exactly v001-v014 and every v1-v12 start reaches
v14.

### Step 2: Store one atomic timestamp/origin acknowledgment

Replace the scalar ChatStore methods with a typed internal record containing
`acknowledgedAt` and `origin`. Read both columns in one scoped query and write
both in one UPDATE. The writer must accept only the canonical bare origin
returned by the Settings endpoint parser, enforce its bound, and preserve the
account-not-found behavior. A malformed/null stored origin is never a match;
fail closed without exposing it.

Use Plan 005's canonical origin parser/equivalence primitive rather than adding
a second URL policy. Update every direct SQL fixture that means "acknowledged"
to write both fields. Timestamp-only fixtures remain intentional only where a
test proves the v14 fail-closed migration.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/egressConsent.test.ts`
-> exit 0 with paired round-trip, malformed stored origin, legacy timestamp,
and account-not-found coverage.

### Step 3: Make consent policy operate on credential-free exact targets

Introduce one immutable internal authorization target derived from a runtime
snapshot, containing only its revision, canonical provider origin, locality,
and bounded host. It must contain no API key, models, prompt, or content. Add a
policy primitive that accepts an account plus this already-captured target,
compares the stored pair with that exact origin, and returns the target unchanged
or throws `RemoteEgressConsentRequiredError`. It must never fetch Settings.

Refactor `remoteEgressState` and the early route adapter to capture one runtime
snapshot, derive the target, and evaluate the pair. Preserve the public shape and
stable 403. Let internal callers receive the authorized target so any associated
audit records its host rather than asking `auditRemoteEgress` to resolve live
Settings again.

Acknowledgment is the one intentional multi-snapshot operation:

1. capture current effective Settings;
2. if it is local/private, do not write or audit anything;
3. if it is remote, atomically persist its timestamp/origin pair;
4. re-read public state so a concurrent switch is visible; and
5. return an internal result containing the public state plus only the host
   actually persisted for audit.

If Settings race from A to B after A is stored, the response describes
unacknowledged B, the durable pair remains A, and the one content-free audit row
names A. A local/private POST preserves the old pair and audit count.

Test A -> acknowledge -> B blocked/null public timestamp -> A allowed; then
acknowledge B and prove A is blocked. Cover canonicalization, local/private
bypass, the acknowledgment race, and exact audit attribution.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/egressConsent.test.ts`
-> exit 0.

### Step 4: Authorize the exact runtime revision for chat and retrieval

Refactor the revision-scoped LLM runtime resolver so it can build/reuse a client
from an explicitly supplied `RuntimeSettingsSnapshot`; it must not call
`getRuntimeSettings()` again after authorization. Add a narrow helper for
ordinary account-owned model traffic that:

1. captures `getRuntimeSettings()` exactly once;
2. derives and authorizes its credential-free target for the required account;
3. obtains the SDK runtime for that same captured revision; and
4. returns no credential-bearing value outside the LLM module.

Require `accountId` in `ChatOptions`/`StreamingChatOptions`. Require an options
object such as `{accountId, signal?}` for the ordinary `embed(texts, options)`
API. Pass the owning account from `runAgent`, `retrieve`, and every production
caller. Preserve aliases, chat model selection, streamed tool-call accumulation,
timeouts, finite float32 vector validation, and error sanitization.

Keep the specialized `qualifyModelPair(settings, ...)` and
`createEmbeddingExecutor(settings, model)` paths settings-explicit. They are
used only after their own exact draft/migration/session authorization and must
not re-resolve live Settings. Model discovery remains body-free and ungated.

Add deterministic races proving:

- a switch to unacknowledged B before snapshot capture yields zero B requests;
- a switch after authorized A is captured cannot retarget the call: A may
  complete and B records zero requests; and
- the next agent round/retrieval call captures B and is rejected until B is
  acknowledged.

Do not include payload text in failure assertions or snapshots.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/llm.test.ts src/tests/agentModel.test.ts src/tests/retrieve.test.ts src/tests/thinkSplitter.test.ts`
-> exit 0.

### Step 5: Extend, do not replace, Plan 036's ingestion session

In `createAuthorizedIngestionEmbeddingSession(accountId)`, keep the existing
order and lifetime: capture one runtime snapshot after extraction/staging and
immediately before the first embedding call, authorize that exact target, audit
its exact host, and create one embedding executor from the same settings object.
Return the existing `IngestionEmbeddingSession`; all later batches remain bound
to it even if live Settings changes.

Do not change `IngestionExecutorDependencies.createEmbeddingSession`, restore a
direct `dependencies.embed(...)` callback, or add per-batch Settings reads.
Preserve the worker's mapping of authorization failure to the stable
`REMOTE_EGRESS_CONSENT_REQUIRED` ingestion detail. Text extracted by PDFKit,
Vision OCR, DOCX, CSV, JSON, or XLSX all reaches the same boundary.

Extend `ingestionEmbedding.test.ts` to prove an A timestamp paired with B origin
is denied with zero executor/transport work, an authorized A session never
retargets to later B, each owning account is checked independently, the audit
host is A, and the runtime snapshot is read exactly once. Keep the ingestion
engine tests focused on session acquisition and durable safe failure rather than
mocking a superseded per-batch API.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/ingestionEmbedding.test.ts src/tests/ingestionEngine.test.ts`
-> exit 0.

### Step 6: Apply origin consent inside Plan 035's immutable migration

Keep migration admission, qualification, target Settings construction,
provider-revision hashing, immutable snapshot manifest, target executor,
identity markers/receipts, and swap recovery unchanged. Update only its remote-
consent checks:

- bounded manifest-account prechecks at start and retry must read timestamp and
  origin and compare every affected account with the exact canonical origin in
  the already-validated migration Settings;
- immediately before each provider embedding batch, check the unique account
  IDs represented by that batch against the same target origin; and
- remote-ingest audit rows use the target Settings host already held by the
  migration, never a live runtime read.

A replacement acknowledgment or mismatch during a build stops before the next
transport and persists only the existing stable aggregate failure code. It must
not store an origin, credential, passage, provider body, or affected account ID
in migration state. A local/private target remains ungated.

Qualification success must not satisfy this check: Plan 034's explicit draft
acknowledgment authorizes only its synthetic probes. Preserve the route's
qualified baseline/target handoff and the coordinator's exact admission reread.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/embeddingMigration.test.ts src/tests/embeddingMigrationRoutes.test.ts`
-> exit 0 with two-account mismatch, A/B replacement during build, zero next-
batch transport, exact audit host, and unchanged provider/identity recovery
coverage.

### Step 7: Close scheduled connector and route races

Retain the early origin-aware gate before chat acceptance, upload, reingest,
manual connector create/sync/schedule, and embedding-migration start. Add the
same check at the start of a due `connector_sync` automation, before connector
lookup, refresh reservation, download, or mutation. On denial, record only the
bounded generic skipped automation/history outcome and make no provider call.

Keep the agent-turn automation's early check; the account-scoped streaming LLM
boundary from Step 4 remains the final race check. Keep the durable connector
ingestion session from Step 5 as the final model-transport boundary for a job
that was already queued before Settings changed.

Route tests must prove that consent for A cannot accept a chat turn, reserve an
upload/reingest, create or sync a connector, create a schedule, or start a
migration after switching to B. Automation tests must prove a stale scheduled
connector makes no `syncConnector` call and an agent race sends nothing to B.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/modelRoutes.test.ts src/tests/sourceManagementRoutes.test.ts src/tests/connectorRoutes.test.ts src/tests/automations.test.ts`
-> exit 0.

### Step 8: Document origin-scoped consent and run every server gate

Update README privacy guidance, `docs/API.md`, and the repository invariants in
`AGENTS.md` to state:

- consent is per account and canonical remote provider origin;
- changing remote origins requires consent again;
- pre-v14 timestamp-only rows are intentionally unacknowledged;
- qualification's request-local synthetic-probe acknowledgment is not durable
  workspace consent;
- chat and retrieval authorize one exact runtime revision per call;
- queued ingestion, including OCR text, uses one exact session before transport;
  and
- managed migration checks every affected account without weakening its
  qualification/provider/index-identity contracts.

Do not expose `remote_egress_ack_origin` as a public field or document raw
provider URLs, credentials, or payload-bearing audit data.

**Verify**:

- `pnpm --filter borealis-server test` -> exit 0.
- `pnpm --filter borealis-server test:integration` -> exit 0.
- `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`
  -> exit 0.
- `rg -n 'remote_egress_ack_at' server/src --glob '*.ts'` -> every direct read
  used as authorization also reads/compares the v14 origin; timestamp-only
  references are migration/legacy characterization only.
- `rg -n 'getRuntimeSettings\(|getEffectiveLlmSettings\(' server/src/llm.ts server/src/egressAudit.ts server/src/ingestionEmbedding.ts`
  -> ordinary authorized call/session paths have exactly one intentional
  snapshot read and no live audit reread.

## Test plan

- Migration: v12 timestamp upgrades with null origin; every v1-v12 fixture
  reaches v14; fresh installs have the bounded pair.
- Store/policy: atomic pair, malformed/null origin fail closed, A/B mismatch,
  A/B replacement semantics, canonical same-origin match, local/private bypass,
  concurrent acknowledgment switch, and exact audit attribution.
- Chat/LLM: account identity is mandatory; an authorized runtime revision owns
  both consent and client; pre-capture B is denied and post-capture B cannot
  retarget A.
- Retrieval: the query-embedding boundary receives the owning account and makes
  zero calls to an unacknowledged origin.
- Ingestion/OCR: existing one-session lifetime remains; queued stale work fails
  before transport and an authorized session never changes provider mid-job.
- Migration: all manifest accounts match the exact target origin at admission,
  retry, and per-batch transport while the qualified provider and index identity
  invariants remain unchanged.
- Connectors/automations: manual paths reject before mutation; due scheduled
  sync rejects before reservation/download; already-queued work is stopped by
  the ingestion session.
- Compatibility: public consent shape/error code, model qualification, model
  aliases, float32 validation, OCR, migration recovery, and content-free audit
  schemas do not change.

## Done criteria

- [ ] Schema version is exactly 14 and `v014.sql` is the immutable consent-
      origin delta after Plan 031's v12 indexes.
- [ ] Old timestamp-only rows are unacknowledged for every remote origin until
      re-consent.
- [ ] Consent for A never authorizes or audits B.
- [ ] A concurrent A -> B switch cannot retarget chat, retrieval, ingestion, or
      migration payloads.
- [ ] Ordinary chat and retrieval calls authorize/use one exact runtime
      revision and require the owning account.
- [ ] Plan 036's one-session durable ingestion contract remains intact; no
      direct per-batch production embed dependency is reintroduced.
- [ ] Plan 035's qualification/provider/index-identity contracts remain intact,
      and every affected migration account matches the exact target origin.
- [ ] Plan 034 qualification remains synthetic, request-local, and non-
      persistent.
- [ ] Early route and scheduled-automation gates reject stale consent before
      payload processing or durable mutation.
- [ ] Public consent shape and stable error/failure codes are unchanged.
- [ ] No URL, credential, prompt, source/OCR text, provider output, or raw tool
      payload is logged or persisted in new state.
- [ ] Focused, full server, integration, typecheck, lint, and format gates pass.
- [ ] Only in-scope implementation, test, fixture, and documentation files are
      modified.

## STOP conditions

Stop and report if:

- Plan 003 or Plan 005 is incomplete;
- `LATEST_SQLITE_SCHEMA_VERSION` is not exactly 13 with v12 exclusively owned by
  Plan 031's catalog indexes and v13 owned by the agent editor foundation when this plan starts, or another change owns v14;
- Plan 034 no longer uses fixed synthetic probes plus exact request-local draft
  acknowledgment, or its qualification result is being treated as durable
  consent;
- Plan 035 no longer retains an exact qualified provider snapshot, immutable
  migration manifest, target-only executor, and model/dimension identity
  markers/receipts through recovery;
- Plan 036 no longer provides
  `IngestionExecutorDependencies.createEmbeddingSession(accountId)` with one
  immutable provider snapshot per durable job;
- a production workspace-content model call cannot be associated with an exact
  owning account (multi-account migration batches may use their bounded exact
  account set);
- authorization would require placing credentials, URLs, content, or account
  lists into the consent row, audit log, migration state, run detail, or public
  error;
- a background ingestion or migration batch can reach provider transport
  without the exact origin check described above;
- public consent response compatibility or the stable failure codes would have
  to break; or
- any verification fails twice after one reasonable correction.

## Maintenance notes

- Every future ordinary workspace-content model call must use the account-
  scoped exact-snapshot boundary. Direct use of a raw OpenAI client is allowed
  only for body-free discovery or a settings-explicit, fixed synthetic
  qualification path with its own authorization.
- Durable consent follows the canonical destination origin. Runtime revision is
  deliberately operation authority rather than a persisted consent field, so a
  same-origin model/key change does not demand new privacy consent while still
  being unable to retarget an in-flight payload.
- Future durable multi-batch jobs should follow the ingestion-session pattern:
  authorize once immediately before first transport, then retain the immutable
  client/settings snapshot. Do not authorize live Settings and construct a
  client later.
- If simultaneous provider origins are added later, replace the single stored
  origin through a new schema migration; do not overload the timestamp or place
  a serialized set in v14.
- Schema v15 remains reserved for Plan 012 automation target ownership and v16
  for Plan 020 typed connector-refresh state. Do not reuse or reorder them.
