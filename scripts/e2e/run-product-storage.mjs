#!/usr/bin/env -S pnpm --filter borealis-server exec tsx
/** Isolated, real-storage v1 upgrade, live migration and encrypted CLI acceptance.
 * Run from root: pnpm --filter borealis-server exec tsx ../scripts/e2e/run-product-storage.mjs
 * All data is synthetic. No application workspace or credential is read.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHistoricalSqliteFixture } from "../../server/src/tests/sqliteMigrationFixture.ts";
import { populateWaveLedger } from "../../server/src/tests/waveWorkspaceFixture.ts";
import { openSqliteLedger } from "../../server/src/db/sqlite.ts";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../../server/src/db/migrations.ts";
import { createSettingsStore } from "../../server/src/settingsStore.ts";
import {
  initializeStorageRuntime,
  closeStorageRuntime,
  reopenStorageVectors,
  storageRuntime,
} from "../../server/src/storageRuntime.ts";
import { EmbeddingMigrationCoordinator } from "../../server/src/embeddingMigration.ts";
import { retrieveWithVector } from "../../server/src/vector/retrieve.ts";
import { acquireWorkspaceLock } from "../../server/src/workspaceLock.ts";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(repo, "server/package.json"));
const Database = require("better-sqlite3");
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "borealis-storage-acceptance-")),
);
const workspace = path.join(root, "workspace");
const restored = path.join(root, "restored");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? Number(v) : v)),
  );
const now = "2026-09-07T12:00:00.000Z";
const summary = {
  entry: "run-product-storage",
  started_at: new Date().toISOString(),
  runtime: process.version,
  schema: LATEST_SQLITE_SCHEMA_VERSION,
  checks: [],
  passed: false,
};
let coordinator;
let fixture;
let provider;
let lock;
const record = (check, details = {}) => {
  summary.checks.push({ check, ...details });
  process.stdout.write(`storage ${check}: pass\n`);
};
const cli = (args, expected = 0) => {
  const result = spawnSync("pnpm", ["workspace:archive", "--", ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BOREALIS_ARCHIVE_PASSPHRASE: "synthetic storage acceptance passphrase",
    },
  });
  if (process.env.BOREALIS_E2E_DEBUG === "1" && result.status !== expected)
    process.stderr.write(result.stdout + result.stderr);
  assert.equal(
    result.status,
    expected,
    `ARCHIVE_CLI_${args[0].toUpperCase()}_EXIT_${result.status}`,
  );
  const json = result.stdout
    .split("\n")
    .findLast((line) => line.startsWith("{"));
  if (expected !== 0) return;
  assert(json, "ARCHIVE_CLI_SUMMARY_MISSING");
  return JSON.parse(json);
};
async function allRows(ledger) {
  const tables = await ledger.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const rows = {};
  for (const { name } of tables)
    rows[name] = await ledger.all(`SELECT * FROM "${name}" ORDER BY 1`);
  return plain(rows);
}
async function hashes(directory, relative = "") {
  const out = {};
  for (const entry of await fs.readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const rel = path.join(relative, entry.name);
    if (
      !relative &&
      [
        "borealis.sqlite",
        "borealis.sqlite-wal",
        "borealis.sqlite-shm",
        "secrets",
        "connections.key",
      ].includes(entry.name)
    )
      continue;
    assert(!entry.isSymbolicLink(), "FIXTURE_SYMLINK");
    if (entry.isDirectory()) Object.assign(out, await hashes(directory, rel));
    else out[rel] = digest(await fs.readFile(path.join(directory, rel)));
  }
  return out;
}
function normalizedRows(rows, source, target) {
  const result = JSON.parse(JSON.stringify(rows).split(source).join(target));
  for (const row of result.connections)
    if (row.status === "ready") {
      row.status = "disconnected";
      row.status_code = "CONNECTION_RESTORE_RECONNECT_REQUIRED";
    }
  for (const row of result.knowledge_connections) {
    if (row.kind === "webdav") row.credential_configured = 0;
    if (row.status === "ready") {
      row.status = "disconnected";
      row.status_code =
        row.kind === "desktop_folder"
          ? "KNOWLEDGE_FOLDER_RESELECT_REQUIRED"
          : "KNOWLEDGE_RESTORE_RECONNECT_REQUIRED";
    }
  }
  // Restore records the reconnect transition time. All other columns are exact.
  for (const table of ["connections", "knowledge_connections"])
    for (const row of result[table]) delete row.updated_at;
  return result;
}
async function populateResearchAndBriefs(ledger, wave, sourceId) {
  const insert = async (table, row) => {
    const cols = Object.keys(row);
    await ledger.run(
      `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      Object.values(row),
    );
  };
  const account = wave.accountId;
  const definition = randomUUID(),
    run = randomUUID(),
    evidence = randomUUID(),
    column = randomUUID(),
    recipe = randomUUID(),
    brief = randomUUID();
  const sources = JSON.stringify([sourceId]);
  await insert("document_rewrites", {
    id: randomUUID(),
    account_id: account,
    document_id: wave.documentId,
    base_revision_id: wave.revisionId,
    section_id: randomUUID(),
    selection_sha256: digest("Original"),
    selection_chars: 8,
    instruction: "Clarify",
    status: "completed",
    replacement: "Clarified synthetic narrative",
    evidence_refs: "[]",
    finished_at: now,
  });
  await insert("research_definitions", {
    id: definition,
    account_id: account,
    title: "Synthetic supplier comparison",
    output_kind: "comparison",
  });
  await insert("research_definition_revisions", {
    definition_id: definition,
    revision: 1,
    account_id: account,
    title: "Synthetic supplier comparison",
    question: "Which price is evidenced?",
    source_ids: sources,
    chat_model: "storage-chat",
    output_kind: "comparison",
    columns: JSON.stringify([{ id: column, name: "Price", type: "number" }]),
  });
  await insert("research_runs", {
    id: run,
    account_id: account,
    definition_id: definition,
    definition_revision: 1,
    status: "completed",
    chat_model: "storage-chat",
    provider_origin: "http://127.0.0.1:1234",
    provider_locality: "local",
    sources: JSON.stringify([{ source_id: sourceId, generation: 0 }]),
    budget_steps: 1,
    budget_searches: 1,
    budget_model_requests: 1,
    budget_evidence: 1,
    budget_evidence_chars: 2000,
    budget_wall_ms: 1000,
  });
  await insert("research_steps", {
    run_id: run,
    ordinal: 0,
    account_id: account,
    objective: "Compare evidenced price",
    questions: '["Price?"]',
    status: "done",
    finished_at: now,
  });
  // This generation/chunk deliberately no longer exists. Frozen evidence and corrections must survive.
  await insert("research_evidence", {
    id: evidence,
    account_id: account,
    run_id: run,
    source_id: sourceId,
    generation: 0,
    chunk_id: randomUUID(),
    label: "Historical supplier quote",
    excerpt: "Synthetic price 42",
    content_hash: digest("Synthetic price 42"),
    retrieved_at: now,
    step_ordinal: 0,
    query: "Price",
  });
  await insert("research_claims", {
    id: randomUUID(),
    account_id: account,
    run_id: run,
    kind: "claim",
    text: "Price 42",
    corrected_text: "Reviewed price 43",
    classification: "supported",
    evidence_refs: JSON.stringify([evidence]),
    review_state: "accepted",
  });
  for (const origin of ["machine", "correction"])
    await insert("research_table_cells", {
      run_id: run,
      column_id: column,
      row_source_id: sourceId,
      row_generation: 0,
      origin,
      account_id: account,
      value: origin === "machine" ? "42" : "43",
      status: "supported",
      evidence_refs: JSON.stringify([evidence]),
      corrected_at: origin === "correction" ? now : null,
    });
  await insert("research_reviews", {
    run_id: run,
    seq: 1,
    account_id: account,
    review_revision: 1,
    op: "correct_cell",
    target_kind: "cell",
    target: column,
  });
  const recipeFields = {
    account_id: account,
    name: "Synthetic weekly brief",
    analysis_id: wave.analysisId,
    analysis_revision: 1,
    report_title: "Weekly finance",
    report_instruction: "Explain changes",
    source_ids: sources,
    schedule_kind: "weekly",
    weekday: 1,
    hour: 9,
    minute: 0,
    time_zone: "Europe/Berlin",
  };
  await insert("brief_recipes", {
    id: recipe,
    ...recipeFields,
    next_occurrence_key: "2026-09-14T09:00",
    next_run_at: "2026-09-14T07:00:00.000Z",
    state: "paused",
  });
  await insert("brief_recipe_revisions", {
    recipe_id: recipe,
    revision: 1,
    ...recipeFields,
  });
  await insert("brief_runs", {
    id: brief,
    account_id: account,
    recipe_id: recipe,
    trigger: "scheduled",
    occurrence_key: "2026-09-07T09:00",
    recipe_revision: 1,
    recipe_snapshot: JSON.stringify(recipeFields),
    stage: "approved",
    deadline_at: now,
    document_id: wave.documentId,
    document_revision_id: wave.revisionId,
    reviewed_revision_id: wave.revisionId,
    finished_at: now,
  });
  await insert("brief_review_events", {
    id: randomUUID(),
    account_id: account,
    run_id: brief,
    recipe_id: recipe,
    document_id: wave.documentId,
    document_revision_id: wave.revisionId,
    decision: "approve",
  });
  await insert("brief_notifications", {
    id: randomUUID(),
    account_id: account,
    recipe_id: recipe,
    run_id: brief,
    kind: "first_draft",
    state: "dismissed",
  });
}
try {
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.writeFile(
    path.join(workspace, "jwt.secret"),
    "synthetic-signing-secret-for-offline-acceptance-only\n",
    { mode: 0o600 },
  );
  fixture = await createHistoricalSqliteFixture(13);
  await fs.copyFile(fixture.filename, path.join(workspace, "borealis.sqlite"));
  const legacy = new Database(path.join(workspace, "borealis.sqlite"));
  const { accountId, sourceId, chatId, runId } = fixture.seed;
  const report = randomUUID(),
    agent = randomUUID(),
    skill = randomUUID(),
    recipient = randomUUID();
  const html = path.join(workspace, "reports", `${report}.html`);
  await fs.mkdir(path.dirname(html));
  await fs.writeFile(
    html,
    "<!doctype html><title>Historical report</title><p>Synthetic retained artifact</p>",
  );
  legacy
    .prepare("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)")
    .run(recipient, "recipient@example.test", "fixture-hash");
  legacy
    .prepare("INSERT INTO agents (id,account_id,name) VALUES (?,?,?)")
    .run(agent, accountId, "Historical specialist");
  legacy
    .prepare(
      "INSERT INTO agent_revisions (agent_id,version,account_id,instructions) VALUES (?,1,?,?)",
    )
    .run(agent, accountId, "Preserve historical instructions");
  legacy
    .prepare(
      "INSERT INTO agent_skills (id,account_id,name,content,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(
      skill,
      accountId,
      "Historical skill",
      "Preserve historical skill",
      now,
      now,
    );
  legacy
    .prepare(
      "INSERT INTO agent_skill_revisions (skill_id,version,content,created_at) VALUES (?,1,?,?)",
    )
    .run(skill, "Preserve historical skill", now);
  legacy.prepare("UPDATE chats SET agent_id=? WHERE id=?").run(agent, chatId);
  legacy
    .prepare(
      "INSERT INTO reports (id,account_id,chat_id,run_id,title,html_path) VALUES (?,?,?,?,?,?)",
    )
    .run(report, accountId, chatId, runId, "Historical report", html);
  legacy
    .prepare(
      "INSERT INTO report_shares (report_id,owner_account_id,recipient_account_id) VALUES (?,?,?)",
    )
    .run(report, accountId, recipient);
  const historical = {};
  for (const table of [
    "users",
    "sources",
    "chats",
    "messages",
    "chat_runs",
    "chat_sources",
    "agents",
    "agent_revisions",
    "agent_skills",
    "agent_skill_revisions",
    "reports",
    "report_shares",
  ])
    historical[table] = legacy
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all();
  assert.equal(legacy.pragma("user_version", { simple: true }), 13);
  legacy.close();
  let ledger = await openSqliteLedger({
    path: path.join(workspace, "borealis.sqlite"),
  });
  assert.equal(
    Number((await ledger.get("PRAGMA user_version")).user_version),
    LATEST_SQLITE_SCHEMA_VERSION,
  );
  for (const [table, rows] of Object.entries(historical)) {
    const projection = Object.keys(rows[0]).join(",");
    assert.deepEqual(
      plain(
        await ledger.all(`SELECT ${projection} FROM ${table} ORDER BY rowid`),
      ),
      rows,
      `UPGRADE_${table}`,
    );
  }
  assert.deepEqual(await ledger.all("PRAGMA foreign_key_check"), []);
  record("populated_v13_upgrade", {
    from: 13,
    to: LATEST_SQLITE_SCHEMA_VERSION,
    preserved_tables: Object.keys(historical).length,
  });
  const csvSource = randomUUID(),
    csvPath = path.join(
      workspace,
      "uploads",
      accountId,
      csvSource,
      "ledger.csv",
    );
  await fs.mkdir(path.dirname(csvPath), { recursive: true });
  await fs.writeFile(csvPath, "month,amount\n2026-01,42\n");
  await ledger.run(
    "INSERT INTO sources (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,meta) VALUES (?,?,?,'tabular','Ledger.csv',?,'text/csv',23,'ready','{}')",
    [csvSource, accountId, "ledger", csvPath],
  );
  await ledger.close();
  const wave = await populateWaveLedger(workspace, {
    accountId,
    sourceId: csvSource,
  });
  ledger = await openSqliteLedger({
    path: path.join(workspace, "borealis.sqlite"),
  });
  await populateResearchAndBriefs(ledger, wave, sourceId);
  await ledger.run("UPDATE sources SET ready_generation=1 WHERE id=?", [
    sourceId,
  ]);
  const chunk = randomUUID();
  await ledger.run(
    "INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta) VALUES (?,?,?,1,0,?,?,?)",
    [
      chunk,
      accountId,
      sourceId,
      "Historical source",
      "Synthetic retained passage",
      "{}",
    ],
  );
  const immutableFiles = await hashes(workspace);
  const before = await allRows(ledger);
  await ledger.close();
  // Fail if any product table added by v17+ is empty: a passing subset cannot
  // silently omit a durable object from this acceptance fixture.
  let productTables = 0;
  for (let version = 17; version <= LATEST_SQLITE_SCHEMA_VERSION; version++) {
    const sql = await fs.readFile(
      path.join(
        repo,
        "server/src/tests/fixtures/sqlite",
        `v${String(version).padStart(3, "0")}.sql`,
      ),
      "utf8",
    );
    for (const match of sql.matchAll(/CREATE TABLE (\w+) \(/g)) {
      assert(
        before[match[1]]?.length > 0,
        `PRODUCT_TABLE_UNSEEDED_${match[1]}`,
      );
      productTables++;
    }
  }
  const populated = Object.entries(before).filter(
    ([, rows]) => rows.length > 0,
  );
  record("all_product_ledger_objects_seeded", {
    product_tables: productTables,
    populated_tables: populated.length,
    rows: populated.reduce((n, [, rows]) => n + rows.length, 0),
  });
  const settings = createSettingsStore({
    path: path.join(workspace, "settings.json"),
    env: {},
  });
  await settings.patch({
    chatModel: "storage-chat",
    embedModel: "storage-embed-original",
    embeddingDimension: 3,
  });
  let runtime = await initializeStorageRuntime({
    sqlitePath: path.join(workspace, "borealis.sqlite"),
    lanceDirectory: path.join(workspace, "lancedb"),
    embeddingDimension: 3,
    embeddingModel: "storage-embed-original",
  });
  await runtime.vectors.upsert([
    { chunkId: chunk, accountId, sourceId, generation: 1, vector: [1, 0, 0] },
  ]);
  let embeddingRequests = 0;
  provider = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const part of req) body += part;
    const parsed = JSON.parse(body);
    embeddingRequests++;
    const dimension = parsed.model === "storage-embed-five" ? 5 : 3;
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        model: parsed.model,
        data: parsed.input.map((_, index) => ({
          index,
          embedding: [1, ...Array(dimension - 1).fill(0)],
        })),
      }),
    );
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  await settings.patch({ llmBaseUrl: origin });
  coordinator = new EmbeddingMigrationCoordinator({
    stateFile: path.join(workspace, "embedding-migration.json"),
    migrationRoot: path.join(workspace, ".lancedb-migrations"),
    liveLanceDirectory: path.join(workspace, "lancedb"),
    settingsStore: settings,
    ledger: () => runtime.ledger,
    runtime: () => runtime,
    openStartupLedger: async () => {
      const l = await openSqliteLedger({
        path: path.join(workspace, "borealis.sqlite"),
      });
      return { ledger: l, close: () => l.close() };
    },
    liveApply: {
      closeVectors: () => runtime.vectors.close(),
      openVectors: async (snapshot) => {
        await reopenStorageVectors(snapshot);
        runtime = storageRuntime();
      },
    },
    embedFactory: (effective) => async (texts) => {
      const response = await fetch(`${effective.llmBaseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: effective.embedModel,
          input: texts,
          encoding_format: "float",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      assert(response.ok);
      return (await response.json()).data.map((row) => row.embedding);
    },
  });
  const awaitPhase = async (phase) => {
    const until = Date.now() + 60_000;
    for (;;) {
      const state = await coordinator.status();
      if (state.phase === phase) return state;
      assert.notEqual(state.phase, "failed", "MIGRATION_FAILED");
      assert(Date.now() < until, "MIGRATION_TIMEOUT");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  for (const [model, dimension] of [
    ["storage-embed-three", 3],
    ["storage-embed-five", 5],
  ]) {
    const liveLedger = runtime.ledger;
    await coordinator.start({ model, dimension });
    const ready = await awaitPhase("ready_to_apply");
    assert.equal(ready.chunk_count, 1);
    assert.equal(ready.indexed_count, 1);
    await coordinator.requestApply();
    await awaitPhase("idle");
    assert.equal(runtime.ledger, liveLedger);
    assert(await liveLedger.health());
    assert.deepEqual(
      await allRows(liveLedger),
      before,
      "MIGRATION_LEDGER_CHANGED",
    );
    const found = await retrieveWithVector(runtime.ingestion, runtime.vectors, {
      accountId,
      allowedSourceIds: [sourceId],
      vector: [1, ...Array(dimension - 1).fill(0)],
      topK: 1,
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].content, "Synthetic retained passage");
    assert.deepEqual(
      await retrieveWithVector(runtime.ingestion, runtime.vectors, {
        accountId,
        allowedSourceIds: [],
        vector: [1, ...Array(dimension - 1).fill(0)],
        topK: 1,
      }),
      [],
    );
    record(
      dimension === 3
        ? "live_same_dimension_migration"
        : "live_changed_dimension_migration",
      { dimension, chunks: 1, ledger_identity_preserved: true },
    );
  }
  assert(embeddingRequests >= 2);
  await coordinator.close();
  coordinator = undefined;
  await closeStorageRuntime();
  const bytesBefore = await hashes(workspace);
  for (const [file, hash] of Object.entries(immutableFiles))
    assert.equal(bytesBefore[file], hash, "MIGRATION_ARTIFACT_CHANGED");
  lock = await acquireWorkspaceLock(workspace);
  cli(
    [
      "create",
      "--workspace",
      workspace,
      "--output",
      path.join(root, "blocked.borealis-workspace"),
    ],
    1,
  );
  await lock.release();
  lock = undefined;
  record("archive_refuses_locked_workspace");
  const archive = path.join(root, "synthetic.borealis-workspace");
  const created = cli([
    "create",
    "--workspace",
    workspace,
    "--output",
    archive,
  ]);
  assert.equal(created.encrypted, true);
  cli(["inspect", "--archive", archive]);
  const result = cli([
    "restore",
    "--archive",
    archive,
    "--target",
    restored,
    "--dimension",
    "5",
  ]);
  assert.equal(result.backup_created, false);
  const verified = cli(["verify", "--workspace", restored, "--dimension", "5"]);
  assert.equal(verified.chunks, 1);
  assert.equal(verified.vectors, 1);
  assert.equal(verified.datasets, 1);
  assert.deepEqual(
    await hashes(restored),
    bytesBefore,
    "ARCHIVE_ARTIFACT_BYTES_CHANGED",
  );
  ledger = await openSqliteLedger({
    path: path.join(restored, "borealis.sqlite"),
  });
  const after = await allRows(ledger);
  assert.deepEqual(
    normalizedRows(after, restored, restored),
    normalizedRows(before, workspace, restored),
    "ARCHIVE_LEDGER_CHANGED",
  );
  assert.deepEqual(await ledger.all("PRAGMA foreign_key_check"), []);
  assert.equal(
    after.connections.find((row) => row.id === wave.mcpReadyId).status_code,
    "CONNECTION_RESTORE_RECONNECT_REQUIRED",
  );
  assert.equal(
    after.knowledge_connections.find((row) => row.id === wave.folderReadyId)
      .status_code,
    "KNOWLEDGE_FOLDER_RESELECT_REQUIRED",
  );
  assert.equal(
    after.knowledge_connections.find((row) => row.id === wave.webdavReadyId)
      .status_code,
    "KNOWLEDGE_RESTORE_RECONNECT_REQUIRED",
  );
  assert(
    after.knowledge_connections
      .filter((row) => row.kind === "webdav")
      .every((row) => row.credential_configured === 0),
  );
  await ledger.close();
  for (const excluded of ["secrets", "connections.key"])
    await assert.rejects(fs.stat(path.join(restored, excluded)), {
      code: "ENOENT",
    });
  record("encrypted_cli_archive_restore", {
    files_preserved: Object.keys(bytesBefore).length,
    metadata_tables: populated.length,
    chunks: verified.chunks,
    vectors: verified.vectors,
    datasets: verified.datasets,
    custody_excluded: true,
    reconnect_states_verified: 3,
    historical_evidence_preserved: true,
  });
  runtime = await initializeStorageRuntime({
    sqlitePath: path.join(restored, "borealis.sqlite"),
    lanceDirectory: path.join(restored, "lancedb"),
    embeddingDimension: 5,
    embeddingModel: "storage-embed-five",
  });
  assert.equal(
    (
      await retrieveWithVector(runtime.ingestion, runtime.vectors, {
        accountId,
        allowedSourceIds: [sourceId],
        vector: [1, 0, 0, 0, 0],
        topK: 1,
      })
    ).length,
    1,
  );
  await closeStorageRuntime();
  record("restored_runtime_scoped_retrieval");
  for (const directory of [workspace, restored]) {
    const released = await acquireWorkspaceLock(directory);
    await released.release();
  }
  record("workspace_locks_released");
  summary.passed = true;
} catch (error) {
  summary.failure =
    error instanceof Error
      ? error.message.split("\n")[0]
      : "STORAGE_ACCEPTANCE_FAILED";
  process.stderr.write(`STORAGE_ACCEPTANCE_FAILURE ${summary.failure}\n`);
  if (process.env.BOREALIS_E2E_DEBUG === "1")
    process.stderr.write(`${error.stack}\n`);
} finally {
  await coordinator?.close();
  await closeStorageRuntime();
  await lock?.release();
  if (provider) await new Promise((resolve) => provider.close(resolve));
  await fixture?.cleanup();
  const evidenceArg = process.argv.find((arg) =>
    arg.startsWith("--evidence-dir="),
  );
  summary.finished_at = new Date().toISOString();
  summary.cleanup = { workspace_removed: true };
  await fs.rm(root, { recursive: true, force: true });
  if (evidenceArg) {
    const destination = evidenceArg.slice("--evidence-dir=".length);
    assert(path.isAbsolute(destination), "EVIDENCE_ABSOLUTE");
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(
      path.join(destination, "storage-summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
  }
  process.stdout.write(`STORAGE_E2E_SUMMARY ${JSON.stringify(summary)}\n`);
  process.exitCode = summary.passed ? 0 : 1;
}
