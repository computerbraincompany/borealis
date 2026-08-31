# Plan 012: Enforce automation target ownership in SQLite

> **Executor instructions**: Do not start until both dependency plans are DONE. Follow every step and verification gate. If a STOP condition occurs, stop and report; do not renumber or redesign the migration ad hoc. When complete, update this plan's row in `advisor-plans/README.md` unless the reviewer owns index maintenance.
>
> **Drift check (run first, after dependencies)**: `git diff --stat f1b9293..HEAD -- server/src/db/migrations.ts server/src/automationStore.ts server/src/routes/connectors.ts server/src/tests/automations.test.ts server/src/tests/connectorRoutes.test.ts server/src/tests/sqliteFoundation.test.ts server/src/tests/sqliteMigrationFixture.ts server/src/tests/fixtures/sqlite`
> Plans 003 and 006 are expected to change some of these paths. Confirm their stated postconditions below, then compare all live automation schema/store excerpts before proceeding. Unexpected schema numbering is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/003-add-historical-migration-fixtures.md`, `advisor-plans/006-bind-egress-consent-to-provider-revision.md`
- **Category**: migration
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Automation target ownership is currently enforced only by application prechecks. SQLite can retain an automation after its connector or chat is deleted, causing scheduled failures, ambiguous connector schedules, and manual best-effort teardown that can silently fail. A v13 schema rebuild with kind-specific composite foreign keys makes the ledger authoritative, gives connector/chat deletion reliable cascades, and preserves the public `target_id` contract.

## Current state

- At the planned-at commit, `server/src/db/migrations.ts:420-448` creates schema-v9 automation tables with an unowned text target:

  ```sql
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('connector_sync','agent_turn')),
    target_id TEXT NOT NULL,
    prompt TEXT,
    schedule_minutes INTEGER NOT NULL CHECK (schedule_minutes BETWEEN 15 AND 10080),
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    last_run_at TEXT,
    next_run_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (account_id, name)
  ) STRICT;
  ```

  `automation_runs.automation_id` references only the automation ID, while its separate `account_id` is not tied to the parent account.

- The planned-at schema version is 11 (`server/src/db/migrations.ts:3`) and the migration inventory ends at v11 (`server/src/db/migrations.ts:469-481`). Dependency plan 006 is expected to own v12. This plan must add exactly v13 and must not reuse or renumber v12.

- Dependency plan 003 establishes one migration framework: `server/src/tests/sqliteMigrationFixture.ts`, immutable deltas `server/src/tests/fixtures/sqlite/v001.sql` through `v011.sql`, and assertions in `server/src/tests/sqliteFoundation.test.ts`. Dependency plan 006 must add contiguous `v012.sql`. This plan adds `v013.sql`; do not create another fixture harness.

- `AutomationStore.create` performs kind-specific ownership lookups before inserting the untyped target (`server/src/automationStore.ts:124-146`):

  ```ts
  if (kind === "connector_sync") {
    const owned = transaction.get("SELECT 1 FROM connectors WHERE id=? AND account_id=?", [targetId, accountId]);
    if (!owned) throw new AutomationValidationError("target_id must reference a connector of this account");
    // ...duplicate precheck...
  } else {
    const owned = transaction.get("SELECT 1 FROM chats WHERE id=? AND account_id=?", [targetId, accountId]);
    if (!owned) throw new AutomationValidationError("target_id must reference a chat of this account");
  }
  transaction.run(
    `INSERT INTO automations (id,account_id,name,kind,target_id,prompt,schedule_minutes,next_run_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ```

  Keep these prechecks for stable API messages, but make database constraints authoritative against direct SQL and future code paths.

- `server/src/automationStore.ts:266-305` queries connector schedules by `target_id` and exposes `deleteConnectorAutomations`, a manual teardown helper.

- Connector deletion invokes that helper best-effort after the connector transaction (`server/src/routes/connectors.ts:226-234`):

  ```ts
  const deletion = await storageRuntime().sources.deleteConnector(accountId, connectorId);
  await completeSourceDeleteIntents(deletion.intents);
  await storageRuntime()
    .automations.deleteConnectorAutomations(accountId, connectorId)
    .catch(() => {});
  ```

  A swallowed failure can leave a dangling schedule. `ChatStore.deleteChat` only deletes the chat at `server/src/db/stores/chatStore.ts:749-760`, so agent-turn automations always dangle today.

- `server/src/tests/automations.test.ts:363-388` deliberately demonstrates the defect by deleting a connector directly, retaining the automation, and expecting a scheduled failure saying the bound connector is gone. After this migration, the automation and its runs must cascade instead.

- Existing parent tables already support composite ownership: connectors declare `UNIQUE (id, account_id)` at `server/src/db/migrations.ts:18-31`, and chats do the same at `server/src/db/migrations.ts:67-77`.

- `AGENTS.md:239-243` defines connector schedules as at most one automation per connector and says connector deletion cascades linked automations and sync history. Preserve multiple independent `agent_turn` automations per chat unless product requirements change.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Dependency check | `test -f server/src/tests/sqliteMigrationFixture.ts && test -f server/src/tests/fixtures/sqlite/v012.sql && node -e "const f=require('node:fs').readdirSync('server/src/tests/fixtures/sqlite').filter(x=>/^v\\d{3}\\.sql$/.test(x));if(f.length<12)process.exit(1)"` | exit 0 |
| Historical migration tests | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts` | all migration/fixture tests pass |
| Automation/connector unit tests | `pnpm --filter borealis-server exec vitest run src/tests/automations.test.ts src/tests/connectorRoutes.test.ts` | all unit tests pass |
| Server typecheck | `pnpm --filter borealis-server typecheck` | exit 0, no errors |
| Server lint/format | `pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check` | exit 0, no warnings |
| Full server tests | `pnpm --filter borealis-server test` | all tests pass |
| Final repository gate | `pnpm verify` | exit 0 and prints `ALL GATES GREEN` on a provisioned supported host |

## Scope

**In scope** (the only source/test files to modify or create):

- `server/src/db/migrations.ts`
- `server/src/tests/fixtures/sqlite/v013.sql` (create; exact immutable copy of the v13 delta)
- `server/src/automationStore.ts`
- `server/src/routes/connectors.ts`
- `server/src/tests/automations.test.ts`
- `server/src/tests/connectorRoutes.test.ts`
- `server/src/tests/sqliteFoundation.test.ts`

**Out of scope** (do not touch):

- `server/src/tests/sqliteMigrationFixture.ts` and v001-v012 fixture files; they are dependency-owned and immutable.
- `server/src/routes/automations.ts` and the public API shape. Clients must continue to send and receive `target_id`.
- Scheduler execution, egress consent, one-run-per-chat, retry/pause policy, or run-detail wording.
- Connector/source cleanup intents and connector sync-history semantics.
- Dynamic chat-to-library resolution or changes to chat/source scope.
- Any schema version other than v13. Plan 006 owns v12 and the later reserved sequence must remain contiguous.

## Git workflow

- Branch: `codex/012-enforce-automation-target-ownership`
- Suggested commits:
  1. `test(server): cover owned automation target migration`
  2. `fix(server): enforce automation target ownership`
- Use conventional commits. Do not push or open a PR without explicit instruction.

## Steps

### Step 1: Validate the migration dependencies and version reservation

Confirm plan 003's helper/fixture contract exists, plan 006 has added `v012.sql`, and `LATEST_SQLITE_SCHEMA_VERSION` is exactly 12 before this work. Confirm migrations 1-12 and fixtures v001-v012 are contiguous with no extra v13. Read the dependency plan's migration behavior before editing.

**Verify**: run the Dependency check command, then `rg -n 'LATEST_SQLITE_SCHEMA_VERSION|version: 12|SCHEMA_V12' server/src/db/migrations.ts` → the latest version is 12 and exactly one v12 migration is registered.

### Step 2: Add schema v13 with kind-specific owned targets

Add `SCHEMA_V13` and advance `LATEST_SQLITE_SCHEMA_VERSION` from 12 to 13. Rebuild both `automations` and `automation_runs` in one migration; SQLite cannot add these composite foreign keys in place.

The rebuilt `automations` table must retain all public/state columns and add canonical nullable `connector_id` and `chat_id` columns with:

- a CHECK requiring `connector_sync` to have exactly `connector_id` and `agent_turn` to have exactly `chat_id`;
- `FOREIGN KEY (connector_id, account_id) REFERENCES connectors(id, account_id) ON DELETE CASCADE`;
- `FOREIGN KEY (chat_id, account_id) REFERENCES chats(id, account_id) ON DELETE CASCADE`;
- `UNIQUE (id, account_id)` for child ownership;
- the existing unique account/name rule;
- a partial unique index on `(account_id, connector_id)` for non-null connector targets, preserving at most one connector schedule while still allowing multiple agent-turn automations for a chat.

Preserve the public/read-side `target_id` column as a generated expression over the two canonical columns (for example `coalesce(connector_id, chat_id)`) so existing DTOs and SELECT consumers do not grow two target concepts. If the checked-in SQLite version does not support a generated column in this STRICT rebuild, STOP and report rather than introducing unconstrained duplicated target text.

Rebuild `automation_runs` with a composite foreign key `(automation_id, account_id)` to the rebuilt parent and retain its outcome/detail/time checks and index.

Migration policy for legacy rows must be explicit and tested:

- copy a connector automation only if its target connector exists under the same account;
- copy an agent automation only if its target chat exists under the same account;
- v12 can contain multiple otherwise-valid `connector_sync` rows for one owned
  connector (the store calls these legacy multiples). Before creating the v13
  unique index, retain exactly one deterministic survivor per
  `(account_id, target_id)`: the row ordered first by `created_at DESC, id DESC`,
  matching the current connector-schedule read order and preserving the newest
  schedule intent. Drop every other duplicate and its run history;
- copy runs only for automations copied into v13;
- discard dangling/cross-account automation rows and their unreachable history rather than failing every existing workspace at startup.

Implement the duplicate choice in SQL inside the migration (for example with a
window rank or a correlated `NOT EXISTS` ordered by `created_at DESC, id DESC`), not with
unordered `GROUP BY` behavior. Create temporary v13 tables, copy only the valid
surviving parents, copy matching runs, drop the old child before the old parent,
rename the new tables, and recreate indexes. Do not disable foreign keys. Put
the exact same SQL delta in `server/src/tests/fixtures/sqlite/v013.sql`.

**Verify**: `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts` → fixture inventory reaches v13, historical upgrades pass, and `PRAGMA foreign_key_check` is empty.

### Step 3: Write migration and database-constraint regressions

Using only plan 003's fixture helper and `sqliteFoundation.test.ts`, add a v12→v13 upgrade case seeded before migration with:

- one valid connector automation and run;
- at least two additional otherwise-valid connector automations for that same
  owned connector, with distinct creation times/IDs and run history that proves
  only the newest `(created_at, id)` survivor's history is retained;
- one valid agent-turn automation and run;
- dangling connector/chat targets and their runs;
- enough state fields to prove schedule, state, failure count, timestamps, and prompt survive.

Assert valid rows/history survive with the same public target IDs, the duplicate
connector winner is selected by exact `created_at DESC, id DESC` order, every losing
duplicate and its runs are removed, and invalid rows/history are removed. Include
a same-timestamp ID tie case so the result does not depend on insertion or rowid
order. Add current-schema direct-SQL assertions that reject cross-account
targets, a kind with the wrong target column, both target columns, neither target
column, mismatched automation-run account, and a duplicate connector target.
Assert two agent-turn automations may target the same owned chat and
`PRAGMA foreign_key_check` is empty.

Do not edit old fixture deltas to make the test pass.

**Verify**: `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts` → all fresh-schema, historical-upgrade, rollback, and constraint cases pass.

### Step 4: Adapt AutomationStore without changing its DTO

Keep `Automation.target_id` and all route response fields unchanged. Insert `targetId` into `connector_id` or `chat_id` according to kind; never populate both. Continue the in-transaction owned-target prechecks so callers receive the existing stable validation messages. Query connector schedules through `connector_id`, and let the v13 partial unique index be the final race-proof constraint.

Ensure every SELECT decoded as an `Automation` still selects the generated `target_id`. Keep `claimDue` returning one `targetId` regardless of kind. Preserve the distinct connector-duplicate message through the existing ownership/duplicate precheck inside the serialized immediate transaction. `SqliteConstraintError` currently exposes only `kind`, not the violated index, so do not claim the partial unique index alone can be decoded; if a post-constraint distinction is needed, use a safe scoped requery, otherwise retain the existing generic unique-name fallback. Never expose raw SQLite errors.

Delete `AutomationStore.deleteConnectorAutomations`; ownership cascade makes it redundant.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/automations.test.ts` → API validation, connector uniqueness, runner claims, agent turns, history, and failure-pause behavior pass.

### Step 5: Remove manual teardown and assert cascades through real stores

Remove the best-effort `deleteConnectorAutomations(...).catch(...)` block from `server/src/routes/connectors.ts`. Connector deletion should reserve/delete sources and the connector in its existing transaction; the v13 foreign key then removes the automation and its `automation_runs`. Connector sync history continues to cascade through its existing v10 composite foreign key.

Update `connectorRoutes.test.ts` raw setup to use v13 target columns and replace the legacy-multiple/cleanup assumptions that the unique constraint now makes impossible. Make the cascade test prove automation and run removal even when no manual helper is called.

In `automations.test.ts`, replace the intentional dangling-connector runner case with two durable cascade cases: delete a connector via the real source store and delete a chat via `storageRuntime().chats.deleteChat`; each must remove only its bound automation and runs while leaving unrelated targets intact.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/automations.test.ts src/tests/connectorRoutes.test.ts` → all tests pass and no dangling-target scenario remains possible.

### Step 6: Run all server and repository gates

Run the typecheck, lint, format, full tests, and final repository gate. Inspect all SQL in both the migration constant and v013 fixture byte-for-byte for semantic equality.

Audit current-code inserts with
`rg -n -U 'INSERT\s+INTO\s+automations\s*\([^)]*\btarget_id\b' server/src --glob '*.ts'`.
Manually classify every match: only immutable pre-v13 migration SQL and an
explicit v12 historical-fixture seed may write legacy `target_id`; current
stores/routes/tests must write exactly one canonical target column. This audit,
not the unrelated repository remnant policy, proves the old insert shape was
not missed.

**Verify**: `git diff --check && git status --short` → no whitespace errors; only the seven in-scope paths (including new `v013.sql`) plus the permitted `advisor-plans/README.md` status update are modified.

## Test plan

- Historical fixture upgrade from v12 containing valid and invalid legacy
  targets plus multiple valid connector schedules; the first row by
  `created_at DESC, id DESC` and only its runs remain.
- Fresh-schema CHECK, composite foreign-key, composite run-owner, and partial-unique constraints.
- Public API round trips keep `target_id` unchanged.
- Real connector and chat deletion cascade bound automation rows and run history only.
- Multiple agent turns per chat remain allowed; multiple connector schedules do not.
- Existing runner behavior remains covered, except the obsolete dangling-target scheduled failure.
- The explicit multiline SQL audit verifies that only historical v12 setup can
  still insert legacy `target_id`; full server and repository gates then cover
  the current schema behavior.

## Done criteria

- [ ] Schema latest is exactly 13 after dependency plan 006's v12.
- [ ] `v013.sql` exactly matches `SCHEMA_V13`; v001-v012 remain untouched.
- [ ] Every automation has exactly one kind-appropriate, same-account connector/chat foreign key.
- [ ] Automation runs cannot carry an account different from their parent.
- [ ] Connector and chat deletion cascade bound automations and run history.
- [ ] The public request/response field remains `target_id`.
- [ ] Valid v12 automations/history migrate; deterministic legacy connector
      duplicates, their runs, and dangling/cross-account rows are removed by the
      documented migration policy.
- [ ] Focused, full server, and repository gates pass with an empty `PRAGMA foreign_key_check`.
- [ ] No file outside Scope is modified, except the permitted plan-index update.

## STOP conditions

Stop and report back instead of improvising if:

- Plans 003 and 006 are not DONE, `LATEST_SQLITE_SCHEMA_VERSION` is not exactly 12, `v012.sql` is missing, or any other plan has already claimed v13.
- Plan 003's actual fixture contract differs from `sqliteMigrationFixture.ts` plus immutable `fixtures/sqlite/vNNN.sql` deltas.
- A generated `target_id` cannot be supported by the repository's SQLite runtime and tests; do not introduce an unconstrained duplicate target field.
- Existing production requirements intentionally preserve a dangling automation or allow a connector target from another account.
- A migration cannot preserve valid automation runs without disabling foreign keys or editing an old fixture.
- The v12 duplicate-survivor rule cannot be expressed deterministically in the
  checked-in SQLite runtime; do not create the unique index over ambiguous
  legacy data.
- The change would alter the public API, scheduler semantics, prompt policy, or source/chat deletion rules beyond cascade ownership.
- A verification fails twice after one reasonable correction, or a required path is outside Scope.

## Maintenance notes

- Every future polymorphic automation kind needs an explicit owned target column, a CHECK branch, a composite foreign key, migration coverage, and a public `target_id` mapping.
- Keep the stable application prechecks for useful 400 responses even though SQLite is authoritative.
- Review table-rebuild order carefully: child history must be copied before old tables are dropped, and old child must be dropped before old parent.
- Keep the `created_at DESC, id DESC` duplicate-survivor fixture permanently. Removing
  it can turn a valid historical database into a migration-time unique-index
  failure.
- Schema numbering is shared across plans. Future migrations must start at v14; never edit v13 after release.
