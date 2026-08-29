import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearContainedConfig, readContainedConfig, writeContainedConfig } from "../contained/configStore.js";
import { createContainedEngineManager } from "../contained/engineManager.js";
import { config } from "../config.js";

let tempDataDir = "";

beforeEach(async () => {
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-engine-"));
  process.env.CONTAINED_DIR = path.join(tempDataDir, "models");
  await clearContainedConfig();
});

afterEach(async () => {
  if (process.env.CONTAINED_DIR === path.join(tempDataDir, "models")) delete process.env.CONTAINED_DIR;
  await fs.rm(tempDataDir, { recursive: true, force: true });
  tempDataDir = "";
});

// A stub "llama-server" that serves /v1/models on the port the manager chose
// (passed through STUB_PORT by the spawn wrapper below) and honors SIGTERM.
const STUB_ENGINE = `const http = require("node:http");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
});
process.on("SIGTERM", () => process.exit(0));
server.listen(Number(process.env.STUB_PORT), "127.0.0.1", () => {});`;

async function writeStubEngine(): Promise<string> {
  const file = path.join(tempDataDir, "stub-engine.cjs");
  await fs.writeFile(file, STUB_ENGINE, { mode: 0o755 });
  return file;
}

async function writeModelFile(): Promise<string> {
  const modelPath = path.join(tempDataDir, "model.gguf");
  await fs.writeFile(modelPath, "fake-weights");
  return modelPath;
}

/** Spawn wrapper that forwards the manager-chosen port to the stub engine. */
function stubSpawnWrapper(record: Array<{ file: string; args: string[] }>) {
  return ((file: string, args: readonly string[], options?: unknown) =>
    spawn(file, args, {
      ...(options as object),
      env: { ...process.env, STUB_PORT: String(args[args.indexOf("--port") + 1]) },
    })) as never;
}

async function waitForState(snapshot: () => { state: string }, state: string, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (snapshot().state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`engine never reached state ${state} (last: ${snapshot().state})`);
}

describe("contained engine manager", () => {
  it("requires an enabled, existing configuration before spawning", async () => {
    const manager = createContainedEngineManager();
    await expect(manager.start()).rejects.toMatchObject({ name: "ContainedConfigError" });

    await writeContainedConfig({ enabled: true, binaryPath: "/bin/x", modelPath: "/bin/y" });
    await expect(manager.start()).rejects.toMatchObject({ message: "binary_path does not exist" });

    await writeContainedConfig({
      enabled: true,
      binaryPath: "/bin/sh",
      modelPath: path.join(tempDataDir, "missing.gguf"),
    });
    await expect(manager.start()).rejects.toMatchObject({ message: "model_path does not exist" });
  });

  it("spawns with the llama-server contract, reaches healthy, and stops cleanly", async () => {
    const enginePath = await writeStubEngine();
    const modelPath = await writeModelFile();
    await writeContainedConfig({
      enabled: true,
      binaryPath: process.execPath,
      modelPath,
      extraArgs: ["-ngl", "99"],
    });

    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const appliedEndpoints: string[] = [];
    const restoredEndpoints: string[] = [];
    const manager = createContainedEngineManager({
      spawn: ((file: string, args: readonly string[], options?: unknown) => {
        spawnCalls.push({ file, args: [...args] });
        return stubSpawnWrapper(spawnCalls)(file, args, options);
      }) as never,
      // Health succeeds only against the port the manager actually chose.
      probe: (async (url: string) => {
        const port = spawnCalls.at(-1)?.args[5];
        return url === `http://127.0.0.1:${port}/v1/models`;
      }) as never,
      applyEndpoint: async (engineBaseUrl) => {
        appliedEndpoints.push(engineBaseUrl);
      },
      restoreEndpoint: async (engineBaseUrl) => {
        restoredEndpoints.push(engineBaseUrl);
      },
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    expect((await manager.start()).state).toBe("starting");
    await waitForState(() => manager.snapshot(), "healthy");

    const healthy = manager.snapshot();
    expect(healthy.model).toBe("model.gguf");
    expect(healthy.endpoint_host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(spawnCalls[0]?.file).toBe(process.execPath);
    expect(spawnCalls[0]?.args.slice(0, 6)).toEqual([
      "-m",
      modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      expect.any(String),
    ]);
    expect(spawnCalls[0]?.args.slice(6)).toEqual(["-ngl", "99"]);
    expect(appliedEndpoints).toEqual([`http://127.0.0.1:${healthy.endpoint_host?.split(":")[1]}`]);

    const stopped = await manager.stop();
    expect(stopped.state).toBe("stopped");
    expect(restoredEndpoints.length).toBe(1);
    // Stop is idempotent.
    expect((await manager.stop()).state).toBe("stopped");
    void enginePath;
  });

  it("reports endpoint_managed_by_env without applying", async () => {
    await writeModelFile();
    await writeStubEngine();
    await writeContainedConfig({
      enabled: true,
      binaryPath: process.execPath,
      modelPath: path.join(tempDataDir, "model.gguf"),
    });

    let applied = 0;
    const manager = createContainedEngineManager({
      spawn: stubSpawnWrapper([]),
      probe: (async (url: string) => url.includes("127.0.0.1")) as never,
      isEndpointEnvManaged: async () => true,
      applyEndpoint: async () => {
        applied += 1;
      },
      restoreEndpoint: async () => undefined,
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });
    await manager.start();
    await waitForState(() => manager.snapshot(), "healthy");
    expect(manager.snapshot().endpoint_managed_by_env).toBe(true);
    expect(applied).toBe(0);
    await manager.stop();
  });

  it("marks the engine crashed when the process exits early", async () => {
    await writeModelFile();
    await writeContainedConfig({
      enabled: true,
      binaryPath: process.execPath,
      modelPath: path.join(tempDataDir, "model.gguf"),
    });

    const manager = createContainedEngineManager({
      spawn: (() => spawn(process.execPath, ["-e", "process.exit(3)"])) as never,
      probe: (async () => false) as never,
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });
    await manager.start();
    await waitForState(() => manager.snapshot(), "crashed");
    expect(manager.snapshot().error).toContain("exited unexpectedly");
  });

  it("reads back a disabled config as present but inert", async () => {
    await writeContainedConfig({ enabled: false });
    const stored = await readContainedConfig();
    expect(stored?.enabled).toBe(false);
    expect(config.containedDir).toBeTruthy();
  });
});
