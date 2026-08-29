import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  __configureDatasetWorkerForTests,
  __datasetWorkerDebugState,
  __shutdownDatasetWorker,
  activatePreparedDataset,
  beginDatasetPreparation,
  beginInactiveLocationCleanup,
  catalogDatasets,
  currentDatasetLocation,
  datasetHealth,
  deactivateDatasetIfLocation,
  describeDataset,
  endDatasetPreparation,
  endInactiveLocationCleanup,
  extractDataset,
  listDatasets,
  queryDataset,
  registerDataset,
} from "../data/datasets.js";
import { DataServiceError } from "../data/errors.js";

const temporaryDirectories: string[] = [];
const accountsFixture = fileURLToPath(new URL("../../../data/sample/accounts.csv", import.meta.url));

function account(): string {
  return `acct-${randomUUID()}`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "borealis-datasets-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function csvFile(name: string, content: string): Promise<string> {
  const directory = await temporaryDirectory();
  const file = path.join(directory, name);
  await writeFile(file, content, "utf8");
  return file;
}

async function expectStatus(operation: Promise<unknown>, status: number): Promise<DataServiceError> {
  const error = await operation.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(DataServiceError);
  expect(error).toMatchObject({ status, code: "DATA_SERVICE_ERROR" });
  return error as DataServiceError;
}

async function waitForScope(accountId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await __datasetWorkerDebugState()).scopes.some((scope) => scope.accountId === accountId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("dataset scope was not created");
}

function centralDirectoryOffset(archive: Buffer): number {
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return archive.readUInt32LE(offset + 16);
  }
  throw new Error("missing ZIP central directory");
}

async function workbookFile(name: string): Promise<string> {
  const directory = await temporaryDirectory();
  const file = path.join(directory, name);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Ledger");
  sheet.addRow(["item", "amount"]);
  sheet.addRow(["rent", 1200.5]);
  await workbook.xlsx.writeFile(file);
  return file;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
  await __shutdownDatasetWorker();
});

describe("DuckDB dataset worker", () => {
  it("smoke-tests the worker and preserves the exact register/query/describe/extract facade path", async () => {
    const accountId = account();
    expect(await datasetHealth()).toBe(true);

    const metadata = await registerDataset({
      accountId,
      name: "accounts",
      location: accountsFixture,
      kind: "path",
      originalName: "accounts.csv",
    });
    expect(metadata.rows).toBe(4);

    expect(await queryDataset(accountId, "SELECT count(*) AS n FROM accounts", ["accounts"])).toMatchObject({
      columns: ["n"],
      rows: [[4]],
    });
    expect(await describeDataset(accountId, "accounts", ["accounts"])).toMatchObject({
      table: "accounts",
      rows: 4,
      columns: expect.arrayContaining([expect.objectContaining({ name: "opened", type: "DATE" })]),
    });
    expect(await extractDataset(accountId, "accounts", ["accounts"], 2)).toEqual({
      columns: ["account", "institution", "type", "opened"],
      rows: [
        ["Checking", "First National", "Checking", "2021-03-14"],
        ["Savings", "First National", "Savings", "2021-03-14"],
      ],
      row_count: 4,
      total_row_count: 4,
      returned_row_count: 2,
      columns_truncated: false,
      truncated: true,
    });
  });

  it("enforces exactly one leading SELECT/WITH/VALUES statement without eating quoted terminators", async () => {
    const accountId = account();
    await expect(queryDataset(accountId, " SELECT 2 AS n", [])).resolves.toMatchObject({ rows: [[2]] });
    await expect(
      queryDataset(accountId, "/* outer /* nested */ */ WITH n AS (SELECT 3 AS value) SELECT * FROM n", [])
    ).resolves.toMatchObject({
      rows: [[3]],
    });
    await expect(queryDataset(accountId, "VALUES (4)", [])).resolves.toMatchObject({ rows: [[4]] });
    await expect(queryDataset(accountId, "SELECT ';' AS value; -- trailing", [])).resolves.toMatchObject({
      rows: [[";"]],
    });
    await expect(queryDataset(accountId, "SELECT $$a;b$$ AS value;", [])).resolves.toMatchObject({ rows: [["a;b"]] });

    for (const sql of [
      "",
      "PRAGMA functions",
      "INSERT INTO missing VALUES (1)",
      "SELECT 1; SELECT 2",
      "SELECT 1; DROP TABLE missing",
      "INSTALL httpfs",
    ]) {
      await expectStatus(queryDataset(accountId, sql, []), 400);
    }
  });

  it("preserves the former request caps for SQL and raw allowed-table entries", async () => {
    const accountId = account();
    await registerDataset({
      accountId,
      name: "accounts",
      location: accountsFixture,
      kind: "path",
      originalName: "accounts.csv",
    });

    await expect(
      queryDataset(accountId, "SELECT count(*) FROM accounts", Array(100).fill("accounts"))
    ).resolves.toMatchObject({ rows: [[4]] });
    await expectStatus(queryDataset(accountId, "SELECT count(*) FROM accounts", Array(101).fill("accounts")), 422);
    await expectStatus(catalogDatasets(accountId, Array(101).fill("accounts")), 422);
    await expectStatus(queryDataset(accountId, `SELECT 1 /*${"x".repeat(100_000)}*/`, []), 422);
  });

  it("normalizes bigint, decimal, infinity, row counts, and nested strings before postMessage", async () => {
    const accountId = account();
    const exact = await queryDataset(
      accountId,
      "SELECT 9007199254740993::BIGINT AS big, " +
        "123456789012345678.123456::DECIMAL(36,6) AS amount, 1.0/0.0 AS infinity",
      []
    );
    expect(exact.rows).toEqual([["9007199254740993", "123456789012345678.123456", null]]);

    const rowBounded = await queryDataset(accountId, "SELECT i FROM range(600) AS rows(i)", []);
    expect(rowBounded.rows).toHaveLength(500);
    expect(rowBounded.truncated).toBe(true);

    const nestedBounded = await queryDataset(accountId, "SELECT {'items': [repeat('x', 20000)]} AS nested", []);
    expect(nestedBounded.rows[0]?.[0]).toEqual(expect.any(String));
    expect(String(nestedBounded.rows[0]?.[0])).toHaveLength(10_000);
    expect(String(nestedBounded.rows[0]?.[0])).toMatch(/…$/);
    expect(nestedBounded.truncated).toBe(true);
  });

  it("keeps empty allowlists empty and disables every external table reader after trusted loading", async () => {
    const accountId = account();
    const source = await csvFile("private.csv", "secret\ncanary\n");
    await registerDataset({
      accountId,
      name: "private_data",
      location: source,
      kind: "path",
      originalName: "private.csv",
    });

    expect(
      await queryDataset(accountId, "SELECT current_setting('enable_external_access') AS enabled", [])
    ).toMatchObject({
      rows: [[false]],
    });
    await expectStatus(queryDataset(accountId, "SELECT * FROM private_data", []), 422);
    await expectStatus(queryDataset(accountId, "SELECT 1", ["unregistered"]), 400);
    const escaped = source.replaceAll("'", "''");
    await expectStatus(queryDataset(accountId, `SELECT * FROM read_csv_auto('${escaped}')`, []), 422);
  });

  it("reloads a scoped catalog only when the registered file signature changes", async () => {
    const accountId = account();
    const source = await csvFile("changing.csv", "value\n1\n");
    await registerDataset({
      accountId,
      name: "changing",
      location: source,
      kind: "path",
      originalName: "changing.csv",
    });
    expect(await queryDataset(accountId, "SELECT value FROM changing", ["changing"])).toMatchObject({ rows: [[1]] });

    await writeFile(source, "value\n200\n300\n", "utf8");
    expect(await queryDataset(accountId, "SELECT value FROM changing ORDER BY value", ["changing"])).toMatchObject({
      rows: [[200], [300]],
    });
    expect((await describeDataset(accountId, "changing", ["changing"])).rows).toBe(2);
  });

  it("bounds scoped catalogs to an eight-entry per-account LRU", async () => {
    const accountId = account();
    const tables: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const name = `table_${index}`;
      tables.push(name);
      const source = await csvFile(`${name}.csv`, `value\n${index}\n`);
      await registerDataset({ accountId, name, location: source, kind: "path", originalName: `${name}.csv` });
    }
    const requestedScopes = [
      [tables[0]!],
      [tables[1]!],
      [tables[2]!],
      [tables[3]!],
      [tables[0]!, tables[1]!],
      [tables[0]!, tables[2]!],
      [tables[0]!, tables[3]!],
      [tables[1]!, tables[2]!],
    ];
    for (const scope of requestedScopes) await queryDataset(accountId, "SELECT 1", scope);
    await queryDataset(accountId, "SELECT 1", requestedScopes[0]!);
    await queryDataset(accountId, "SELECT 1", [tables[1]!, tables[3]!]);

    const accountScopes = (await __datasetWorkerDebugState()).scopes.filter((scope) => scope.accountId === accountId);
    expect(accountScopes).toHaveLength(8);
    expect(accountScopes.some((scope) => scope.tables.join() === tables[0])).toBe(true);
    expect(accountScopes.some((scope) => scope.tables.join() === tables[1])).toBe(false);
  });

  it("propagates XLSX processing statuses and rejects legacy XLS without DuckDB extensions", async () => {
    const oversized = await workbookFile("oversized.xlsx");
    const archive = await readFile(oversized);
    archive.writeUInt32LE(50 * 1024 * 1024 + 1, centralDirectoryOffset(archive) + 24);
    await writeFile(oversized, archive);
    await expectStatus(
      registerDataset({
        accountId: account(),
        name: "oversized",
        location: oversized,
        kind: "path",
        originalName: "oversized.xlsx",
      }),
      413
    );

    const encrypted = await workbookFile("encrypted.xlsx");
    const encryptedArchive = await readFile(encrypted);
    const centralOffset = centralDirectoryOffset(encryptedArchive);
    const localOffset = encryptedArchive.readUInt32LE(centralOffset + 42);
    encryptedArchive.writeUInt16LE(encryptedArchive.readUInt16LE(centralOffset + 8) | 0x0001, centralOffset + 8);
    encryptedArchive.writeUInt16LE(encryptedArchive.readUInt16LE(localOffset + 6) | 0x0001, localOffset + 6);
    await writeFile(encrypted, encryptedArchive);
    await expectStatus(
      registerDataset({
        accountId: account(),
        name: "encrypted",
        location: encrypted,
        kind: "path",
        originalName: "encrypted.xlsx",
      }),
      422
    );

    const legacy = await csvFile("legacy.xls", "not an xls workbook");
    await expectStatus(
      registerDataset({
        accountId: account(),
        name: "legacy",
        location: legacy,
        kind: "path",
        originalName: "legacy.xls",
      }),
      422
    );
  });

  it("uses cleanup reservations to close preparation/activation/deletion races", async () => {
    const accountId = account();
    const active = await csvFile("active.csv", "value\n1\n");
    const candidate = await csvFile("candidate.csv", "value\n2\n");
    await registerDataset({
      accountId,
      name: "feed",
      location: active,
      kind: "url",
      originalName: "feed.csv",
      url: "https://example.test/feed",
      expectedFormat: "csv",
    });

    await expectStatus(beginInactiveLocationCleanup(accountId, "feed", active), 409);
    await beginDatasetPreparation(accountId, "feed", candidate);
    await expectStatus(beginInactiveLocationCleanup(accountId, "feed", candidate), 409);
    await endDatasetPreparation(accountId, "feed", candidate);

    await beginInactiveLocationCleanup(accountId, "feed", candidate);
    await expectStatus(beginDatasetPreparation(accountId, "feed", candidate), 409);
    await expectStatus(
      activatePreparedDataset({
        accountId,
        name: "feed",
        location: candidate,
        originalName: "feed.csv",
        url: "https://example.test/feed",
        expectedFormat: "csv",
        expectedPreviousLocation: active,
      }),
      409
    );
    expect((await __datasetWorkerDebugState()).cleanupReservations).toBeGreaterThan(0);
    await endInactiveLocationCleanup(accountId, "feed", candidate);

    // The facade releases after deleting the file (and possibly its now-empty
    // cache directory), so canonical location keys must remain stable then.
    const removedCandidate = await csvFile("removed.csv", "value\n3\n");
    await beginInactiveLocationCleanup(accountId, "feed", removedCandidate);
    await rm(path.dirname(removedCandidate), { recursive: true, force: true });
    await endInactiveLocationCleanup(accountId, "feed", removedCandidate);
    expect((await __datasetWorkerDebugState()).cleanupReservations).toBe(0);

    await expect(
      activatePreparedDataset({
        accountId,
        name: "feed",
        location: candidate,
        originalName: "feed.csv",
        url: "https://example.test/feed",
        expectedFormat: "csv",
        expectedPreviousLocation: active,
      })
    ).resolves.toMatchObject({ location: candidate, previous_location: active });
    expect(await deactivateDatasetIfLocation(accountId, "feed", active)).toBe(false);
    expect(await deactivateDatasetIfLocation(accountId, "feed", candidate)).toBe(true);
  });

  it("compensates cancelled reservation acquisition without releasing another request's count", async () => {
    const accountId = account();
    const candidate = await csvFile("candidate.csv", "value\n2\n");

    await beginDatasetPreparation(accountId, "feed", candidate);
    const preparationController = new AbortController();
    const cancelledPreparation = beginDatasetPreparation(accountId, "feed", candidate, preparationController.signal);
    preparationController.abort();
    await expect(cancelledPreparation).rejects.toMatchObject({ name: "AbortError" });
    expect((await __datasetWorkerDebugState()).pendingPreparations).toBe(1);
    await expectStatus(beginInactiveLocationCleanup(accountId, "feed", candidate), 409);
    await endDatasetPreparation(accountId, "feed", candidate);

    const cleanupController = new AbortController();
    const cancelledCleanup = beginInactiveLocationCleanup(accountId, "feed", candidate, cleanupController.signal);
    cleanupController.abort();
    await expect(cancelledCleanup).rejects.toMatchObject({ name: "AbortError" });
    expect((await __datasetWorkerDebugState()).cleanupReservations).toBe(0);

    await beginDatasetPreparation(accountId, "feed", candidate);
    await endDatasetPreparation(accountId, "feed", candidate);
  });

  it("does not hold the registry/CAS mutex while a same-account query is executing", async () => {
    const accountId = account();
    const otherAccount = account();
    const original = await csvFile("original.csv", "value\n1\n");
    const replacement = await csvFile("replacement.csv", "value\n2\n");
    const other = await csvFile("other.csv", "value\n9\n");
    await registerDataset({ accountId, name: "live", location: original, kind: "path", originalName: "original.csv" });

    const controller = new AbortController();
    const slowQuery = queryDataset(
      accountId,
      "SELECT SUM(range_value) FROM range(1000000000000) values(range_value) CROSS JOIN live",
      ["live"],
      controller.signal
    ).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error })
    );
    await waitForScope(accountId);

    const sameAccountRegistration = registerDataset({
      accountId,
      name: "live",
      location: replacement,
      kind: "path",
      originalName: "replacement.csv",
    });
    const otherAccountRegistration = registerDataset({
      accountId: otherAccount,
      name: "other",
      location: other,
      kind: "path",
      originalName: "other.csv",
    });
    await expect(
      Promise.race([
        Promise.all([sameAccountRegistration, otherAccountRegistration]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("registry CAS was blocked by DuckDB I/O")), 2_000)
        ),
      ])
    ).resolves.toBeDefined();
    expect(await currentDatasetLocation(accountId, "live")).toBe(replacement);

    controller.abort();
    expect((await slowQuery).error).toMatchObject({ name: "AbortError" });
    expect(await queryDataset(accountId, "SELECT value FROM live", ["live"])).toMatchObject({ rows: [[2]] });
    expect(await queryDataset(otherAccount, "SELECT value FROM other", ["other"])).toMatchObject({ rows: [[9]] });
  });

  it("interrupts the 30-second boundary as 504 and closes the timed-out scope", async () => {
    const accountId = account();
    await __configureDatasetWorkerForTests({ queryTimeoutMs: 10 });
    try {
      await expectStatus(queryDataset(accountId, "SELECT SUM(value) FROM range(1000000000000) values(value)", []), 504);
      const state = await __datasetWorkerDebugState();
      expect(state.scopes.some((scope) => scope.accountId === accountId)).toBe(false);
    } finally {
      await __configureDatasetWorkerForTests({ queryTimeoutMs: 30_000 });
    }
  }, 20_000); // seconds under parallel test load; the assertion itself must not flake. // Interrupting a saturating DuckDB aggregation is cooperative and can take

  it("lists and catalogs only explicitly requested registered metadata", async () => {
    const accountId = account();
    const alpha = await csvFile("alpha.csv", "value\n1\n");
    const secret = await csvFile("secret.csv", "private\n3\n");
    await registerDataset({ accountId, name: "alpha", location: alpha, kind: "path", originalName: "alpha.csv" });
    await registerDataset({ accountId, name: "secret", location: secret, kind: "path", originalName: "secret.csv" });

    expect(await listDatasets(accountId, true)).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: "alpha", rows: 1, exists: true })])
    );
    expect(await catalogDatasets(accountId, ["alpha"])).toMatchObject({
      total: 1,
      returned: 1,
      datasets: [expect.objectContaining({ table: "alpha", original_name: "alpha.csv" })],
    });
  });
});
