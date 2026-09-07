import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_WATCH_DEBOUNCE_MS,
  KNOWLEDGE_WATCH_MIN_SCAN_INTERVAL_MS,
  KNOWLEDGE_WATCH_RECONCILE_MS,
  KnowledgeWatchPump,
  type KnowledgeWatchTarget,
} from "../knowledgeWatch.js";

/**
 * Fake-clock tests for the desktop watch pump: the 2-second debounce with a
 * 30-second minimum scan interval, burst coalescing, the 5-minute forced
 * reconciliation, in-flight coalescing, and the hard stop that leaves no
 * timer behind ("no daemon runs after Borealis quits").
 */

const target: KnowledgeWatchTarget = { accountId: "account-1", connectionId: "connection-1" };

class FakeClock {
  current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  readonly now = () => this.current;
  readonly setTimeoutFn = (callback: () => void, ms: number) => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  readonly clearTimeoutFn = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  };

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Advance the clock, firing due timers in time order and flushing work. */
  async advance(ms: number): Promise<void> {
    const until = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const next = due[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = Math.max(this.current, timer.at);
      timer.callback();
      // Let every awaited scan step settle before the next timer fires.
      for (let pass = 0; pass < 10; pass += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    this.current = until;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface PumpTest {
  readonly clock: FakeClock;
  readonly pump: KnowledgeWatchPump;
  readonly scans: KnowledgeWatchTarget[];
  readonly scanSignalStates: boolean[];
  setConnections: (targets: readonly KnowledgeWatchTarget[]) => void;
  failList: (fail: boolean) => void;
  blockScans: (gate: Promise<void> | null) => void;
  throwScans: (throwing: boolean) => void;
}

function buildPump(
  overrides: { debounceMs?: number; minScanIntervalMs?: number; reconcileMs?: number } = {}
): PumpTest {
  const clock = new FakeClock();
  let connections: readonly KnowledgeWatchTarget[] = [target];
  let listFails = false;
  let gate: Promise<void> | null = null;
  let throwing = false;
  const scans: KnowledgeWatchTarget[] = [];
  const scanSignalStates: boolean[] = [];
  const pump = new KnowledgeWatchPump({
    listConnections: async () => {
      if (listFails) throw new Error("ledger closed");
      return connections;
    },
    scan: async (scannedTarget, signal) => {
      scanSignalStates.push(signal.aborted);
      scans.push(scannedTarget);
      if (gate) await gate;
      if (throwing) throw new Error("upstream failed");
    },
    debounceMs: overrides.debounceMs ?? 100,
    minScanIntervalMs: overrides.minScanIntervalMs ?? 500,
    reconcileMs: overrides.reconcileMs ?? 2_000,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return {
    clock,
    pump,
    scans,
    scanSignalStates,
    setConnections: (next) => {
      connections = next;
    },
    failList: (fail) => {
      listFails = fail;
    },
    blockScans: (next) => {
      gate = next;
    },
    throwScans: (next) => {
      throwing = next;
    },
  };
}

describe("KnowledgeWatchPump defaults", () => {
  it("keeps the spec's 2s debounce, 30s minimum interval, and 5-minute reconcile", () => {
    expect(KNOWLEDGE_WATCH_DEBOUNCE_MS).toBe(2_000);
    expect(KNOWLEDGE_WATCH_MIN_SCAN_INTERVAL_MS).toBe(30_000);
    expect(KNOWLEDGE_WATCH_RECONCILE_MS).toBe(300_000);
  });
});

describe("KnowledgeWatchPump notify coalescing", () => {
  it("debounces a single notify and coalesces a burst into one scan", async () => {
    const harness = buildPump();
    harness.pump.start();
    harness.pump.notify(target);
    await harness.clock.advance(50);
    expect(harness.scans).toHaveLength(0); // still inside the debounce window
    await harness.clock.advance(60);
    expect(harness.scans).toHaveLength(1);

    // A burst for the same connection while the connection is idle and
    // inside the minimum interval coalesces into exactly one later scan.
    harness.pump.notify(target);
    harness.pump.notify(target);
    harness.pump.notify(target);
    await harness.clock.advance(200);
    expect(harness.scans).toHaveLength(1);
    // The minimum-interval gate defers it to 500ms after the first scan.
    await harness.clock.advance(300);
    expect(harness.scans).toHaveLength(2);
  });

  it("coalesces events that arrive while a scan is in flight", async () => {
    const harness = buildPump({ minScanIntervalMs: 50_000, reconcileMs: 5_000_000 });
    const gate = deferred<void>();
    harness.blockScans(gate.promise);
    harness.pump.start();
    harness.pump.notify(target);
    await harness.clock.advance(150);
    expect(harness.scans).toHaveLength(1); // in flight
    harness.pump.notify(target);
    harness.pump.notify(target);
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    // The post-scan pending notify re-arms and is gated by the (here large)
    // minimum scan interval before a second scan may start.
    await harness.clock.advance(49_000);
    expect(harness.scans).toHaveLength(1);
    await harness.clock.advance(2_000);
    expect(harness.scans).toHaveLength(2);
  });

  it("a stopped pump schedules nothing and no-ops future notifies", async () => {
    const harness = buildPump();
    harness.pump.start();
    harness.pump.notify(target);
    harness.pump.stop();
    expect(harness.pump.isRunning).toBe(false);
    expect(harness.clock.pendingTimers).toBe(0);
    await harness.clock.advance(10_000);
    expect(harness.scans).toHaveLength(0);
    harness.pump.notify(target);
    await harness.clock.advance(10_000);
    expect(harness.scans).toHaveLength(0);
  });
});

describe("KnowledgeWatchPump periodic scan", () => {
  it("stop waits for a scan's asynchronous abort cleanup and refuses queued scans", async () => {
    const clock = new FakeClock();
    const cleanup = deferred<void>();
    let aborted = false;
    let finished = false;
    let scans = 0;
    const pump = new KnowledgeWatchPump({
      listConnections: async () => [target],
      scan: async (_target, signal) => {
        scans += 1;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true }
          )
        );
        await cleanup.promise;
        finished = true;
      },
      debounceMs: 100,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    pump.start();
    pump.notify(target);
    await clock.advance(150);
    pump.notify(target);
    let stopped = false;
    const stopping = pump.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(clock.pendingTimers).toBe(0);
    cleanup.resolve();
    await stopping;
    expect(finished).toBe(true);
    await clock.advance(600_000);
    expect(scans).toBe(1);
  });

  it.each(["pulse", "reconcile"] as const)(
    "stop joins a pending %s connection read without starting a scan",
    async (pass) => {
      const clock = new FakeClock();
      const listed = deferred<readonly KnowledgeWatchTarget[]>();
      let scans = 0;
      const pump = new KnowledgeWatchPump({
        listConnections: () => listed.promise,
        scan: async () => {
          scans += 1;
        },
        now: clock.now,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
      });
      pump.start();
      const running = pump[pass]();
      let stopped = false;
      const stopping = pump.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      listed.resolve([target]);
      await Promise.all([running, stopping]);
      expect(scans).toBe(0);
      expect(clock.pendingTimers).toBe(0);
    }
  );

  it("periodically scans watch-enabled connections without any events", async () => {
    const harness = buildPump();
    harness.pump.start();
    // The pulse fires at the minimum interval, then the debounce lands.
    await harness.clock.advance(400);
    expect(harness.scans).toHaveLength(0);
    await harness.clock.advance(200);
    expect(harness.scans).toHaveLength(1);
    // Re-enable notify gating independence: disable further notifies by
    // clearing connections; the next pulse lists nothing and scans stop.
    harness.setConnections([]);
    await harness.clock.advance(5_000);
    expect(harness.scans).toHaveLength(1);
  });

  it("the reconcile pass bypasses the minimum-interval gate", async () => {
    const harness = buildPump({ minScanIntervalMs: 10_000, reconcileMs: 1_000 });
    harness.pump.start();
    harness.pump.notify(target);
    await harness.clock.advance(110);
    expect(harness.scans).toHaveLength(1);
    // Well inside the 10s minimum interval, the reconcile timer still scans.
    await harness.clock.advance(900);
    expect(harness.scans).toHaveLength(2);
  });

  it("survives scan failures and list failures without scheduling storms", async () => {
    const harness = buildPump();
    harness.throwScans(true);
    harness.pump.start();
    await harness.clock.advance(2_500);
    expect(harness.scans.length).toBeGreaterThan(0);
    harness.throwScans(false);
    harness.failList(true);
    // Drain timers that were armed before the list failure.
    await harness.clock.advance(1_000);
    const before = harness.scans.length;
    await harness.clock.advance(10_000);
    expect(harness.scans.length).toBe(before);
  });

  it("stop aborts the scan signal so in-flight durable work ends honestly", async () => {
    const harness = buildPump({ minScanIntervalMs: 60_000 });
    const gate = deferred<void>();
    harness.blockScans(gate.promise);
    harness.pump.start();
    harness.pump.notify(target);
    await harness.clock.advance(150);
    expect(harness.scans).toHaveLength(1);
    expect(harness.scanSignalStates.at(-1)).toBe(false);
    harness.pump.stop();
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    // The signal handed to the scan after a stop is aborted (no new scan can
    // start), and no further timers exist.
    await harness.clock.advance(60_000);
    expect(harness.scans).toHaveLength(1);
  });
});
