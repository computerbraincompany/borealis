# Plan 003: Add executable historical SQLite migration fixtures

> **Executor instructions**: Follow each step and its verification gate. Treat
> the SQL fixtures as immutable historical inputs, not as a second production
> migration system. Stop on any STOP condition. A reviewer maintains
> `advisor-plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat f1b9293..HEAD -- server/src/db/migrations.ts server/src/tests/sqliteFoundation.test.ts server/src/tests/sqliteMigrationFixture.ts server/src/tests/fixtures/sqlite`
> If production migrations or the existing foundation test changed, reconcile
> them with the excerpts below; a mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `advisor-plans/031-paginate-resource-catalogs.md`
- **Category**: migration
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Borealis opens durable user databases by applying every migration newer than
`PRAGMA user_version`, but tests create only the newest schema and reopen it.
That does not prove a real v1-v11 installation can traverse the later ALTERs,
tables, indexes, and foreign keys without losing data. Checked-in historical SQL
fixtures make every supported upgrade path executable and force future schema
work to supply the next historical checkpoint.

## Current state

- At the planned commit, `server/src/db/migrations.ts:469-480` defined the
  then-complete ordered history:

  ```ts
  const migrations = [
    { version: 1, sql: SCHEMA_V1 },
    { version: 2, sql: SCHEMA_V2 },
    { version: 3, sql: SCHEMA_V3 },
    { version: 4, sql: SCHEMA_V4 },
    { version: 5, sql: SCHEMA_V5 },
    { version: 6, sql: SCHEMA_V6 },
    { version: 7, sql: SCHEMA_V7 },
    { version: 8, sql: SCHEMA_V8 },
    { version: 9, sql: SCHEMA_V9 },
    { version: 10, sql: SCHEMA_V10 },
    { version: 11, sql: SCHEMA_V11 },
  ] as const;
  ```

- `server/src/db/migrations.ts:492-518` applies each missing version in its own
  transaction and updates `user_version` only before commit:

  ```ts
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    database.exec("BEGIN IMMEDIATE");
    let inTransaction = true;
    try {
      database.exec(migration.sql);
      database.pragma(`user_version = ${migration.version}`);
      database.exec("COMMIT");
  ```

- `server/src/db/sqlite.ts:266-275` enables foreign keys, WAL, trusted-schema
  protection, and FULL synchronous mode before calling `migrateSqlite`.
- `server/src/tests/sqliteFoundation.test.ts:138-158` only reopens a database
  that was already created at the latest version and checks rejection of a
  future version:

  ```ts
  const resource = await temporaryLedger();
  const accountId = randomUUID();
  await resource.ledger.run(
    "INSERT INTO users (id,email,password_hash) VALUES (?,?,?)",
    [accountId, "persisted@example.test", "hash"],
  );
  await resource.ledger.close();

  const reopened = await openSqliteLedger({ path: resource.filename });
  await expect(
    reopened.get("SELECT id FROM users WHERE id=?", [accountId]),
  ).resolves.toMatchObject({
    id: accountId,
  });
  await reopened.close();

  const future = new Database(resource.filename);
  future.pragma(`user_version = ${LATEST_SQLITE_SCHEMA_VERSION + 1}`);
  future.close();
  await expect(
    openSqliteLedger({ path: resource.filename }),
  ).rejects.toBeInstanceOf(SqliteMigrationError);
  ```

- `server/src/tests/sqliteTestHarness.ts:14-18` always calls
  `openSqliteLedger` immediately, so it cannot create an old schema.
- At the planned commit, `LATEST_SQLITE_SCHEMA_VERSION` was `11`. Completed
  plan 031 subsequently added the immutable catalog-index migration as v12.
  Versions 3-11
  add report lineage, remote-egress acknowledgment, libraries, agents, egress
  events, report shares, automations, connector history, and personal model
  defaults; v12 adds only the account/order catalog indexes characterized by
  plan 031. Preserve the order and exact SQL semantics.
- Tests use `better-sqlite3` only to prepare raw on-disk state, then exercise the
  asynchronous ledger API. Match `sqliteFoundation.test.ts:1-26`.

## Commands you will need

| Purpose                | Command                                                                                                                  | Expected on success                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Focused migration test | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts` | exit 0; all historical starts upgrade |
| Integration suite      | `pnpm --filter borealis-server test:integration`                                                                         | exit 0                                |
| Typecheck              | `pnpm --filter borealis-server typecheck`                                                                                | exit 0                                |
| Lint                   | `pnpm --filter borealis-server lint`                                                                                     | exit 0, no warnings                   |
| Format check           | `pnpm --filter borealis-server format:check`                                                                             | exit 0                                |

Do not install, build, format, or generate binary database files.

## Scope

**In scope**:

- `server/src/tests/sqliteFoundation.test.ts`
- `server/src/tests/sqliteMigrationFixture.ts` (create)
- `server/src/tests/fixtures/sqlite/v001.sql` through
  `server/src/tests/fixtures/sqlite/v012.sql` (create)
- `server/src/tests/fixtures/sqlite/v013.sql` (create; agent editor delta)

**Out of scope**:

- `server/src/db/migrations.ts` and all production stores; this is a
  characterization plan, not a migration fix.
- Binary `.sqlite`, WAL, or SHM fixtures.
- Downgrades, rollback tooling, data export, or backup behavior.
- Changing migration SQL to accommodate a failing fixture.

## Git workflow

- Branch: `codex/003-add-historical-migration-fixtures`
- Commit: `test(server): cover historical sqlite migrations`
- Do not push, open a PR, edit the plan index, or commit generated databases.

September 5 dependency update: schema v13 now contains the agent editor
configuration, skills, and run tool snapshot migration. Include its exact shipped
SQL in the fixture inventory and preserve its columns in every upgrade test.

## Steps

### Step 1: Capture each shipped migration as an immutable SQL delta

Create `server/src/tests/fixtures/sqlite/v001.sql` through `v013.sql`. After one
short header comment naming the version and declaring the fixture immutable,
each file must contain the exact SQL body of the matching `SCHEMA_Vn` constant
in the live tree (v1-v11 remain the planned-at SQL; v12 is plan 031's shipped
catalog-index delta; v13 is the shipped agent-editor delta), in the same statement order. Do not add `BEGIN`, `COMMIT`,
or `PRAGMA user_version`; the fixture loader owns those mechanics.

Review the long v1/v2 files carefully; do not derive old schemas by deleting
columns from the latest schema.

**Verify**:
`find server/src/tests/fixtures/sqlite -maxdepth 1 -type f -name 'v*.sql' | sort`
→ exactly thirteen paths, `v001.sql` through `v013.sql`, with no database artifacts.

### Step 2: Build a raw historical-ledger helper

Create `server/src/tests/sqliteMigrationFixture.ts`. It must:

1. create a unique temporary directory and raw `better-sqlite3` database;
2. read fixture deltas in numeric order up to a requested start version;
3. apply each delta transactionally and set `PRAGMA user_version` to that exact
   version only after the delta succeeds;
4. insert representative v1 rows (at minimum one user, chat, source, message,
   and run with stable IDs) after v1 is present, so every start version proves
   survival of real data;
5. close the native handle before returning the filename and cleanup callback;
6. reject start versions outside `1..LATEST_SQLITE_SCHEMA_VERSION`; and
7. enumerate fixture names and assert there is one contiguous fixture for every
   version through `LATEST_SQLITE_SCHEMA_VERSION`.

Use `import.meta.url`/`fileURLToPath` to locate fixtures; do not depend on the
process working directory. Never use production `migrateSqlite` while preparing
the old state.

**Verify**:
`pnpm --filter borealis-server typecheck` → exit 0.

### Step 3: Exercise every upgrade start in the foundation test

Extend `server/src/tests/sqliteFoundation.test.ts` with a table-driven test for
start versions `1` through `LATEST_SQLITE_SCHEMA_VERSION - 1`. For each start:

- create the fixture database and confirm its initial `user_version`;
- open it through `openSqliteLedger`, which must perform the real upgrade;
- assert the final version equals `LATEST_SQLITE_SCHEMA_VERSION`;
- assert the representative v1 rows and relationships survived;
- assert `PRAGMA foreign_key_check` returns no rows;
- assert representative latest objects/columns exist, including
  `report_shares`, `automations`, `connector_syncs`, and
  `users.default_chat_model`, and assert plan 031's catalog indexes exist; and
- close and clean up in `finally`, including when an assertion fails.

Add a separate fixture-inventory assertion so the next production schema bump
fails until its `vNNN.sql` checkpoint is added. Keep the existing fresh-schema,
idempotent-reopen, and future-version tests.

**Verify**:
`pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts`
→ exit 0; output includes the historical-upgrade test and every start version.

### Step 4: Run the serialized integration and static gates

**Verify**:

- `pnpm --filter borealis-server test:integration` → exit 0.
- `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`
  → exit 0.

## Test plan

- Add one inventory test covering contiguous fixture versions and no extras.
- Add a parameterized v1-v11 upgrade test using real `openSqliteLedger`.
- For each start, cover final version, preserved base rows, newest tables and
  columns, and foreign-key integrity.
- Retain the existing newest-schema idempotence and future-version rejection as
  separate regression cases.

## Done criteria

- [ ] Thirteen textual fixtures exactly represent shipped schema deltas v1-v13.
- [ ] Every historical start v1-v12 upgrades to v13 through production code.
- [ ] Seeded data survives and `PRAGMA foreign_key_check` is empty for each case.
- [ ] Fixture inventory is mechanically tied to `LATEST_SQLITE_SCHEMA_VERSION`.
- [ ] Integration, typecheck, lint, and format gates pass.
- [ ] `git status --short` contains only the in-scope test/helper/fixture paths.

## STOP conditions

Stop and report if:

- `LATEST_SQLITE_SCHEMA_VERSION` is not exactly `13`, or v12 is not exclusively
  the catalog-index migration completed by plan 031, before this plan starts;
- a historical fixture exposes an actual migration failure or foreign-key
  violation; do not repair production SQL under this plan;
- reconstructing any shipped version requires guessing beyond the checked-in
  `SCHEMA_Vn` constants;
- the focused test cannot locate fixtures independent of `cwd`;
- binary database artifacts appear in git status; or
- a verification fails twice after one reasonable correction.

## Maintenance notes

- Every future migration adds one immutable `vNNN.sql` fixture in the same
  commit. Never rewrite an older fixture after release.
- The fixture inventory deliberately fails on a schema bump; that failure is the
  reminder to preserve the new checkpoint.
- Reviewers should compare each new fixture directly with its production
  `SCHEMA_Vn` body and scrutinize transaction/version ordering.
