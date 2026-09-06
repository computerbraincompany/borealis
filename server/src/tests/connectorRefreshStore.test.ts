import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { encodeJson } from "../db/codecs.js";
import {
  CONNECTOR_REFRESH_REPAIR_LIMIT,
  ConnectorRefreshStore,
  nextConnectorRefreshTimestamp,
  readRefreshLocationsForDeleteTx,
  reservePreparingTx,
  type ConnectorRefreshIdentity,
} from "../db/stores/connectorRefreshStore.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import type { SqliteLedger } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];
const T0 = new Date("2026-09-05T00:00:00.000Z");

interface Fixture {
  readonly ledger: SqliteLedger;
  readonly store: ConnectorRefreshStore;
  readonly sources: SourceStore;
  readonly accountId: string;
  setNow: (now: Date) => void;
}

let clock = T0;

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

async function fixture(): Promise<Fixture> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  const accountId = randomUUID();
  await resource.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    accountId,
    `${accountId}@example.test`,
    "hash",
  ]);
  clock = T0;
  return {
    ledger: resource.ledger,
    store: new ConnectorRefreshStore(resource.ledger, { now: () => clock }),
    sources: new SourceStore(resource.ledger),
    accountId,
    setNow: (now: Date) => {
      clock = now;
    },
  };
}

async function connectorSource(
  fixtureValue: Fixture,
  overrides: {
    status?: "ready" | "index" | "error";
    filePath?: string | null;
    readyGeneration?: number | null;
    generation?: number;
    jobStatus?: "preparing" | "pending" | "running" | "done" | "error";
    leaseToken?: string | null;
    refreshVersion?: string;
  } = {}
): Promise<{ accountId: string; connectorId: string; sourceId: string; identity: ConnectorRefreshIdentity }> {
  const { ledger, accountId } = fixtureValue;
  const connectorId = randomUUID();
  const sourceId = randomUUID();
  const refreshVersion = overrides.refreshVersion ?? randomUUID();
  const generation = overrides.generation ?? 1;
  const timestamp = clock.toISOString();
  await ledger.run(
    `INSERT INTO connectors (id,account_id,name,type,config,target_table,sync_status)
     VALUES (?,?,?,'url_csv','{}',?,'indexing')`,
    [connectorId, accountId, `Feed ${sourceId.slice(0, 8)}`, `feed_${sourceId.slice(0, 8)}`]
  );
  await ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,connector,display_name,file_path,status,meta,ready_generation)
     VALUES (?,?,?,'tabular',?,?,?,?,?,?)`,
    [
      sourceId,
      accountId,
      `feed_${sourceId.slice(0, 8)}`,
      connectorId,
      "Feed",
      overrides.filePath ?? null,
      overrides.status ?? "index",
      encodeJson({}),
      overrides.readyGeneration ?? null,
    ]
  );
  await ledger.run(
    `INSERT INTO ingestion_jobs
       (source_id,account_id,generation,status,attempts,available_at,lease_token,created_at,updated_at)
     VALUES (?,?,?,?,1,?,?,?,?)`,
    [
      sourceId,
      accountId,
      generation,
      overrides.jobStatus ?? "preparing",
      timestamp,
      overrides.leaseToken ?? "lease",
      timestamp,
      timestamp,
    ]
  );
  return {
    accountId,
    connectorId,
    sourceId,
    identity: { accountId, sourceId, connectorId, generation, refreshVersion },
  };
}

async function reserve(fixtureValue: Fixture, identity: ConnectorRefreshIdentity): Promise<void> {
  await fixtureValue.ledger.withImmediateTransaction((transaction) => {
    if (
      !reservePreparingTx(transaction, {
        ...identity,
        timestamp: clock.toISOString(),
      })
    ) {
      throw new Error("reservePreparingTx rejected");
    }
  });
}

describe("connector refresh typed store", () => {
  it("decodes each durable phase strictly and rejects inconsistent rows at the schema boundary", async () => {
    const fx = await fixture();
    const { identity, sourceId } = await connectorSource(fx);
    await reserve(fx, identity);
    await expect(fx.store.getState(fx.accountId, sourceId)).resolves.toMatchObject({
      phase: "preparing",
      generation: 1,
      attempts: 0,
      candidateLocation: null,
      activationPreviousLocation: null,
      cleanupPreviousLocation: null,
    });

    await expect(
      fx.store.recordPrepared(identity, {
        candidateLocation: "/cache/candidate.csv",
        activationPreviousLocation: "/cache/previous.csv",
        cleanupPreviousLocation: "/cache/old.csv",
      })
    ).resolves.toBe(true);
    await expect(fx.store.getState(fx.accountId, sourceId)).resolves.toMatchObject({
      phase: "prepared",
      candidateLocation: "/cache/candidate.csv",
      activationPreviousLocation: "/cache/previous.csv",
      cleanupPreviousLocation: "/cache/old.csv",
    });

    // Inconsistent rows are impossible by CHECK, not by decoder trust.
    await expect(
      fx.ledger.run(
        `UPDATE connector_refresh_states SET phase='cleanup_pending', activation_previous_location=NULL,
           cleanup_previous_location=candidate_location
         WHERE source_id=?`,
        [sourceId]
      )
    ).rejects.toMatchObject({ kind: "check" });
    await expect(
      fx.ledger.run(`UPDATE connector_refresh_states SET phase='prepared', candidate_location=NULL WHERE source_id=?`, [
        sourceId,
      ])
    ).rejects.toMatchObject({ kind: "check" });
  });

  it("scopes every read and CAS by account/connector/generation/version, never source alone", async () => {
    const fx = await fixture();
    const first = await connectorSource(fx);
    await reserve(fx, first.identity);
    await expect(fx.store.getState("ffffffff-ffff-4fff-8fff-ffffffffffff", first.sourceId)).resolves.toBeUndefined();

    // Same protocol fields, wrong account identity in the CAS.
    await expect(
      fx.store.recordPrepared(
        { ...first.identity, accountId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
        { candidateLocation: "/c", activationPreviousLocation: null, cleanupPreviousLocation: null }
      )
    ).resolves.toBe(false);

    const foreign = randomUUID();
    await fx.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [foreign, "f@example.test", "h"]);
    const foreignConnector = randomUUID();
    await fx.ledger.run(
      `INSERT INTO connectors (id,account_id,name,type,config,target_table,sync_status)
       VALUES (?,?,?,'url_csv','{}','other','indexing')`,
      [foreignConnector, foreign, "Other feed"]
    );
    // Cross-account source/connector pairing cannot even be inserted: both
    // composite foreign keys demand one tenanted triple.
    await fx.ledger.run(`DELETE FROM connector_refresh_states WHERE source_id=?`, [first.sourceId]);
    await expect(
      fx.ledger.run(
        `INSERT INTO connector_refresh_states
           (source_id,account_id,connector_id,generation,refresh_version,phase,candidate_location)
         VALUES (?,?,?,1,'x','activating','/c')`,
        [first.sourceId, foreign, foreignConnector]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await reserve(fx, first.identity);
    // And the CAS refuses a wrong connector/generation/version each time.
    await expect(fx.store.claimActivation({ ...first.identity, connectorId: foreignConnector })).resolves.toBe(false);
    await expect(fx.store.claimActivation({ ...first.identity, generation: 7 })).resolves.toBe(false);
    await expect(fx.store.claimActivation({ ...first.identity, refreshVersion: "wrong" })).resolves.toBe(false);
  });

  it("walks the legal phase graph with attempts reset on every successful transition", async () => {
    const fx = await fixture();
    const { identity, sourceId } = await connectorSource(fx);
    await reserve(fx, identity);
    await fx.store.recordPrepared(identity, {
      candidateLocation: "/cache/candidate.csv",
      activationPreviousLocation: "/cache/previous.csv",
      cleanupPreviousLocation: "/cache/old.csv",
    });
    await expect(fx.store.claimActivation(identity)).resolves.toBe(true);
    await expect(fx.store.getState(fx.accountId, sourceId)).resolves.toMatchObject({
      phase: "activating",
      attempts: 0,
    });
    await expect(fx.store.confirmActivation(identity)).resolves.toBe(true);
    await expect(fx.store.getState(fx.accountId, sourceId)).resolves.toMatchObject({ phase: "activated" });

    // Promotion finalization inside the caller's transaction.
    await fx.ledger.withImmediateTransaction((transaction) => {
      const pending = readRefreshLocationsForDeleteTx(transaction, fx.accountId, sourceId);
      expect(pending).toEqual({
        candidateLocation: "/cache/candidate.csv",
        activationPreviousLocation: "/cache/previous.csv",
        cleanupPreviousLocation: "/cache/old.csv",
      });
      const changed = transaction.run(
        `UPDATE connector_refresh_states
         SET phase='cleanup_pending', activation_previous_location=NULL, attempts=0
         WHERE source_id=? AND phase='activated'`,
        [sourceId]
      );
      expect(changed.changes).toBe(1);
    });
    await expect(fx.store.getState(fx.accountId, sourceId)).resolves.toMatchObject({
      phase: "cleanup_pending",
      candidateLocation: "/cache/candidate.csv",
      activationPreviousLocation: null,
      cleanupPreviousLocation: "/cache/old.csv",
    });
    await expect(fx.store.completeExactCleanup({ identity, cleanupLocation: "/cache/old.csv" })).resolves.toBe(true);
    await expect(fx.store.getState(fx.accountId, sourceId)).resolves.toBeUndefined();
  });

  it("returns an unactivated activating row to prepared and refuses illegal phase skips", async () => {
    const fx = await fixture();
    const { identity } = await connectorSource(fx);
    await reserve(fx, identity);
    await fx.store.recordPrepared(identity, {
      candidateLocation: "/c.csv",
      activationPreviousLocation: "/p.csv",
      cleanupPreviousLocation: null,
    });
    await expect(fx.store.claimActivation(identity)).resolves.toBe(true);
    // Illegal skips: activated requires passing through activating; prepared
    // cannot re-adopt a candidate twice.
    await expect(fx.store.confirmActivation(identity)).resolves.toBe(true);
    await expect(fx.store.confirmActivation(identity)).resolves.toBe(false);
    await expect(
      fx.store.recordPrepared(identity, {
        candidateLocation: "/other.csv",
        activationPreviousLocation: null,
        cleanupPreviousLocation: null,
      })
    ).resolves.toBe(false);

    const again = await connectorSource(fx);
    await reserve(fx, again.identity);
    await fx.store.recordPrepared(again.identity, {
      candidateLocation: "/c.csv",
      activationPreviousLocation: null,
      cleanupPreviousLocation: null,
    });
    await expect(fx.store.claimActivation(again.identity)).resolves.toBe(true);
    await expect(fx.store.returnActivatingToPrepared(again.identity)).resolves.toBe(true);
    await expect(fx.store.returnActivatingToPrepared(again.identity)).resolves.toBe(false);
    await expect(fx.store.getState(fx.accountId, again.sourceId)).resolves.toMatchObject({ phase: "prepared" });
  });

  it("increments attempts with a monotonic successor under a fixed and a backward clock", async () => {
    const fx = await fixture();
    const { identity, sourceId } = await connectorSource(fx);
    await reserve(fx, identity);

    const first = await fx.store.getState(fx.accountId, sourceId);
    expect(first).toMatchObject({ attempts: 0, updatedAt: T0.toISOString() });

    // Fixed clock: every touch must still move the row strictly forward.
    await expect(
      fx.store.touchFailedAttempt({
        identity,
        expectedPhase: "preparing",
        expectedAttempts: 0,
        expectedUpdatedAt: first!.updatedAt,
      })
    ).resolves.toBe(true);
    const touched = await fx.store.getState(fx.accountId, sourceId);
    expect(touched).toMatchObject({ attempts: 1 });
    expect(touched!.updatedAt).toBe(new Date(T0.getTime() + 1).toISOString());

    // Backward clock: the successor is the selected row + 1 ms, not the clock.
    fx.setNow(new Date(T0.getTime() - 60_000));
    await expect(
      fx.store.touchFailedAttempt({
        identity,
        expectedPhase: "preparing",
        expectedAttempts: 1,
        expectedUpdatedAt: touched!.updatedAt,
      })
    ).resolves.toBe(true);
    const again = await fx.store.getState(fx.accountId, sourceId);
    expect(again).toMatchObject({ attempts: 2 });
    expect(again!.updatedAt).toBe(new Date(T0.getTime() + 2).toISOString());

    // The stale touch (old attempts/timestamp identity) loses the CAS.
    await expect(
      fx.store.touchFailedAttempt({
        identity,
        expectedPhase: "preparing",
        expectedAttempts: 1,
        expectedUpdatedAt: touched!.updatedAt,
      })
    ).resolves.toBe(false);
    // Success transitions reset attempts to zero while advancing time.
    await fx.store.recordPrepared(identity, {
      candidateLocation: "/c.csv",
      activationPreviousLocation: null,
      cleanupPreviousLocation: null,
    });
    await expect(fx.store.getState(fx.accountId, sourceId)).resolves.toMatchObject({ attempts: 0 });
  });

  it("orders periodic pages attempts-first so failed work moves behind untouched work at a tied clock", async () => {
    const fx = await fixture();
    const seeded: ConnectorRefreshIdentity[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await connectorSource(fx);
      await reserve(fx, created.identity);
      seeded.push(created.identity);
    }
    // Pin every row to one updated_at so only attempts can break the tie.
    await fx.ledger.run(`UPDATE connector_refresh_states SET updated_at=?`, [T0.toISOString()]);
    const [first, second, third] = seeded;
    await expect(
      fx.store.touchFailedAttempt({
        identity: first!,
        expectedPhase: "preparing",
        expectedAttempts: 0,
        expectedUpdatedAt: T0.toISOString(),
      })
    ).resolves.toBe(true);

    const page = await fx.store.listRepairableStates(3);
    const untouchedOrder = [second!.sourceId, third!.sourceId].sort();
    expect(page.map((state) => [state.sourceId, state.attempts])).toEqual([
      [untouchedOrder[0], 0],
      [untouchedOrder[1], 0],
      [first!.sourceId, 1],
    ]);
    // The second in-page touch of the failed row uses its new attempts and
    // strictly-greater timestamp identity.
    const failed = page[2]!;
    await expect(
      fx.store.touchFailedAttempt({
        identity: first!,
        expectedPhase: "preparing",
        expectedAttempts: failed.attempts,
        expectedUpdatedAt: failed.updatedAt,
      })
    ).resolves.toBe(true);
    const next = await fx.store.listRepairableStates(3);
    expect(next[2]).toMatchObject({ sourceId: first!.sourceId, attempts: 2 });
    expect(next[2]!.updatedAt > failed.updatedAt).toBe(true);
  });

  it("pages a finite startup snapshot by immutable ordinal, excluding later inserts", async () => {
    const fx = await fixture();
    const captured: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const created = await connectorSource(fx);
      await reserve(fx, created.identity);
      captured.push(created.sourceId);
    }
    const capturedMax = await fx.store.captureMaxRepairOrdinal();
    expect(capturedMax).toBe(25);

    // A row created after capture has a larger ordinal and waits for periodic.
    const late = await connectorSource(fx);
    await reserve(fx, late.identity);
    // A captured high-ordinal row is deleted before the pass: it must simply
    // never be attempted, and its ordinal must never be reused.
    await fx.ledger.run(`DELETE FROM connector_refresh_states WHERE source_id=?`, [captured[24]!]);

    let cursor = 0;
    const pages: number[] = [];
    const attempted: string[] = [];
    for (;;) {
      const page = await fx.store.listRepairableStatesUpTo(capturedMax, cursor, CONNECTOR_REFRESH_REPAIR_LIMIT);
      if (page.length === 0) break;
      pages.push(page.length);
      for (const state of page) attempted.push(state.sourceId);
      cursor = page[page.length - 1]!.repairOrdinal;
      if (page.length < CONNECTOR_REFRESH_REPAIR_LIMIT) break;
    }
    expect(pages).toEqual([20, 4]);
    expect(attempted).toHaveLength(24);
    expect(attempted).not.toContain(late.sourceId);
    const lateState = await fx.store.getState(fx.accountId, late.sourceId);
    expect(lateState).toMatchObject({ attempts: 0 });
    // The deleted captured row cannot be re-attempted: its ordinal is gone
    // and the AUTOINCREMENT sequence never reuses it.
    const grown = await connectorSource(fx);
    await reserve(fx, grown.identity);
    const grownState = await fx.store.getState(fx.accountId, grown.sourceId);
    expect(grownState!.repairOrdinal).toBeGreaterThan(capturedMax + 1);
    const after = await fx.store.listRepairableStatesUpTo(capturedMax, 0, 50);
    expect(after.map((state) => state.sourceId)).not.toContain(captured[24]);
  });

  it("validates page limits and touch inputs", async () => {
    const fx = await fixture();
    const { identity } = await connectorSource(fx);
    await expect(fx.store.listRepairableStates(0)).rejects.toMatchObject({
      code: "CONNECTOR_REFRESH_INVALID_ARGUMENT",
    });
    await expect(fx.store.listRepairableStates(51)).rejects.toMatchObject({
      code: "CONNECTOR_REFRESH_INVALID_ARGUMENT",
    });
    await expect(fx.store.listRepairableStatesUpTo(5, -1, 20)).rejects.toMatchObject({
      code: "CONNECTOR_REFRESH_INVALID_ARGUMENT",
    });
    await expect(
      fx.store.touchFailedAttempt({
        identity,
        expectedPhase: "preparing",
        expectedAttempts: -1,
        expectedUpdatedAt: T0.toISOString(),
      })
    ).rejects.toMatchObject({ code: "CONNECTOR_REFRESH_INVALID_ARGUMENT" });
    await expect(
      fx.store.recordPrepared(identity, {
        candidateLocation: "   ",
        activationPreviousLocation: null,
        cleanupPreviousLocation: null,
      })
    ).rejects.toMatchObject({ code: "CONNECTOR_REFRESH_INVALID_ARGUMENT" });
    expect(() => nextConnectorRefreshTimestamp(T0, "not-a-timestamp")).toThrowError();
    expect(nextConnectorRefreshTimestamp(new Date(T0.getTime() + 5_000), T0.toISOString())).toBe(
      new Date(T0.getTime() + 5_000).toISOString()
    );
    expect(nextConnectorRefreshTimestamp(new Date(T0.getTime() - 5_000), T0.toISOString())).toBe(
      new Date(T0.getTime() + 1).toISOString()
    );
  });

  it("cascades with the source and connector it references", async () => {
    const fx = await fixture();
    const { sourceId } = await connectorSource(fx);
    await fx.ledger.run(`DELETE FROM ingestion_jobs WHERE source_id=?`, [sourceId]);
    await fx.ledger.run(`DELETE FROM sources WHERE id=?`, [sourceId]);
    await expect(fx.store.getState(fx.accountId, sourceId)).resolves.toBeUndefined();

    const second = await connectorSource(fx);
    await fx.ledger.run(`DELETE FROM ingestion_jobs WHERE source_id=?`, [second.sourceId]);
    await fx.ledger.run(`DELETE FROM sources WHERE id=?`, [second.sourceId]);
    await fx.ledger.run(`DELETE FROM connectors WHERE id=?`, [second.connectorId]);
    await expect(fx.store.getState(fx.accountId, second.sourceId)).resolves.toBeUndefined();
    await expect(fx.ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("reserves superseded prepares only: replaces preparing/prepared and queued cleanup, never ambiguous phases", async () => {
    const fx = await fixture();
    const prepared = await connectorSource(fx);
    await reserve(fx, prepared.identity);
    await fx.store.recordPrepared(prepared.identity, {
      candidateLocation: "/c.csv",
      activationPreviousLocation: null,
      cleanupPreviousLocation: null,
    });
    // A prepared row for a superseded generation may be replaced.
    await reserve(fx, { ...prepared.identity, generation: 2, refreshVersion: randomUUID() });
    await expect(fx.store.getState(fx.accountId, prepared.sourceId)).resolves.toMatchObject({
      phase: "preparing",
      generation: 2,
    });

    const ambiguous = await connectorSource(fx);
    await reserve(fx, ambiguous.identity);
    await fx.store.recordPrepared(ambiguous.identity, {
      candidateLocation: "/c.csv",
      activationPreviousLocation: "/p.csv",
      cleanupPreviousLocation: null,
    });
    await fx.store.claimActivation(ambiguous.identity);
    await expect(
      fx.ledger.withImmediateTransaction((transaction) => {
        const replaced = reservePreparingTx(transaction, {
          ...ambiguous.identity,
          generation: 2,
          refreshVersion: randomUUID(),
          timestamp: clock.toISOString(),
        });
        if (replaced) throw new Error("ambiguous row was replaced");
      })
    ).resolves.toBeUndefined();
    await expect(fx.store.getState(fx.accountId, ambiguous.sourceId)).resolves.toMatchObject({
      phase: "activating",
      generation: 1,
    });

    const queued = await connectorSource(fx, { status: "ready", filePath: "/live.csv", readyGeneration: 1 });
    await reserve(fx, queued.identity);
    await fx.store.recordPrepared(queued.identity, {
      candidateLocation: "/live.csv",
      activationPreviousLocation: null,
      cleanupPreviousLocation: "/retired.csv",
    });
    // Move to cleanup_pending without a queue row: begin must refuse.
    await fx.ledger.withImmediateTransaction((transaction) => {
      transaction.run(
        `UPDATE connector_refresh_states SET phase='cleanup_pending', activation_previous_location=NULL WHERE source_id=?`,
        [queued.sourceId]
      );
    });
    await expect(
      fx.ledger.withImmediateTransaction((transaction) =>
        reservePreparingTx(transaction, {
          ...queued.identity,
          generation: 2,
          refreshVersion: randomUUID(),
          timestamp: clock.toISOString(),
        })
      )
    ).resolves.toBe(false);
    // Once the exact location is durably queued, the supersession is allowed.
    await fx.ledger.run(`INSERT INTO dataset_cache_cleanup_jobs (account_id,name,location) VALUES (?,?,?)`, [
      fx.accountId,
      `feed_${queued.sourceId.slice(0, 8)}`,
      "/retired.csv",
    ]);
    await expect(
      fx.ledger.withImmediateTransaction((transaction) =>
        reservePreparingTx(transaction, {
          ...queued.identity,
          generation: 2,
          refreshVersion: randomUUID(),
          timestamp: clock.toISOString(),
        })
      )
    ).resolves.toBe(true);
  });
});
