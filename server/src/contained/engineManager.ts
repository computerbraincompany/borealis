import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { probeEndpointOk } from "../endpointProbe.js";
import {
  assertContainedExtraArgs,
  ContainedConfigError,
  MAX_CONTAINED_ARG_CHARS,
  MAX_CONTAINED_EXTRA_ARGS,
  readContainedConfig,
  type ContainedConfig,
} from "./configStore.js";
import { proveEngineFiles, type EngineFileProof } from "./filePolicy.js";

export type ContainedEngineState = "off" | "starting" | "healthy" | "crashed" | "stopped";

export interface ContainedEngineStatus {
  readonly state: ContainedEngineState;
  readonly model: string | null;
  readonly endpoint_host: string | null;
  readonly endpoint_managed_by_env: boolean;
  readonly pid: number | null;
  readonly started_at: string | null;
  readonly error: string | null;
}

/**
 * Stable content-free lifecycle failure. It signals that a stop could not
 * observe the exact child's exit, or that a poisoned manager must not start
 * again; callers must withhold graceful-stopped success.
 */
export class ContainedEngineLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainedEngineLifecycleError";
  }
}

const HEALTH_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;
const KILL_TIMEOUT_MS = 5_000;
const POST_KILL_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;

export interface ContainedEngineDependencies {
  readonly spawn?: typeof nodeSpawn;
  readonly probe?: typeof probeEndpointOk;
  readonly now?: () => Date;
  readonly healthTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly killTimeoutMs?: number;
  readonly postKillTimeoutMs?: number;
  /**
   * Applies the engine origin to the live provider settings, remembering the
   * prior origin for restore. Throws when the endpoint is environment-managed.
   */
  readonly applyEndpoint?: (engineBaseUrl: string) => Promise<void>;
  /** Restores the prior origin if the provider still points at the engine. */
  readonly restoreEndpoint?: (engineBaseUrl: string) => Promise<void>;
  /** Reports whether the provider endpoint is environment-managed. */
  readonly isEndpointEnvManaged?: () => Promise<boolean>;
  /** Seam: enabled-config read (defaults to the durable store). */
  readonly readConfig?: () => Promise<ContainedConfig | null>;
  /** Seam: open-handle file proof (defaults to the real file policy). */
  readonly proveFiles?: (config: ContainedConfig) => Promise<EngineFileProof>;
  /** Seam: loopback port reservation (defaults to an OS-assigned free port). */
  readonly reservePort?: () => Promise<number>;
  /**
   * Narrow seam that runs after the binary digest was hashed and before the
   * final identity check. Tests use it to replace the binary or model at that
   * boundary and prove the identity recheck rejects before spawn.
   */
  readonly beforeFinalIdentityCheck?: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free loopback port"))));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function completeArgumentValidation(args: readonly string[]): void {
  if (args.length > MAX_CONTAINED_EXTRA_ARGS) {
    throw new ContainedConfigError(`extra_args must hold at most ${MAX_CONTAINED_EXTRA_ARGS} items`);
  }
  for (const argument of args) {
    if (
      typeof argument !== "string" ||
      argument.length < 1 ||
      argument.length > MAX_CONTAINED_ARG_CHARS ||
      argument.includes("\0")
    ) {
      throw new ContainedConfigError("each extra_arg must be 1-200 characters");
    }
  }
  assertContainedExtraArgs(args);
}

export function createContainedEngineManager(dependencies: ContainedEngineDependencies = {}) {
  const spawn = dependencies.spawn ?? nodeSpawn;
  const probe = dependencies.probe ?? probeEndpointOk;
  const now = dependencies.now ?? (() => new Date());
  const healthTimeoutMs = dependencies.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const pollIntervalMs = dependencies.pollIntervalMs ?? POLL_INTERVAL_MS;
  const killTimeoutMs = dependencies.killTimeoutMs ?? KILL_TIMEOUT_MS;
  const postKillTimeoutMs = dependencies.postKillTimeoutMs ?? POST_KILL_TIMEOUT_MS;
  const readConfig = dependencies.readConfig ?? readContainedConfig;
  const proveFiles = dependencies.proveFiles ?? proveEngineFiles;
  const reservePort = dependencies.reservePort ?? freePort;
  const beforeFinalIdentityCheck = dependencies.beforeFinalIdentityCheck ?? (async () => undefined);

  type MutableStatus = {
    -readonly [K in keyof ContainedEngineStatus]: ContainedEngineStatus[K];
  };

  let status: MutableStatus = {
    state: "off",
    model: null,
    endpoint_host: null,
    endpoint_managed_by_env: false,
    pid: null,
    started_at: null,
    error: null,
  };

  // ——— single-generation lifecycle state ———
  // `generation` is bumped by every accepted start, by child exit, and by
  // stop. Setup and health continuations are only live for the current value.
  let generation = 0;
  let child: ChildProcess | null = null;
  let port: number | null = null;
  let stopRequested = false;
  /** Tracked pre-spawn setup promise (never rejects; stop joins it). */
  let startPump: Promise<void> | undefined;
  /** Tracked health/auto-apply promise (never rejects; stop joins it). */
  let healthPump: Promise<void> | undefined;
  /** Cached stop promise; retained forever when a child could not be reaped. */
  let stopPump: Promise<ContainedEngineStatus> | undefined;
  /** Generation owning the synchronous start slot, or undefined when free. */
  let slotOwnerGen: number | undefined;
  /** Terminal state after an unreaped KILL: starts stay rejected. */
  let poisoned = false;
  /** Children whose exit/error has already been observed (never spawns). */
  const reapedChildren = new WeakSet<ChildProcess>();

  function snapshot(): ContainedEngineStatus {
    return { ...status };
  }

  function setState(patch: Partial<MutableStatus>): void {
    status = { ...status, ...patch };
  }

  function isCurrentStart(gen: number, proc: ChildProcess | null): boolean {
    return generation === gen && child === proc && !stopRequested;
  }

  function statusBelongsTo(gen: number, proc: ChildProcess, expected: readonly ContainedEngineState[]): boolean {
    return isCurrentStart(gen, proc) && expected.includes(status.state);
  }

  async function requireEnabledConfig(): Promise<ContainedConfig> {
    const config = await readConfig();
    if (!config?.enabled || !config.binary_path || !config.model_path || !config.binary_sha256) {
      throw new ContainedConfigError("contained mode is not configured");
    }
    return config;
  }

  /**
   * Starts the contained engine. Admission is synchronous before the first
   * await: at most one setup slot exists, and a prior setup, child, health
   * pump, or stop is never raced. The async setup only begins through a
   * deferred microtask after the reservation and tracked promise exist, so a
   * synchronous throw can never finalize before ownership is visible.
   */
  async function start(): Promise<ContainedEngineStatus> {
    if (poisoned) {
      throw new ContainedEngineLifecycleError("the contained engine must not restart after an unreaped engine process");
    }
    if (stopPump) {
      throw new ContainedConfigError("the contained engine is stopping");
    }
    if (slotOwnerGen !== undefined || startPump !== undefined || healthPump !== undefined || child !== null) {
      throw new ContainedConfigError("the contained engine is already running or still settling");
    }
    const gen = ++generation;
    slotOwnerGen = gen;
    stopRequested = false;

    let settle!: () => void;
    let fail!: (error: unknown) => void;
    const outcome = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const myPump = outcome.catch(() => undefined);
    startPump = myPump;

    queueMicrotask(() => {
      void setupRun(gen).then(
        () => {
          finalizeSetup(gen, myPump);
          settle();
        },
        (error: unknown) => {
          finalizeSetup(gen, myPump);
          fail(error);
        }
      );
    });

    await outcome;
    return snapshot();
  }

  /** Only the exact entry's finalizer clears its own tracked pump/slot. */
  function finalizeSetup(gen: number, myPump: Promise<void>): void {
    if (startPump === myPump) startPump = undefined;
    if (slotOwnerGen === gen) slotOwnerGen = undefined;
  }

  async function setupRun(gen: number): Promise<void> {
    const stillOurs = (): boolean => generation === gen && !stopRequested && slotOwnerGen === gen;
    const canceled = (): Error => new ContainedConfigError("the contained engine start was canceled");

    // Phase 1: enabled-config read.
    const config = await requireEnabledConfig();
    if (!stillOurs()) throw canceled();
    // Defense in depth: validate the complete argument array again before any
    // process work, even though the config decoder enforces it.
    completeArgumentValidation(config.extra_args);

    // Phase 2: open-handle model/binary proof (configures digest verification).
    const proof = await proveFiles(config);
    if (!stillOurs()) {
      await proof.close();
      throw canceled();
    }

    // Phase 3: port reservation.
    const chosenPort = await reservePort();
    if (!stillOurs()) {
      await proof.close();
      throw canceled();
    }

    // Narrow seam between hashing and the final identity check.
    await beforeFinalIdentityCheck();
    if (!stillOurs()) {
      await proof.close();
      throw canceled();
    }

    // Phase 4: final path/handle identity check.
    try {
      await proof.verifyIdentity();
    } catch (error) {
      await proof.close();
      throw error;
    }

    // Final synchronous section: from the identity verdict through spawn and
    // listener installation there is no await, so no stop can interleave and
    // capture a child it did not observe.
    if (!isCurrentStart(gen, null) || slotOwnerGen !== gen) {
      await proof.close();
      throw canceled();
    }
    const args = ["-m", config.model_path, "--host", "127.0.0.1", "--port", String(chosenPort), ...config.extra_args];
    let proc: ChildProcess;
    try {
      // Engine output is never read or logged; health is the only signal.
      proc = spawn(config.binary_path, args, { stdio: "ignore" });
    } catch {
      await proof.close();
      setState({ state: "crashed", error: "the engine process could not be started", pid: null });
      throw new ContainedConfigError("the contained engine process could not be started");
    }
    child = proc;
    port = chosenPort;
    setState({
      state: "starting",
      model: path.basename(config.model_path),
      pid: proc.pid ?? null,
      started_at: now().toISOString(),
      endpoint_host: null,
      error: null,
    });
    installChildLifecycle(gen, proc);
    // Handles are released as soon as the spawn syscall has returned (success
    // or a synchronous failure). A later async spawn error keeps the exact
    // child identity for stop to reap or reap-skip.
    void proof.close().catch(() => undefined);
  }

  /** Child listeners and the health pump are installed in the spawn turn. */
  function installChildLifecycle(gen: number, proc: ChildProcess): void {
    proc.once("exit", () => {
      reapedChildren.add(proc);
      // Synchronously invalidate this generation before clearing child state
      // so a pending probe result for a dead/replaced child is inert.
      if (generation === gen) generation += 1;
      if (child === proc) child = null;
      if (!stopRequested && (status.state === "starting" || status.state === "healthy")) {
        setState({ state: "crashed", error: "the engine process exited unexpectedly", pid: null });
      }
    });
    proc.once("error", () => {
      reapedChildren.add(proc);
      if (child !== proc) return;
      if (stopRequested || (status.state !== "starting" && status.state !== "healthy")) return;
      // Spawn failures (for example a raced-away binary) land in the bounded
      // crashed state instead of an unhandled child error event.
      if (generation === gen) generation += 1;
      child = null;
      setState({ state: "crashed", error: "the engine process could not be started", pid: null });
    });
    healthPump = runHealthPump(gen, proc);
  }

  function runHealthPump(gen: number, proc: ChildProcess): Promise<void> {
    // The holder is populated before the async body can reach its finally, so
    // the identity check sees the real promise.
    const holder: { pump?: Promise<void> } = {};
    holder.pump = (async () => {
      try {
        await healthLoop(gen, proc);
      } catch {
        // The health pump is content-free and never rejects its joiner.
      } finally {
        if (holder.pump && healthPump === holder.pump) healthPump = undefined;
      }
    })();
    return holder.pump;
  }

  async function healthLoop(gen: number, proc: ChildProcess): Promise<void> {
    if (port === null) return;
    const enginePort = port;
    const engineUrl = `http://127.0.0.1:${enginePort}/v1/models`;
    const deadline = now().getTime() + healthTimeoutMs;
    for (;;) {
      if (!statusBelongsTo(gen, proc, ["starting"])) return;
      if (now().getTime() >= deadline) {
        setState({ state: "crashed", error: "the engine did not become healthy within the health budget" });
        return;
      }
      const healthy = await probe(engineUrl, { timeoutMs: PROBE_TIMEOUT_MS });
      // After the probe, and before marking or applying anything, recheck the
      // generation, the exact child, the stop flag, and the expected phase.
      if (!statusBelongsTo(gen, proc, ["starting"])) return;
      if (healthy) {
        setState({ state: "healthy", endpoint_host: `127.0.0.1:${enginePort}` });
        await autoApply(gen, proc, enginePort);
        return;
      }
      await delay(pollIntervalMs);
    }
  }

  async function autoApply(gen: number, proc: ChildProcess, enginePort: number): Promise<void> {
    const engineBaseUrl = `http://127.0.0.1:${enginePort}`;
    if (dependencies.isEndpointEnvManaged) {
      const envManaged = await dependencies.isEndpointEnvManaged();
      if (!statusBelongsTo(gen, proc, ["starting", "healthy"])) return;
      if (envManaged) {
        setState({ endpoint_managed_by_env: true });
        return;
      }
    }
    if (!dependencies.applyEndpoint) return;
    try {
      await dependencies.applyEndpoint(engineBaseUrl);
    } catch {
      if (!statusBelongsTo(gen, proc, ["starting", "healthy"])) return;
      setState({ endpoint_managed_by_env: true });
    }
  }

  function observeExit(target: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (reapedChildren.has(target) || target.exitCode !== null || target.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        target.off("exit", onExit);
        target.off("close", onExit);
        resolve(value);
      };
      const onExit = () => {
        reapedChildren.add(target);
        finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      target.once("exit", onExit);
      target.once("close", onExit);
    });
  }

  /**
   * Stops the engine. The stop promise is reserved and the generation is
   * invalidated synchronously before the first await, and the exact setup
   * pump, health pump, and child are captured. Stop then signals the child,
   * drains both pumps (including an apply already in flight), and only after
   * the exact child is observed exited runs the compare-and-swap restore. A
   * child that cannot be reaped after TERM→KILL poisons this process for new
   * starts; availability is never traded for a possible second engine beside
   * an unobserved first one.
   */
  function stop(): Promise<ContainedEngineStatus> {
    if (stopPump) return stopPump;
    // Synchronous reservation and invalidation before the first await.
    stopRequested = true;
    generation += 1;
    const capturedSetup = startPump;
    const capturedHealth = healthPump;
    const capturedChild = child;
    const wasOff = status.state === "off";
    if (capturedChild) capturedChild.kill("SIGTERM");

    let settle!: (value: ContainedEngineStatus) => void;
    let reject!: (error: unknown) => void;
    const outcome = new Promise<ContainedEngineStatus>((resolve, rejectFn) => {
      settle = resolve;
      reject = rejectFn;
    });
    stopPump = outcome;

    void (async () => {
      try {
        const result = await drainStop(capturedSetup, capturedHealth, capturedChild, wasOff);
        if (stopPump === outcome) stopPump = undefined;
        settle(result);
      } catch (error) {
        // A drain failure is the poisoned case: retain the stop reservation
        // and the exact child identity permanently for this process.
        reject(error);
      }
    })();
    return outcome;
  }

  async function drainStop(
    capturedSetup: Promise<void> | undefined,
    capturedHealth: Promise<void> | undefined,
    capturedChild: ChildProcess | null,
    wasOff: boolean
  ): Promise<ContainedEngineStatus> {
    let target = capturedChild ?? undefined;
    let reaped = target ? await observeExit(target, killTimeoutMs) : true;
    if (target && !reaped) {
      target.kill("SIGKILL");
      reaped = await observeExit(target, postKillTimeoutMs);
    }
    // Drain the tracked promises: a pre-spawn setup must observe the
    // invalidation and settle without spawning; an in-flight apply completes
    // before restore.
    await capturedSetup;
    await capturedHealth;
    // Defensive adoption: if a spawn had already completed in the final
    // synchronous section when stop captured, its exact child is now visible.
    if (!target && child) {
      target = child;
      child.kill("SIGTERM");
      reaped = await observeExit(child, killTimeoutMs);
      if (!reaped) {
        child.kill("SIGKILL");
        reaped = await observeExit(child, postKillTimeoutMs);
      }
    }
    if (target && !reaped) {
      poisoned = true;
      child = target; // retain the exact child identity for this process
      setState({ error: "the contained engine process could not be reaped" });
      throw new ContainedEngineLifecycleError("the contained engine process could not be reaped");
    }
    child = null;
    await restoreEndpoint();
    slotOwnerGen = undefined;
    stopRequested = false;
    setState({ state: wasOff ? "off" : "stopped", pid: null, endpoint_host: null });
    return snapshot();
  }

  async function restoreEndpoint(): Promise<void> {
    if (!dependencies.restoreEndpoint || port === null) return;
    try {
      await dependencies.restoreEndpoint(`http://127.0.0.1:${port}`);
    } catch {
      // Contained: a restore failure leaves the current origin untouched.
    }
  }

  return { start, stop, snapshot };
}

export type ContainedEngineManager = ReturnType<typeof createContainedEngineManager>;
