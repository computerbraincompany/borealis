/**
 * Desktop-only knowledge watch pump (M14 stage 4).
 *
 * The spec's desktop watch is opt-in, off by default, debounce 2 seconds with
 * a 30-second minimum scan interval and a 5-minute full reconciliation while
 * the app runs. This module is deliberately small timing logic with every
 * external effect injected:
 *
 * - `listConnections` resolves the currently watch-enabled connections each
 *   pass (enabling or disabling `watch_enabled` therefore takes effect on the
 *   next pass; persisting and reconciling it on restart is the store's job);
 * - `scan` performs one durable scheduled refresh for one connection and must
 *   be failure-tolerant (it records its own bounded status evidence);
 * - the clock is injected so tests drive the debounce/interval/reconcile
 *   contract deterministically.
 *
 * Repeated `notify` events for one connection coalesce into a single pending
 * scan (the spec's coalescing rule); a scan never starts more often than the
 * minimum interval, the reconcile pass bypasses the interval gate, and
 * `stop()` clears every timer and drains in-flight passes and scans. Timers
 * default to unref'd handles so a running pump can never hold the process.
 */

export const KNOWLEDGE_WATCH_DEBOUNCE_MS = 2_000;
export const KNOWLEDGE_WATCH_MIN_SCAN_INTERVAL_MS = 30_000;
export const KNOWLEDGE_WATCH_RECONCILE_MS = 5 * 60_000;

export interface KnowledgeWatchTarget {
  readonly accountId: string;
  readonly connectionId: string;
}

export type KnowledgeWatchTimer = () => void;

export interface KnowledgeWatchPumpOptions {
  readonly listConnections: () => Promise<readonly KnowledgeWatchTarget[]>;
  readonly scan: (target: KnowledgeWatchTarget, signal: AbortSignal) => Promise<void>;
  readonly debounceMs?: number;
  readonly minScanIntervalMs?: number;
  readonly reconcileMs?: number;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  readonly now?: () => number;
  readonly setTimeoutFn?: (callback: KnowledgeWatchTimer, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
}

function defaultSetTimeout(callback: KnowledgeWatchTimer, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return timer;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} is invalid`);
  return resolved;
}

const targetKey = (target: KnowledgeWatchTarget): string => `${target.accountId}|${target.connectionId}`;

export class KnowledgeWatchPump {
  private readonly debounceMs: number;
  private readonly minScanIntervalMs: number;
  private readonly reconcileMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (callback: KnowledgeWatchTimer, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => void;

  private started = false;
  private controller: AbortController | undefined;
  /** Coalesced pending scan per connection: at most one timer per key. */
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scanning = new Set<string>();
  private readonly pendingAfterScan = new Set<string>();
  private readonly lastScanAt = new Map<string, number>();
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private pulseTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcilePassRunning = false;
  private readonly work = new Set<Promise<void>>();
  private stopping: Promise<void> | undefined;

  constructor(private readonly options: KnowledgeWatchPumpOptions) {
    this.debounceMs = positiveInteger(options.debounceMs, KNOWLEDGE_WATCH_DEBOUNCE_MS, "debounceMs");
    this.minScanIntervalMs = positiveInteger(
      options.minScanIntervalMs,
      KNOWLEDGE_WATCH_MIN_SCAN_INTERVAL_MS,
      "minScanIntervalMs"
    );
    this.reconcileMs = positiveInteger(options.reconcileMs, KNOWLEDGE_WATCH_RECONCILE_MS, "reconcileMs");
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? defaultSetTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
  }

  get isRunning(): boolean {
    return this.started;
  }

  /** Idempotent start: schedules the periodic pulse and reconcile loop. */
  start(): void {
    if (this.started) return;
    if (this.stopping) throw new Error("knowledge watch pump is stopping");
    this.started = true;
    this.controller = new AbortController();
    this.scheduleReconcile();
    // The periodic pulse realizes "a backend periodic scan" for watch-enabled
    // connections without a filesystem event source: every min-interval tick
    // notifies every watch connection, and the per-connection gate coalesces.
    this.schedulePulse();
  }

  /** Abort immediately; await transport/status finalizers before closing stores. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.started = false;
    for (const timer of this.pendingTimers.values()) this.clearTimeoutFn(timer);
    this.pendingTimers.clear();
    this.pendingAfterScan.clear();
    if (this.reconcileTimer) this.clearTimeoutFn(this.reconcileTimer);
    this.reconcileTimer = undefined;
    if (this.pulseTimer) this.clearTimeoutFn(this.pulseTimer);
    this.pulseTimer = undefined;
    this.controller?.abort(new Error("knowledge watch pump stopped"));
    this.controller = undefined;
    this.stopping = Promise.allSettled([...this.work]).then(() => {
      this.scanning.clear();
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private track(work: Promise<void>): Promise<void> {
    this.work.add(work);
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work)
    );
    return work;
  }

  /**
   * One upstream-change event for a connection. Bursts coalesce into the
   * single pending debounced scan, which additionally respects the minimum
   * scan interval. No-op for a stopped pump.
   */
  notify(target: KnowledgeWatchTarget): void {
    if (!this.started) return;
    const key = targetKey(target);
    if (this.scanning.has(key)) {
      this.pendingAfterScan.add(key);
      return;
    }
    if (this.pendingTimers.has(key)) return;
    const last = this.lastScanAt.get(key);
    const elapsed = last === undefined ? Number.POSITIVE_INFINITY : this.now() - last;
    const wait = Math.max(this.debounceMs, this.minScanIntervalMs - elapsed);
    const timer = this.setTimeoutFn(() => {
      this.pendingTimers.delete(key);
      void this.runScan(key, target);
    }, wait);
    this.pendingTimers.set(key, timer);
  }

  private schedulePulse(): void {
    if (!this.started) return;
    if (this.pulseTimer) this.clearTimeoutFn(this.pulseTimer);
    this.pulseTimer = this.setTimeoutFn(() => {
      this.pulseTimer = undefined;
      if (!this.started) return;
      void this.pulse().finally(() => this.schedulePulse());
    }, this.minScanIntervalMs);
  }

  private scheduleReconcile(): void {
    if (!this.started) return;
    this.reconcileTimer = this.setTimeoutFn(() => {
      if (!this.started) return;
      void this.reconcile().finally(() => this.scheduleReconcile());
    }, this.reconcileMs);
  }

  /** Pulse pass: notify every watch connection (interval-gated coalescing). */
  pulse(): Promise<void> {
    return this.track(this.runPulse());
  }

  private async runPulse(): Promise<void> {
    if (!this.started) return;
    const targets = await this.options.listConnections().catch(() => []);
    for (const target of targets) this.notify(target);
  }

  /** Full reconciliation pass: one forced scan per watch connection. */
  reconcile(): Promise<void> {
    return this.track(this.runReconcile());
  }

  private async runReconcile(): Promise<void> {
    if (!this.started || this.reconcilePassRunning) return;
    this.reconcilePassRunning = true;
    try {
      const targets = await this.options.listConnections().catch(() => []);
      for (const target of targets) {
        if (!this.started) return;
        // The reconcile pass is the 5-minute full reconciliation: it bypasses
        // the minimum-interval gate and any pending debounced scan.
        const key = targetKey(target);
        const timer = this.pendingTimers.get(key);
        if (timer) {
          this.clearTimeoutFn(timer);
          this.pendingTimers.delete(key);
        }
        if (this.scanning.has(key)) {
          this.pendingAfterScan.add(key);
          continue;
        }
        await this.runScan(key, target);
      }
    } finally {
      this.reconcilePassRunning = false;
    }
  }

  private runScan(key: string, target: KnowledgeWatchTarget): Promise<void> {
    return this.track(this.executeScan(key, target));
  }

  private async executeScan(key: string, target: KnowledgeWatchTarget): Promise<void> {
    if (!this.started || this.scanning.has(key)) {
      if (this.started && this.scanning.has(key)) this.pendingAfterScan.add(key);
      return;
    }
    const controller = this.controller;
    if (!controller) return;
    this.scanning.add(key);
    this.lastScanAt.set(key, this.now());
    try {
      await this.options.scan(target, controller.signal);
    } catch {
      // The scan callback owns its bounded status evidence; the pump never
      // crashes and never logs upstream detail.
    } finally {
      this.scanning.delete(key);
      if (this.pendingAfterScan.delete(key) && this.started) this.notify(target);
    }
  }
}
