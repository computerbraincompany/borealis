/**
 * Actual-storage characterization of plan 014's owned application runtime:
 * the synchronous process-wide lease, overlap rejection with zero side
 * effects, idempotent close, sequential restart at a different path,
 * stale-owner isolation, construction-failure lease release, and the
 * failure-injection matrix that proves closure-attempt-all semantics and
 * process-lifetime poisoning when ownership stays uncertain.
 *
 * Runs only under `vitest.integration.config.ts`: every case opens real
 * SQLite/LanceDB stores through the production storage runtime while the
 * settings, engine, download, and migration lifecycles run through the
 * factory's test seam. Each case re-imports fresh module copies so a
 * deliberately poisoned lease cannot mask a later case, and every case
 * carries explicit temporary storage paths so no test touches operator
 * state.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApplicationRuntime,
  ApplicationRuntimeLifecycle,
  ApplicationRuntimeLifecycleError,
  EmbeddingMigrationPhase,
} from "../applicationRuntime.js";
import type { StorageRuntime, StorageRuntimeOptions } from "../storageRuntime.js";
import type { SqliteLedger } from "../db/types.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const PENDING = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(
      () => "settled",
      () => "rejected"
    ),
    new Promise((resolve) => setTimeout(() => resolve(PENDING), 30)),
  ]);
  return outcome === PENDING;
}

async function insertChat(ledger: SqliteLedger, accountId: string): Promise<string> {
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    accountId,
    `${accountId}@example.test`,
    "hash",
  ]);
  const id = randomUUID();
  await ledger.run("INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,'chat-model','selected')", [
    id,
    accountId,
    "Runtime test chat",
  ]);
  return id;
}

class FakeMigration implements EmbeddingMigrationPhase {
  constructor(
    readonly label: string,
    readonly events: string[],
    private readonly overrides: Partial<
      Record<"recover" | "finalize" | "rollback" | "close", () => Promise<unknown>>
    > = {}
  ) {}

  async recoverBeforeStorageOpen(): Promise<void> {
    this.events.push(`${this.label}:recover`);
    await this.overrides.recover?.();
  }

  async finalizeAfterStorageOpen(): Promise<void> {
    this.events.push(`${this.label}:finalize`);
    await this.overrides.finalize?.();
  }

  async rollbackStartupFailure(): Promise<boolean> {
    this.events.push(`${this.label}:rollback`);
    await this.overrides.rollback?.();
    return false;
  }

  async close(): Promise<void> {
    this.events.push(`${this.label}:close`);
    await this.overrides.close?.();
  }
}

interface SeamOptions {
  readonly settingsGate?: Deferred;
  readonly settingsReject?: Error;
  readonly downloadDrain?: () => Promise<void>;
  readonly engineStop?: () => Promise<void>;
  readonly closeStorage?: () => Promise<void>;
  readonly closeSettings?: () => void;
  readonly openStorage?: (options: StorageRuntimeOptions) => Promise<StorageRuntime>;
  readonly createRunner?: ApplicationRuntimeLifecycle["createRunner"];
  readonly createAnalysisRunner?: ApplicationRuntimeLifecycle["createAnalysisRunner"];
  readonly migrationOverrides?: Partial<Record<"recover" | "finalize" | "rollback" | "close", () => Promise<unknown>>>;
}

interface RuntimePaths {
  readonly sqlitePath: string;
  readonly lanceDirectory: string;
}

interface Harness {
  readonly mod: typeof import("../applicationRuntime.js");
  readonly storage: typeof import("../storageRuntime.js");
  readonly settings: typeof import("../runtimeSettings.js");
  readonly runnerMod: typeof import("../automationRunner.js");
  readonly analysisRunnerMod: typeof import("../analysisRunner.js");
  readonly workspace: string;
  readonly events: string[];
  readonly openCalls: StorageRuntimeOptions[];
  paths(name: string): Promise<RuntimePaths>;
  seams(tag: string, options?: SeamOptions): ApplicationRuntimeLifecycle;
}

const harnesses: Harness[] = [];

async function newHarness(): Promise<Harness> {
  vi.resetModules();
  const [mod, storage, settings, runnerMod, analysisRunnerMod] = await Promise.all([
    import("../applicationRuntime.js"),
    import("../storageRuntime.js"),
    import("../runtimeSettings.js"),
    import("../automationRunner.js"),
    import("../analysisRunner.js"),
  ]);
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-app-runtime-")));
  const harness: Harness = {
    mod,
    storage,
    settings,
    runnerMod,
    analysisRunnerMod,
    workspace,
    events: [],
    openCalls: [],
    async paths(name) {
      const directory = path.join(workspace, name);
      await fs.mkdir(directory, { recursive: true });
      return {
        sqlitePath: path.join(directory, `${name}.sqlite`),
        lanceDirectory: path.join(directory, "lancedb"),
      };
    },
    seams(tag, options = {}) {
      const events = harness.events;
      let sequence = 0;
      const settingsGate = options.settingsGate;
      return {
        async beginDownloadLifecycle() {
          events.push(`${tag}:download-begin`);
        },
        quiesceAndDrainDownloads() {
          events.push(`${tag}:download-quiesce`);
          return options.downloadDrain ? options.downloadDrain() : Promise.resolve();
        },
        async initializeSettings() {
          events.push(`${tag}:settings-init`);
          if (settingsGate) await settingsGate.promise;
          if (options.settingsReject) throw options.settingsReject;
          await harness.settings.initializeRuntimeSettings({
            settingsFile: path.join(harness.workspace, `${tag}-settings.json`),
            env: {},
          });
        },
        closeSettings() {
          events.push(`${tag}:settings-close`);
          if (options.closeSettings) {
            options.closeSettings();
            return;
          }
          harness.settings.closeRuntimeSettings();
        },
        readSettings: () => harness.settings.getRuntimeSettings(),
        makeMigration() {
          sequence += 1;
          return new FakeMigration(`${tag}:migration-${sequence}`, events, options.migrationOverrides);
        },
        async openStorage(init) {
          events.push(`${tag}:storage-open`);
          harness.openCalls.push(init);
          if (options.openStorage) return options.openStorage(init);
          return harness.storage.initializeStorageRuntime(init);
        },
        async closeStorage() {
          events.push(`${tag}:storage-close`);
          if (options.closeStorage) {
            await options.closeStorage();
            return;
          }
          await harness.storage.closeStorageRuntime();
        },
        async stopEngine() {
          events.push(`${tag}:engine-stop`);
          if (options.engineStop) await options.engineStop();
        },
        createRunner:
          options.createRunner ??
          ((deps) => {
            events.push(`${tag}:runner-created`);
            return harness.runnerMod.createAutomationRunner(deps);
          }),
        createAnalysisRunner:
          options.createAnalysisRunner ?? ((deps) => harness.analysisRunnerMod.createAnalysisRunner(deps)),
      };
    },
  };
  harnesses.push(harness);
  return harness;
}

async function cleanClose(runtime: ApplicationRuntime): Promise<void> {
  await runtime.close({ externalStorageConsumersDrained: true });
}

function ownedEvents(harness: Harness, tag: string): string[] {
  return harness.events.filter((event) => event.startsWith(`${tag}:`));
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.settings.closeRuntimeSettings();
    } catch {
      // Best effort between cases.
    }
    try {
      await harness.storage.closeStorageRuntime();
    } catch {
      // Best effort between cases.
    }
    await fs.rm(harness.workspace, { recursive: true, force: true });
  }
});

describe("application runtime ownership", () => {
  it("rejects an overlapping factory before touching any of its seams, and releases after the first owner closes", async () => {
    const h = await newHarness();
    const pathsA = await h.paths("a1");
    const pathsB = await h.paths("b1");
    const gateA = deferred();
    const seamsA = h.seams("A", { settingsGate: gateA });
    const seamsB = h.seams("B");

    const runtimeA = h.mod.createApplicationRuntime({
      lifecycle: seamsA,
      syncConnector: async () => undefined,
      ...pathsA,
    });
    await flush();
    // A holds the lease mid-construction (waiting inside settings init).
    expect(h.events).toContain("A:download-begin");
    expect(h.events).toContain("A:settings-init");

    const overlap = await h.mod
      .createApplicationRuntime({ lifecycle: seamsB, syncConnector: async () => undefined, ...pathsB })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(overlap).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
    expect((overlap as ApplicationRuntimeLifecycleError).leaseRetained).toBe(false);
    // Zero side effects for the rejected attempt.
    expect(ownedEvents(h, "B")).toEqual([]);

    gateA.resolve();
    const runtime = await runtimeA;
    expect(h.events).toContain("A:runner-created");
    await cleanClose(runtime);

    // The lease released cleanly: the second factory now runs its own seams.
    const runtimeB = await h.mod.createApplicationRuntime({
      lifecycle: seamsB,
      syncConnector: async () => undefined,
      ...pathsB,
    });
    expect(ownedEvents(h, "B").length).toBeGreaterThan(0);
    await cleanClose(runtimeB);
    expect(h.events).toContain("B:storage-open");
    expect(h.events).toContain("B:storage-close");
  });

  it("rejects an overlapping factory after the owner is active without disturbing it", async () => {
    const h = await newHarness();
    const pathsA = await h.paths("a2");
    const pathsB = await h.paths("b2");
    const runtimeA = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("A"),
      syncConnector: async () => undefined,
      ...pathsA,
    });

    const overlap = await h.mod
      .createApplicationRuntime({ lifecycle: h.seams("B"), syncConnector: async () => undefined, ...pathsB })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(overlap).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
    expect(ownedEvents(h, "B")).toEqual([]);

    // A remains usable and untouched.
    const chatId = await insertChat(runtimeA.storage.ledger, ACCOUNT);
    const automation = await runtimeA.storage.automations.create({
      accountId: ACCOUNT,
      name: "Nightly digest",
      kind: "agent_turn",
      targetId: chatId,
      prompt: "summarize",
      scheduleMinutes: 15,
    });
    expect(await runtimeA.storage.automations.get(ACCOUNT, automation.id)).toBeDefined();
    expect(h.events).not.toContain("A:storage-close");
    expect(h.events).not.toContain("A:settings-close");

    await cleanClose(runtimeA);
  });

  it("builds exactly one runner over the runtime's own automations store", async () => {
    const h = await newHarness();
    const paths = await h.paths("t3");
    let capturedStore: unknown;
    const runtime = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("A", {
        createRunner: (deps) => {
          capturedStore = deps.store;
          return h.runnerMod.createAutomationRunner(deps);
        },
      }),
      syncConnector: async () => undefined,
      ...paths,
    });
    // The runner's store is the exact store facade owned by this storage.
    expect(capturedStore).toBe(runtime.storage.automations);
    // The runner drives that ledger; state created through the runtime is
    // visible to the same store facade the runner holds.
    await runtime.runner.tick();
    const chatId = await insertChat(runtime.storage.ledger, ACCOUNT);
    const automation = await runtime.storage.automations.create({
      accountId: ACCOUNT,
      name: "Ledger check",
      kind: "agent_turn",
      targetId: chatId,
      prompt: "tick",
      scheduleMinutes: 15,
    });
    expect(runtime.runner.isRunning()).toBe(false);
    expect(await runtime.storage.automations.get(ACCOUNT, automation.id)).toBeDefined();
    await cleanClose(runtime);
  });

  it("starts and stops its runner with plan 013's synchronous-quiesce contract", async () => {
    const h = await newHarness();
    const paths = await h.paths("t4");
    const runtime = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("A"),
      syncConnector: async () => undefined,
      ...paths,
    });
    runtime.startAutomationScheduler();
    expect(runtime.runner.isRunning()).toBe(true);

    const drain = runtime.stopAutomationScheduler();
    // Synchronous quiescence: the interval is gone before the first await.
    expect(runtime.runner.isRunning()).toBe(false);
    await drain;
    await cleanClose(runtime);
    expect(runtime.runner.isRunning()).toBe(false);
  });

  it("joins an active deferred download drain before closing settings, storage, or the lease", async () => {
    const h = await newHarness();
    const paths = await h.paths("t5");
    const held = deferred();
    let quiesced = false;
    const runtime = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("A", {
        downloadDrain: () => {
          quiesced = true;
          return held.promise;
        },
      }),
      syncConnector: async () => undefined,
      ...paths,
    });

    const closing = runtime.close({ externalStorageConsumersDrained: true });
    // Admission closed immediately, but nothing closed beneath it.
    expect(quiesced).toBe(true);
    expect(await isPending(closing)).toBe(true);
    expect(h.events).not.toContain("A:storage-close");
    expect(h.events).not.toContain("A:settings-close");

    // A new owner cannot start while the drain is in flight.
    const overlap = await h.mod
      .createApplicationRuntime({
        lifecycle: h.seams("B"),
        syncConnector: async () => undefined,
        ...(await h.paths("b5")),
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(overlap).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);

    held.resolve();
    await closing;
    expect(h.events).toContain("A:storage-close");
    expect(h.events).toContain("A:settings-close");
  });

  it("joins one close across repeated calls and closes exactly once", async () => {
    const h = await newHarness();
    const paths = await h.paths("t6");
    const held = deferred();
    const runtime = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("A", { downloadDrain: () => held.promise }),
      syncConnector: async () => undefined,
      ...paths,
    });

    const first = runtime.close({ externalStorageConsumersDrained: true });
    const second = runtime.close({ externalStorageConsumersDrained: true });
    held.resolve();
    await Promise.all([first, second]);

    expect(h.events.filter((event) => event === "A:storage-close")).toHaveLength(1);
    expect(h.events.filter((event) => event === "A:settings-close")).toHaveLength(1);
    expect(h.events.filter((event) => event === "A:download-quiesce")).toHaveLength(1);

    // A repeat after full closure performs no new work.
    await runtime.close({ externalStorageConsumersDrained: true });
    expect(h.events.filter((event) => event === "A:storage-close")).toHaveLength(1);
    expect(h.events.filter((event) => event === "A:download-quiesce")).toHaveLength(1);
  });

  it("restarts sequentially at a different path with a fresh lifecycle and its own automation state", async () => {
    const h = await newHarness();
    const pathsA = await h.paths("a7");
    const pathsB = await h.paths("b7");
    const runtimeA = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("A"),
      syncConnector: async () => undefined,
      ...pathsA,
    });
    const chatA = await insertChat(runtimeA.storage.ledger, ACCOUNT);
    const automationA = await runtimeA.storage.automations.create({
      accountId: ACCOUNT,
      name: "A automation",
      kind: "agent_turn",
      targetId: chatA,
      prompt: "a",
      scheduleMinutes: 15,
    });
    const aLedger = runtimeA.storage.ledger;
    const aLance = runtimeA.storage.lanceDirectory;
    await cleanClose(runtimeA);

    const runtimeB = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("B"),
      syncConnector: async () => undefined,
      ...pathsB,
    });
    // A fresh download lifecycle began only after A's drain settled and its
    // stores closed.
    const quiesceIndex = h.events.indexOf("A:download-quiesce");
    const beginBIndex = h.events.indexOf("B:download-begin");
    expect(quiesceIndex).toBeGreaterThanOrEqual(0);
    expect(beginBIndex).toBeGreaterThan(quiesceIndex);
    expect(beginBIndex).toBeGreaterThan(h.events.indexOf("A:storage-close"));

    const chatB = await insertChat(runtimeB.storage.ledger, ACCOUNT);
    const automationB = await runtimeB.storage.automations.create({
      accountId: ACCOUNT,
      name: "B automation",
      kind: "agent_turn",
      targetId: chatB,
      prompt: "b",
      scheduleMinutes: 15,
    });
    expect(await runtimeB.storage.automations.get(ACCOUNT, automationB.id)).toBeDefined();
    // B's ledger is distinct, A's closed ledger cannot be written, and A's
    // automation is invisible to B's fresh ledger.
    expect(runtimeB.storage.ledger).not.toBe(aLedger);
    expect(runtimeB.storage.lanceDirectory).not.toBe(aLance);
    await expect(
      aLedger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [ACCOUNT, "x@y.z", "h"])
    ).rejects.toThrow();
    expect(await runtimeB.storage.automations.get(ACCOUNT, automationA.id)).toBeUndefined();

    await cleanClose(runtimeB);
  });

  it("cannot let a stale closed owner close or release a later runtime", async () => {
    const h = await newHarness();
    const pathsA = await h.paths("a8");
    const pathsB = await h.paths("b8");
    const runtimeA = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("A"),
      syncConnector: async () => undefined,
      ...pathsA,
    });
    await cleanClose(runtimeA);

    const runtimeB = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("B"),
      syncConnector: async () => undefined,
      ...pathsB,
    });
    const eventsBefore = h.events.length;

    // A stale close on the already-closed owner performs no new work: it
    // cannot stop B's download, close B, or touch B's lease.
    await runtimeA.close({ externalStorageConsumersDrained: true });
    expect(h.events.slice(eventsBefore)).toEqual([]);

    await runtimeB.close({ externalStorageConsumersDrained: true });
    expect(h.events).toContain("B:storage-close");
  });

  it("releases its token after a runner-construction failure whose unwind fully proves closure", async () => {
    const h = await newHarness();
    const paths = await h.paths("t9");
    const seams = h.seams("A", {
      createRunner: () => {
        throw new Error("simulated runner construction failure");
      },
    });
    const failure = await h.mod
      .createApplicationRuntime({ lifecycle: seams, syncConnector: async () => undefined, ...paths })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect((failure as Error).message).toBe("simulated runner construction failure");

    // The unwind drained only what this token began/acquired.
    expect(h.events).toContain("A:download-quiesce");
    expect(h.events).toContain("A:migration-1:close");
    expect(h.events).toContain("A:storage-close");
    expect(h.events).toContain("A:settings-close");
    expect(h.events).not.toContain("A:engine-stop");

    // The lease released: a later factory constructs cleanly on the same path.
    const later = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("later"),
      syncConnector: async () => undefined,
      ...paths,
    });
    await cleanClose(later);
    expect(h.events).toContain("later:runner-created");
  });

  it("poisons when a construction failure's unwind cannot prove closure", async () => {
    const h = await newHarness();
    const paths = await h.paths("t11");
    const seams = h.seams("A", {
      createRunner: () => {
        throw new Error("simulated runner construction failure");
      },
      closeStorage: async () => {
        throw new Error("simulated storage close failure");
      },
    });
    const failure = await h.mod
      .createApplicationRuntime({ lifecycle: seams, syncConnector: async () => undefined, ...paths })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
    expect((failure as ApplicationRuntimeLifecycleError).leaseRetained).toBe(true);
    expect((failure as ApplicationRuntimeLifecycleError).cause).toBeInstanceOf(Error);

    // With the lease poisoned, a later factory fails before any seam runs.
    const seamsB = h.seams("B");
    const blocked = await h.mod
      .createApplicationRuntime({ lifecycle: seamsB, syncConnector: async () => undefined, ...(await h.paths("b11")) })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(blocked).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
    expect(ownedEvents(h, "B")).toEqual([]);
  });

  it("treats an opaque storage-initialization rejection as uncertain acquisition and poisons", async () => {
    const h = await newHarness();
    const paths = await h.paths("t12a");
    const simulated = new Error("simulated storage initialization failure");
    const seams = h.seams("A", {
      openStorage: async (init) => {
        // Open the real stores, then reject the way an initializer can: after
        // native open work, with no typed no-acquisition proof.
        await h.storage.initializeStorageRuntime(init);
        throw simulated;
      },
    });
    const failure = await h.mod
      .createApplicationRuntime({ lifecycle: seams, syncConnector: async () => undefined, ...paths })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
    expect((failure as ApplicationRuntimeLifecycleError).leaseRetained).toBe(true);
    // Independent safe cleanup was attempted: the begun download lifecycle
    // drained, settings released, and a best-effort storage close ran over
    // the possibly-open stores.
    expect(h.events).toContain("A:download-quiesce");
    expect(h.events).toContain("A:storage-close");
    expect(h.events).toContain("A:settings-close");

    const seamsB = h.seams("B");
    const blocked = await h.mod
      .createApplicationRuntime({ lifecycle: seamsB, syncConnector: async () => undefined, ...(await h.paths("b12a")) })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(blocked).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
    expect(ownedEvents(h, "B")).toEqual([]);
  });

  it("treats an opaque settings-initialization rejection as uncertain acquisition and poisons", async () => {
    const h = await newHarness();
    const paths = await h.paths("t12b");
    const seams = h.seams("A", { settingsReject: new Error("simulated settings initialization failure") });
    const failure = await h.mod
      .createApplicationRuntime({ lifecycle: seams, syncConnector: async () => undefined, ...paths })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
    expect((failure as ApplicationRuntimeLifecycleError).leaseRetained).toBe(true);
    // Only the begun download lifecycle and the settings seam are attempted;
    // migration/storage were never constructed.
    expect(h.events).toContain("A:download-quiesce");
    expect(h.events).toContain("A:settings-close");
    expect(h.events).not.toContain("A:storage-open");
    expect(h.events).not.toContain("A:migration-1:close");

    const blocked = await h.mod
      .createApplicationRuntime({
        lifecycle: h.seams("B"),
        syncConnector: async () => undefined,
        ...(await h.paths("b12b")),
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(blocked).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
    expect(ownedEvents(h, "B")).toEqual([]);
  });

  it("orders Plan 035 startup around its owned coordinator and never inherits a prior one", async () => {
    const h = await newHarness();
    const pathsA = await h.paths("m13a");
    const runtimeA = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("A"),
      syncConnector: async () => undefined,
      ...pathsA,
    });
    const events = h.events;
    const indexOf = (event: string) => {
      const index = events.indexOf(event);
      expect(index, event).toBeGreaterThanOrEqual(0);
      return index;
    };
    // Download lifecycle before resource construction; settings before the
    // store; recovery strictly before the store open; finalization after it.
    expect(indexOf("A:download-begin")).toBeLessThan(indexOf("A:settings-init"));
    expect(indexOf("A:settings-init")).toBeLessThan(indexOf("A:migration-1:recover"));
    expect(indexOf("A:migration-1:recover")).toBeLessThan(indexOf("A:storage-open"));
    expect(indexOf("A:storage-open")).toBeLessThan(indexOf("A:migration-1:finalize"));

    // The open carried the resolved embedding identity — marker/receipt/
    // model/dimension validation happens inside the real store open.
    const open = h.openCalls[0]!;
    const snapshot = await h.settings.getRuntimeSettings();
    expect(open.embeddingDimension).toBe(snapshot.settings.embeddingDimension);
    expect(open.embeddingModel).toBe(snapshot.settings.embedModel);
    expect(typeof open.allowLegacyEmbeddingIdentityAdoption).toBe("boolean");
    const marker = JSON.parse(
      await fs.readFile(path.join(pathsA.lanceDirectory, ".borealis-embedding-index.json"), "utf8")
    ) as { dimension?: unknown };
    expect(marker.dimension).toBe(snapshot.settings.embeddingDimension);

    await cleanClose(runtimeA);
    // The coordinator closed inside runtime close, before the paired store.
    expect(indexOf("A:migration-1:close")).toBeGreaterThan(indexOf("A:migration-1:finalize"));
    expect(indexOf("A:storage-close")).toBeGreaterThan(indexOf("A:migration-1:close"));

    // A later runtime constructs a fresh coordinator, never A's instance.
    const pathsB = await h.paths("m13b");
    const runtimeB = await h.mod.createApplicationRuntime({
      lifecycle: h.seams("A2"),
      syncConnector: async () => undefined,
      ...pathsB,
    });
    expect(h.events).toContain("A2:migration-1:recover");
    expect(indexOf("A2:migration-1:recover")).toBeGreaterThan(indexOf("A:migration-1:close"));
    expect(h.events.filter((event) => event === "A:migration-1:close")).toHaveLength(1);
    await cleanClose(runtimeB);
  });

  it("routes an open failure through the coordinator rollback before the retry", async () => {
    const h = await newHarness();
    const paths = await h.paths("t13rollback");
    let openAttempt = 0;
    const seams = h.seams("R", {
      openStorage: async (init) => {
        openAttempt += 1;
        const opened = await h.storage.initializeStorageRuntime(init);
        if (openAttempt === 1) throw new Error("simulated first open failure");
        return opened;
      },
    });
    const label = "R-migration-1";
    const runtime = await h.mod.createApplicationRuntime({
      lifecycle: {
        ...seams,
        makeMigration: () => ({
          async recoverBeforeStorageOpen() {
            h.events.push(`${label}:recover`);
          },
          async finalizeAfterStorageOpen() {
            h.events.push(`${label}:finalize`);
          },
          async rollbackStartupFailure() {
            h.events.push(`${label}:rollback`);
            // The rollback must answer positively for the retry to proceed.
            return true;
          },
          async close() {
            h.events.push(`${label}:close`);
          },
        }),
      },
      syncConnector: async () => undefined,
      ...paths,
    });
    const events = h.events;
    const openIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === "R:storage-open")
      .map(({ index }) => index);
    expect(openIndexes).toHaveLength(2);
    expect(events.indexOf(`${label}:recover`)).toBeLessThan(openIndexes[0]!);
    expect(events.indexOf(`${label}:rollback`)).toBeGreaterThan(openIndexes[0]!);
    expect(events.indexOf(`${label}:rollback`)).toBeLessThan(openIndexes[1]!);
    // The rolled-back first identity is not finalized: the smoke belongs to a
    // completed new identity, not the reopened old one.
    expect(events).not.toContain(`${label}:finalize`);
    await cleanClose(runtime);
  });
});

describe("application runtime close failure injection", () => {
  interface Case {
    readonly label: string;
    readonly seams?: SeamOptions;
    readonly proof?: boolean;
    readonly expectSkipped: boolean;
  }

  const cases: Case[] = [
    {
      label: "scheduler drain rejects",
      seams: {
        createRunner: () => ({
          start: () => undefined,
          stop: () => Promise.reject(new Error("simulated runner stop failure")),
          tick: async () => undefined,
          isRunning: () => false,
        }),
      },
      expectSkipped: true,
    },
    {
      label: "download drain rejects",
      seams: { downloadDrain: () => Promise.reject(new Error("simulated download drain failure")) },
      expectSkipped: true,
    },
    {
      label: "migration close rejects",
      seams: { migrationOverrides: { close: () => Promise.reject(new Error("simulated migration close failure")) } },
      expectSkipped: true,
    },
    {
      label: "engine stop rejects",
      seams: { engineStop: () => Promise.reject(new Error("simulated engine stop failure")) },
      expectSkipped: true,
    },
    {
      label: "storage close rejects",
      seams: { closeStorage: () => Promise.reject(new Error("simulated storage close failure")) },
      expectSkipped: false,
    },
    {
      label: "settings close rejects",
      seams: {
        closeSettings: () => {
          throw new Error("simulated settings close failure");
        },
      },
      expectSkipped: false,
    },
    { label: "external proof is false", proof: false, expectSkipped: true },
  ];

  for (const testCase of cases) {
    it(`${testCase.label}: close attempts independent phases, skips prereqs when unsafe, poisons, and blocks later factories`, async () => {
      const h = await newHarness();
      const paths = await h.paths("case");
      const seamsA = h.seams("A", testCase.seams);
      const runtime = await h.mod.createApplicationRuntime({
        lifecycle: seamsA,
        syncConnector: async () => undefined,
        ...paths,
      });

      const failure = await runtime.close({ externalStorageConsumersDrained: testCase.proof ?? true }).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
      expect((failure as ApplicationRuntimeLifecycleError).leaseRetained).toBe(true);

      // All independent owned drains were attempted even when a peer
      // rejected.
      expect(h.events).toContain("A:download-quiesce");
      expect(h.events).toContain("A:migration-1:close");
      expect(h.events).toContain("A:engine-stop");

      if (testCase.expectSkipped) {
        // Prerequisite-owned settings/storage closure stays deliberately
        // skipped and therefore still owned.
        expect(h.events).not.toContain("A:storage-close");
        expect(h.events).not.toContain("A:settings-close");
      } else {
        // Level-B peers are still attempted around the injected failure.
        expect(h.events).toContain("A:settings-close");
        expect(h.events).toContain("A:storage-close");
      }

      // The rejection is cached and stable across repeats.
      const repeat = await runtime.close({ externalStorageConsumersDrained: true }).then(
        () => null,
        (error: unknown) => error
      );
      expect(repeat).toBe(failure);

      // Poisoned ownership blocks every later factory before side effects.
      const seamsB = h.seams("B");
      const blocked = await h.mod
        .createApplicationRuntime({
          lifecycle: seamsB,
          syncConnector: async () => undefined,
          ...(await h.paths(`case-b-${cases.indexOf(testCase)}`)),
        })
        .then(
          () => null,
          (error: unknown) => error
        );
      expect(blocked).toBeInstanceOf(h.mod.ApplicationRuntimeLifecycleError);
      expect(ownedEvents(h, "B")).toEqual([]);
    });
  }
});
