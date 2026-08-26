import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Phase A0 regression for @lancedb/lancedb 0.37.1.
 *
 * Search scope uses VectorQuery.where() with SQL syntax:
 *   account_id = 'account-a' AND source_id IN ('source-a-1')
 *
 * LanceDB prefilters a vector query by default unless postfilter() is called.
 * The explain-plan assertion below proves the account/source FilterExec is an
 * input to KNNVectorDistance rather than a JavaScript result filter.
 */
describe("LanceDB account and source prefilter spike", () => {
  let directory: string | undefined;
  let connection: Connection | undefined;
  let table: Table | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "borealis-lancedb-spike-"));
    connection = await lancedb.connect(directory);
    table = await connection.createTable("chunk_vectors", [
      {
        chunk_id: "account-a-source-1-generation-1",
        account_id: "account-a",
        source_id: "source-a-1",
        generation: 1,
        vector: [0.6, 0.4, 0],
      },
      {
        chunk_id: "orphaned-account-a-source-1-generation-2",
        account_id: "account-a",
        source_id: "source-a-1",
        generation: 2,
        vector: [0.5, 0.5, 0],
      },
      {
        chunk_id: "excluded-account-a-source-2",
        account_id: "account-a",
        source_id: "source-a-2",
        generation: 1,
        vector: [1, 0, 0],
      },
      {
        chunk_id: "excluded-account-b-source-1",
        account_id: "account-b",
        source_id: "source-a-1",
        generation: 1,
        vector: [1, 0, 0],
      },
      {
        chunk_id: "excluded-account-b-source-3",
        account_id: "account-b",
        source_id: "source-b-3",
        generation: 4,
        vector: [0.99, 0.01, 0],
      },
    ]);
  });

  afterEach(async () => {
    table?.close();
    connection?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    table = undefined;
    connection = undefined;
    directory = undefined;
  });

  it("prefilters account and source allowlists inside LanceDB before KNN", async () => {
    const scopePredicate = "account_id = 'account-a' AND source_id IN ('source-a-1')";
    const query = table!
      .vectorSearch([1, 0, 0])
      .where(scopePredicate)
      .distanceType("cosine")
      .select(["chunk_id", "account_id", "source_id", "generation", "_distance"])
      .limit(1);

    const plan = await query.explainPlan(true);
    const knnPosition = plan.indexOf("KNNVectorDistance");
    const scopeFilterPosition = plan.indexOf("FilterExec: account_id");

    expect(knnPosition).toBeGreaterThanOrEqual(0);
    // In the indented physical plan, operators below KNN are its inputs and run first.
    expect(scopeFilterPosition).toBeGreaterThan(knnPosition);
    expect(plan).toContain("full_filter=account_id");
    expect(plan).toContain("source_id");

    const rows = await query.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chunk_id: "account-a-source-1-generation-1",
      account_id: "account-a",
      source_id: "source-a-1",
    });
    expect(rows.some((row) => row.account_id === "account-b" || row.source_id === "source-a-2")).toBe(false);
  });

  it("deletes an orphan generation by source and generation and treats missing rows as no-ops", async () => {
    const deletedGeneration = await table!.delete("source_id = 'source-a-1' AND generation = 2");
    expect(deletedGeneration.numDeletedRows).toBe(1);
    await expect(table!.countRows("source_id = 'source-a-1' AND generation = 2")).resolves.toBe(0);
    await expect(table!.countRows("source_id = 'source-a-1' AND generation = 1")).resolves.toBe(2);
    await expect(table!.countRows("source_id = 'source-a-2' AND generation = 1")).resolves.toBe(1);

    const repeatedDelete = await table!.delete("source_id = 'source-a-1' AND generation = 2");
    expect(repeatedDelete.numDeletedRows).toBe(0);

    const missingChunkDelete = await table!.delete("chunk_id = 'missing-chunk-id'");
    expect(missingChunkDelete.numDeletedRows).toBe(0);
    await expect(table!.countRows()).resolves.toBe(4);
  });
});
