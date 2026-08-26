import { describe, expect, it, vi } from "vitest";
import { completeSourceDeleteIntents, type SourceCleanupDependencies } from "../sourceCleanup.js";
import type { PendingSourceDelete } from "../db/stores/sourceStore.js";

describe("durable source cleanup coordinator", () => {
  it("purges every vector identity before exact connector cache cleanup and marker clearing", async () => {
    const calls: string[] = [];
    const dependencies = deps(calls);
    const first = intent("source-1", "connector-1", ["/cache/current.csv", "/cache/previous.csv"]);
    const second = intent("source-2", "connector-1", ["/cache/second.csv"]);

    await expect(completeSourceDeleteIntents([first, second], dependencies)).resolves.toEqual({
      completed: true,
      intents: 2,
    });
    expect(calls).toEqual([
      "vectors:source-1",
      "vectors:source-2",
      "deactivate:/cache/current.csv",
      "cache:/cache/current.csv",
      "deactivate:/cache/previous.csv",
      "cache:/cache/previous.csv",
      "deactivate:/cache/second.csv",
      "cache:/cache/second.csv",
      "clear:source-1",
      "clear:source-2",
    ]);
  });

  it("deactivates an uploaded location before exact artifact removal", async () => {
    const calls: string[] = [];
    const dependencies = deps(calls);
    const upload = { ...intent("upload-1", null, ["/uploads/file.csv"]), filePath: "/uploads/file.csv" };

    await expect(completeSourceDeleteIntents([upload], dependencies)).resolves.toEqual({
      completed: true,
      intents: 1,
    });
    expect(calls).toEqual(["vectors:upload-1", "deactivate:/uploads/file.csv", "artifact:upload-1", "clear:upload-1"]);
  });

  it("leaves every marker retryable and records a stable failure code when cleanup fails", async () => {
    const calls: string[] = [];
    const dependencies = deps(calls);
    dependencies.deleteVectors = vi.fn(async (sourceId) => {
      calls.push(`vectors:${sourceId}`);
      if (sourceId === "source-2") throw new Error("raw Lance failure must not escape");
      return 1;
    });
    const first = intent("source-1", "connector-1", ["/cache/one.csv"]);
    const second = intent("source-2", "connector-1", ["/cache/two.csv"]);

    await expect(completeSourceDeleteIntents([first, second], dependencies)).resolves.toEqual({
      completed: false,
      intents: 2,
    });
    expect(calls).toEqual(["vectors:source-1", "vectors:source-2", "failed:source-1", "failed:source-2"]);
  });

  it("deduplicates repeated source intents and bounds batches", async () => {
    const calls: string[] = [];
    const dependencies = deps(calls);
    const repeated = intent("source-1", null, []);
    await expect(completeSourceDeleteIntents([repeated, repeated], dependencies)).resolves.toEqual({
      completed: true,
      intents: 1,
    });
    expect(calls).toEqual(["vectors:source-1", "clear:source-1"]);
    await expect(completeSourceDeleteIntents(new Array(1_001).fill(repeated), dependencies)).rejects.toThrow(
      "at most 1000"
    );
  });
});

function deps(calls: string[]): SourceCleanupDependencies {
  return {
    deleteVectors: vi.fn(async (sourceId) => {
      calls.push(`vectors:${sourceId}`);
      return 1;
    }),
    deactivateDatasetLocation: vi.fn(async (_accountId, _name, location) => {
      calls.push(`deactivate:${location}`);
    }),
    cleanupDatasetCache: vi.fn(async (_accountId, _name, location) => {
      calls.push(`cache:${location}`);
    }),
    removeUploadArtifact: vi.fn(async (value) => {
      calls.push(`artifact:${value.sourceId}`);
    }),
    markFailure: vi.fn(async (value) => {
      calls.push(`failed:${value.sourceId}`);
    }),
    clearIntent: vi.fn(async (value) => {
      calls.push(`clear:${value.sourceId}`);
    }),
  };
}

function intent(sourceId: string, connectorId: string | null, locations: readonly string[]): PendingSourceDelete {
  return {
    sourceId,
    accountId: "account-1",
    name: "ledger",
    filePath: locations[0] ?? null,
    connectorId,
    datasetLocations: locations,
    attempts: 0,
    lastError: null,
    createdAt: "2026-08-26T10:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
  };
}
