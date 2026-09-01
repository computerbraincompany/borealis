import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { probeEndpointOk } from "../endpointProbe.js";
import { readContainedConfig, ContainedConfigError, type ContainedConfig } from "./configStore.js";

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

const HEALTH_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;
const KILL_TIMEOUT_MS = 5_000;

export interface ContainedEngineDependencies {
  readonly spawn?: typeof nodeSpawn;
  readonly probe?: typeof probeEndpointOk;
  readonly now?: () => Date;
  readonly healthTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * Applies the engine origin to the live provider settings, remembering the
   * prior origin for restore. Throws when the endpoint is environment-managed.
   */
  readonly applyEndpoint?: (engineBaseUrl: string) => Promise<void>;
  /** Restores the prior origin if the provider still points at the engine. */
  readonly restoreEndpoint?: (engineBaseUrl: string) => Promise<void>;
  /** Reports whether the provider endpoint is environment-managed. */
  readonly isEndpointEnvManaged?: () => Promise<boolean>;
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

export function createContainedEngineManager(dependencies: ContainedEngineDependencies = {}) {
  const spawn = dependencies.spawn ?? nodeSpawn;
  const probe = dependencies.probe ?? probeEndpointOk;
  const now = dependencies.now ?? (() => new Date());
  const healthTimeoutMs = dependencies.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const pollIntervalMs = dependencies.pollIntervalMs ?? POLL_INTERVAL_MS;

  let status: ContainedEngineStatus = {
    state: "off",
    model: null,
    endpoint_host: null,
    endpoint_managed_by_env: false,
    pid: null,
    started_at: null,
    error: null,
  };
  let child: ChildProcess | null = null;
  let stopRequested = false;
  let port: number | null = null;

  function snapshot(): ContainedEngineStatus {
    return { ...status };
  }

  function setState(patch: Partial<MutableStatus>): void {
    status = { ...status, ...patch };
  }

  type MutableStatus = {
    -readonly [K in keyof ContainedEngineStatus]: ContainedEngineStatus[K];
  };

  async function requireEnabledConfig(): Promise<ContainedConfig> {
    const config = await readContainedConfig();
    if (!config?.enabled || !config.binary_path || !config.model_path) {
      throw new ContainedConfigError("contained mode is not configured");
    }
    return config;
  }

  async function start(): Promise<ContainedEngineStatus> {
    if (status.state === "starting" || status.state === "healthy") {
      throw new ContainedConfigError("the contained engine is already running");
    }
    const config = await requireEnabledConfig();
    // Sequential checks so the diagnostic is deterministic when both paths are
    // absent: binary_path always wins over model_path.
    try {
      await fs.access(config.binary_path);
    } catch {
      throw new ContainedConfigError("binary_path does not exist");
    }
    try {
      await fs.access(config.model_path);
    } catch {
      throw new ContainedConfigError("model_path does not exist");
    }

    stopRequested = false;
    port = await freePort();
    const modelFile = path.basename(config.model_path);
    setState({
      state: "starting",
      model: modelFile,
      endpoint_host: null,
      pid: null,
      started_at: now().toISOString(),
      error: null,
    });

    const args = ["-m", config.model_path, "--host", "127.0.0.1", "--port", String(port), ...config.extra_args];
    // Engine output is never read or logged; health is the only signal.
    child = spawn(config.binary_path, args, { stdio: "ignore" });
    setState({ pid: child.pid ?? null });
    child.once("exit", () => {
      if (!stopRequested && (status.state === "starting" || status.state === "healthy")) {
        setState({ state: "crashed", error: "the engine process exited unexpectedly", pid: null });
        child = null;
      }
    });
    // Spawn failures (for example a non-executable or raced-away binary) are
    // emitted on the child's "error" event; leaving it unhandled would crash
    // the server instead of moving the engine into a bounded state.
    child.once("error", () => {
      if (stopRequested || (status.state !== "starting" && status.state !== "healthy")) return;
      setState({ state: "crashed", error: "the engine process could not be started", pid: null });
      child = null;
    });

    void waitUntilHealthy();
    return snapshot();
  }

  async function waitUntilHealthy(): Promise<void> {
    const deadline = now().getTime() + healthTimeoutMs;
    while (now().getTime() < deadline && !stopRequested && status.state === "starting") {
      const engineUrl = `http://127.0.0.1:${port}/v1/models`;
      if (await probe(engineUrl, { timeoutMs: 2_000 })) {
        setState({ state: "healthy", endpoint_host: `127.0.0.1:${port}` });
        await autoApply();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    if (!stopRequested && status.state === "starting") {
      setState({ state: "crashed", error: "the engine did not become healthy within the health budget" });
    }
  }

  async function autoApply(): Promise<void> {
    const engineBaseUrl = `http://127.0.0.1:${port}`;
    if (dependencies.isEndpointEnvManaged && (await dependencies.isEndpointEnvManaged())) {
      setState({ endpoint_managed_by_env: true });
      return;
    }
    if (!dependencies.applyEndpoint) return;
    try {
      await dependencies.applyEndpoint(engineBaseUrl);
    } catch {
      setState({ endpoint_managed_by_env: true });
    }
  }

  async function stop(): Promise<ContainedEngineStatus> {
    const running = child;
    if (running && status.state !== "off") {
      stopRequested = true;
      running.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => running.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), KILL_TIMEOUT_MS)),
      ]);
      if (!exited) running.kill("SIGKILL");
    }
    stopRequested = true;
    child = null;
    await restoreEndpoint();
    setState({ state: status.state === "off" ? "off" : "stopped", pid: null, endpoint_host: null });
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
