import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { DuckDBInstance, StatementType } from "@duckdb/node-api";
import { afterEach, describe, expect, it } from "vitest";

// Plan 029 Phase 0 characterization for @duckdb/node-api 1.5.5-r.4.
// These checks stay in the suite because the data-service security boundary
// depends on binding behavior that is easy to regress during dependency bumps.

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function connection() {
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "4",
  });
  return instance.connect();
}

describe("Plan 029 DuckDB binding spike", () => {
  it("extracts exactly one statement and exposes SELECT versus mutation types", async () => {
    const db = await connection();
    try {
      await db.run("CREATE TABLE destination(value INTEGER)");

      for (const sql of ["SELECT 1", "WITH value AS (SELECT 1 AS n) SELECT n FROM value", "VALUES (1)"]) {
        const extracted = await db.extractStatements(sql);
        expect(extracted.count).toBe(1);
        const prepared = await extracted.prepare(0);
        expect(prepared.statementType).toBe(StatementType.SELECT);
        prepared.destroySync();
      }

      const extracted = await db.extractStatements("INSERT INTO destination VALUES (1)");
      expect(extracted.count).toBe(1);
      const prepared = await extracted.prepare(0);
      expect(prepared.statementType).toBe(StatementType.INSERT);
      prepared.destroySync();
    } finally {
      db.closeSync();
    }
  });

  it("interrupts an in-flight query promptly", async () => {
    const db = await connection();
    const startedAt = Date.now();
    try {
      const pending = db.run("SELECT SUM(value) FROM range(1000000000000) values(value)");
      const timer = setTimeout(() => db.interrupt(), 25);
      try {
        await expect(pending).rejects.toThrow(/interrupt/i);
      } finally {
        clearTimeout(timer);
      }
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      db.closeSync();
    }
  });

  it("loads trusted CSV before permanently disabling external access", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "borealis-duckdb-"));
    tempDirectories.push(directory);
    const csvPath = path.join(directory, "values.csv");
    await writeFile(csvPath, "name,value\nalpha,1\n", "utf8");

    const db = await connection();
    try {
      await db.run("CREATE TABLE trusted AS SELECT * FROM read_csv_auto($path)", { path: csvPath });
      await db.run("SET enable_external_access=false");

      await expect(db.run("SET enable_external_access=true")).rejects.toThrow(/cannot enable external access/i);
      await expect(db.run("SELECT * FROM read_csv_auto($path)", { path: csvPath })).rejects.toThrow(
        /file system operations are disabled/i
      );

      const reader = await db.runAndReadAll("SELECT name, value FROM trusted");
      expect(reader.getRows()).toEqual([["alpha", 1n]]);
    } finally {
      db.closeSync();
    }
  });

  it("preserves bigint and decimal fidelity across a worker message", async () => {
    const workerSource = String.raw`
      const { parentPort } = require("node:worker_threads");
      (async () => {
        const { DuckDBInstance } = await import("@duckdb/node-api");
        const instance = await DuckDBInstance.create(":memory:");
        const db = await instance.connect();
        const reader = await db.runAndReadAll(
          "SELECT 9007199254740993::BIGINT AS big, " +
            "12345678901234567890.1234::DECIMAL(24,4) AS decimal_value",
        );
        parentPort.postMessage(reader.getRows());
        db.closeSync();
      })().catch((error) => {
        throw error;
      });
    `;

    const worker = new Worker(workerSource, { eval: true, execArgv: [] });
    const rows = await new Promise<unknown[][]>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });

    expect(rows[0]?.[0]).toBe(9_007_199_254_740_993n);
    expect(rows[0]?.[1]).toEqual({
      width: 24,
      scale: 4,
      value: 123_456_789_012_345_678_901_234n,
    });
  });
});
