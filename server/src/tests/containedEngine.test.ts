import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearContainedConfig,
  ContainedConfigError,
  readContainedConfig,
  writeContainedConfig,
} from "../contained/configStore.js";
import { createContainedEngineManager, ContainedEngineLifecycleError } from "../contained/engineManager.js";
import { isReservedArtifactBasename, proveEngineFiles, RESERVED_PARTIALS_BASENAME } from "../contained/filePolicy.js";
import { config } from "../config.js";

let tempDataDir = "";
let previousContainedDir: string | undefined;
let previousStorageDir = "";
let previousConfiguredContainedDir = "";

beforeEach(async () => {
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-engine-"));
  previousContainedDir = process.env.CONTAINED_DIR;
  previousStorageDir = config.storageDir;
  previousConfiguredContainedDir = config.containedDir;
  process.env.CONTAINED_DIR = path.join(tempDataDir, "models");
  config.storageDir = tempDataDir;
  config.containedDir = path.join(tempDataDir, "models");
  await fs.mkdir(config.containedDir, { recursive: true });
  await clearContainedConfig();
});

afterEach(async () => {
  if (previousContainedDir === undefined) delete process.env.CONTAINED_DIR;
  else process.env.CONTAINED_DIR = previousContainedDir;
  config.storageDir = previousStorageDir;
  config.containedDir = previousConfiguredContainedDir;
  await fs.rm(tempDataDir, { recursive: true, force: true });
  tempDataDir = "";
});

// A stub "llama-server" that serves /v1/models on the port the manager chose
// (passed through STUB_PORT by the spawn wrapper below) and honors SIGTERM.
// It ignores the llama-server argv contract; the manager's spawn arguments
// are asserted directly.
const STUB_ENGINE = `#!/usr/bin/env node
const http = require("node:http");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
});
process.on("SIGTERM", () => process.exit(0));
server.listen(Number(process.env.STUB_PORT), "127.0.0.1", () => {});
`;

function sha256Hex(bytes: Uint8Array | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

interface StubFixture {
  readonly path: string;
  readonly digest: string;
}

async function writeStubEngine(name = "llama-server"): Promise<StubFixture> {
  const directory = path.join(tempDataDir, "bin");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await fs.writeFile(file, STUB_ENGINE, { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return { path: file, digest: sha256Hex(STUB_ENGINE) };
}

async function writeModelFile(name = "model.gguf", content = "fake-weights"): Promise<string> {
  const modelPath = path.join(config.containedDir, name);
  await fs.mkdir(path.dirname(modelPath), { recursive: true });
  await fs.writeFile(modelPath, content);
  return modelPath;
}

async function configureEngine(stub: StubFixture, modelPath: string, extraArgs: readonly string[] = []) {
  await writeContainedConfig({
    enabled: true,
    binaryPath: stub.path,
    modelPath,
    binarySha256: stub.digest,
    extraArgs,
  });
}

/** Spawn wrapper that forwards the manager-chosen port to the stub engine. */
function stubSpawnWrapper(spawnCalls: Array<{ file: string; args: string[] }>) {
  return (file: string, args: readonly string[], options?: unknown) => {
    spawnCalls.push({ file, args: [...args] });
    return nodeSpawn(file, args, {
      ...(options as object),
      env: { ...process.env, STUB_PORT: String(args[args.indexOf("--port") + 1]) },
    });
  };
}

/** Health succeeds only against the port the manager actually chose. */
function stubProbe(spawnCalls: Array<{ file: string; args: string[] }>) {
  return (async (url: string) => {
    const port = spawnCalls.at(-1)?.args[5];
    return url === `http://127.0.0.1:${port}/v1/models`;
  }) as never;
}

async function waitForState(snapshot: () => { state: string }, state: string, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (snapshot().state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`engine never reached state ${state} (last: ${snapshot().state})`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

/** Wraps the real proof so tests can observe handle-release via close(). */
function trackedProve() {
  const tracked: Array<{ closed: () => boolean }> = [];
  const fn = async (cfg: Parameters<typeof proveEngineFiles>[0]) => {
    const proof = await proveEngineFiles(cfg);
    let closed = false;
    tracked.push({ closed: () => closed });
    return {
      ...proof,
      close: async () => {
        closed = true;
        await proof.close();
      },
    };
  };
  return { fn, tracked };
}

describe("contained engine manager", () => {
  it("requires an enabled, existing configuration before spawning", async () => {
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const manager = createContainedEngineManager({ spawn: stubSpawnWrapper(spawnCalls) as never });
    await expect(manager.start()).rejects.toMatchObject({ name: "ContainedConfigError" });

    await writeContainedConfig({ enabled: false });
    await expect(manager.start()).rejects.toMatchObject({ message: "contained mode is not configured" });

    const stub = await writeStubEngine();
    await configureEngine(stub, path.join(config.containedDir, "missing.gguf"));
    // Binary exists; the model is missing: binary-first determinism holds.
    await expect(manager.start()).rejects.toMatchObject({ message: "model_path does not exist" });

    await writeContainedConfig({
      enabled: true,
      binaryPath: path.join(tempDataDir, "bin", "missing-binary"),
      modelPath: await writeModelFile(),
      binarySha256: stub.digest,
    });
    await expect(manager.start()).rejects.toMatchObject({ message: "binary_path does not exist" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("fails closed on a legacy enabled config without a digest before any proof or spawn", async () => {
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    await fs.writeFile(
      path.join(config.storageDir, "contained.json"),
      JSON.stringify({ enabled: true, binary_path: stub.path, model_path: modelPath, extra_args: [] })
    );
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    let proved = 0;
    const manager = createContainedEngineManager({
      spawn: stubSpawnWrapper(spawnCalls) as never,
      proveFiles: async (cfg) => {
        proved += 1;
        return proveEngineFiles(cfg);
      },
    });
    await expect(manager.start()).rejects.toSatisfy(
      (error: unknown) => error instanceof ContainedConfigError && /requires reconfiguration/i.test(error.message)
    );
    expect(spawnCalls).toHaveLength(0);
    expect(proved).toBe(0);
  });

  it("re-validates the complete argument array before spawn even when stored config was smuggled", async () => {
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    const reservedSpellings: string[][] = [
      ["-m", "/tmp/other.gguf"],
      ["--model", "/tmp/other.gguf"],
      ["--model=/tmp/other.gguf"],
      ["-m=/tmp/other.gguf"],
      ["--host", "0.0.0.0"],
      ["--host=0.0.0.0"],
      ["--port", "9999"],
      ["--port=9999"],
    ];
    for (const extraArgs of reservedSpellings) {
      const spawnCalls: Array<{ file: string; args: string[] }> = [];
      let proved = 0;
      const manager = createContainedEngineManager({
        spawn: stubSpawnWrapper(spawnCalls) as never,
        readConfig: async () =>
          Object.freeze({
            enabled: true,
            binary_path: stub.path,
            model_path: modelPath,
            binary_sha256: stub.digest,
            extra_args: Object.freeze(extraArgs),
          }),
        proveFiles: async (cfg) => {
          proved += 1;
          return proveEngineFiles(cfg);
        },
      });
      await expect(manager.start()).rejects.toBeInstanceOf(ContainedConfigError);
      expect(spawnCalls).toHaveLength(0);
      expect(proved).toBe(0);
    }
  });

  it("spawns with the llama-server contract, reaches healthy, and stops cleanly", async () => {
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    await configureEngine(stub, modelPath, ["-ngl", "99"]);

    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const appliedEndpoints: string[] = [];
    const restoredEndpoints: string[] = [];
    let spawnedChild: ChildProcess | undefined;
    let exited = false;
    const manager = createContainedEngineManager({
      spawn: ((file: string, args: readonly string[], options?: unknown) => {
        const child = stubSpawnWrapper(spawnCalls)(file, args, options);
        spawnedChild = child;
        child.once("exit", () => {
          exited = true;
        });
        return child;
      }) as never,
      probe: stubProbe(spawnCalls),
      applyEndpoint: async (engineBaseUrl) => {
        appliedEndpoints.push(engineBaseUrl);
      },
      restoreEndpoint: async (engineBaseUrl) => {
        restoredEndpoints.push(engineBaseUrl);
      },
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    // Start resolves once the spawn ownership exists; with an instantly-true
    // mock probe the health pump may already have marked the engine healthy.
    expect(["starting", "healthy"]).toContain((await manager.start()).state);
    await waitForState(() => manager.snapshot(), "healthy");

    const healthy = manager.snapshot();
    expect(healthy.model).toBe("model.gguf");
    expect(healthy.endpoint_host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.file).toBe(stub.path);
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
    expect(spawnedChild?.pid).toBe(healthy.pid);

    const stopped = await manager.stop();
    expect(stopped.state).toBe("stopped");
    // Stop only resolves after the exact child's exit was observed.
    expect(exited).toBe(true);
    expect(restoredEndpoints.length).toBe(1);
    // Stop is idempotent.
    expect((await manager.stop()).state).toBe("stopped");
  });

  it("stop joins a spawn concurrent with the unsettled start promise and reaps that exact child", async () => {
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    await configureEngine(stub, modelPath);

    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    let exited = false;
    const manager = createContainedEngineManager({
      spawn: ((file: string, args: readonly string[], options?: unknown) => {
        const child = stubSpawnWrapper(spawnCalls)(file, args, options);
        child.once("exit", () => {
          exited = true;
        });
        return child;
      }) as never,
      probe: stubProbe(spawnCalls),
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    const startPromise = manager.start();
    // Let the setup pump complete the spawn section; start still un-awaited.
    await waitFor(() => spawnCalls.length === 1);
    const stopPromise = manager.stop();
    const started = await startPromise.catch(() => undefined);
    expect(started === undefined || started.state === "starting" || started.state === "healthy").toBe(true);
    const stopped = await stopPromise;
    expect(stopped.state).toBe("stopped");
    // The exact child was observed terminated, not bypassed.
    expect(exited).toBe(true);
  });

  it("reports endpoint_managed_by_env without applying", async () => {
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    await configureEngine(stub, modelPath);

    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    let applied = 0;
    const manager = createContainedEngineManager({
      spawn: stubSpawnWrapper(spawnCalls) as never,
      probe: stubProbe(spawnCalls),
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
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    await configureEngine(stub, modelPath);

    const manager = createContainedEngineManager({
      spawn: (() => nodeSpawn(process.execPath, ["-e", "process.exit(3)"])) as never,
      probe: (async () => false) as never,
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });
    await manager.start();
    await waitForState(() => manager.snapshot(), "crashed");
    expect(manager.snapshot().error).toContain("exited unexpectedly");
    // The dead engine can be stopped and restarted.
    expect((await manager.stop()).state).toBe("stopped");
  });

  it("lands a spawn error event in the bounded crashed state", async () => {
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    await configureEngine(stub, modelPath);

    const manager = createContainedEngineManager({
      spawn: ((file: string, args: readonly string[], options?: unknown) => {
        const child = nodeSpawn(file, args, options as object);
        setTimeout(() => child.emit("error", Object.assign(new Error("simulated"), { code: "EACCES" })), 0);
        return child;
      }) as never,
      probe: (async () => false) as never,
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });
    await manager.start();
    await waitForState(() => manager.snapshot(), "crashed", 100);
    const crashed = manager.snapshot();
    expect(crashed.error).toBe("the engine process could not be started");
    expect(crashed.pid).toBeNull();
    await manager.stop();
  });

  it("fails non-executable, directory, and final-symlink binaries before spawn", async () => {
    const nonExecutable = path.join(tempDataDir, "bin", "plain");
    await fs.mkdir(path.dirname(nonExecutable), { recursive: true });
    await fs.writeFile(nonExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const digest = sha256Hex("#!/bin/sh\nexit 0\n");
    const modelPath = await writeModelFile();

    const cases: Array<[string, string, string]> = [
      ["non-executable", nonExecutable, "not executable"],
      ["directory", tempDataDir, "regular binary"],
    ];
    for (const [label, binaryPath, fragment] of cases) {
      const spawnCalls: Array<{ file: string; args: string[] }> = [];
      await writeContainedConfig({
        enabled: true,
        binaryPath,
        modelPath,
        binarySha256: digest,
        extraArgs: [],
      });
      const manager = createContainedEngineManager({ spawn: stubSpawnWrapper(spawnCalls) as never });
      await expect(manager.start()).rejects.toThrow(fragment);
      expect(spawnCalls).toHaveLength(0);
      void label;
    }

    const stub = await writeStubEngine();
    const link = path.join(tempDataDir, "bin", "linked-server");
    await fs.symlink(stub.path, link);
    await writeContainedConfig({
      enabled: true,
      binaryPath: link,
      modelPath,
      binarySha256: stub.digest,
      extraArgs: [],
    });
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const manager = createContainedEngineManager({ spawn: stubSpawnWrapper(spawnCalls) as never });
    await expect(manager.start()).rejects.toThrow("binary_path must not be a symlink");
    expect(spawnCalls).toHaveLength(0);
  });

  it("never spawns when the binary digest does not match", async () => {
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    await writeContainedConfig({
      enabled: true,
      binaryPath: stub.path,
      modelPath,
      binarySha256: sha256Hex("other-bytes"),
      extraArgs: [],
    });
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const manager = createContainedEngineManager({ spawn: stubSpawnWrapper(spawnCalls) as never });
    await expect(manager.start()).rejects.toThrow("does not match its configured digest");
    expect(spawnCalls).toHaveLength(0);
  });

  it("rejects models escaping the contained root and invalid file kinds before spawn", async () => {
    const stub = await writeStubEngine();
    const cases: Array<{ label: string; prepare: () => Promise<string>; fragment: string }> = [
      {
        label: "outside root",
        prepare: async () => {
          const outside = path.join(tempDataDir, "outside.gguf");
          await fs.writeFile(outside, "weights");
          return outside;
        },
        fragment: "below the contained model directory",
      },
      {
        label: "root itself",
        prepare: async () => config.containedDir,
        fragment: "model root",
      },
      {
        label: "final symlink",
        prepare: async () => {
          const real = await writeModelFile("real.gguf");
          const link = path.join(config.containedDir, "link.gguf");
          await fs.symlink(real, link);
          return link;
        },
        fragment: "must not be a symlink",
      },
      {
        label: "symlinked parent",
        prepare: async () => {
          const real = path.join(config.containedDir, "real");
          await fs.mkdir(real, { recursive: true });
          await fs.writeFile(path.join(real, "m.gguf"), "weights");
          await fs.symlink(real, path.join(config.containedDir, "via"), "dir");
          return path.join(config.containedDir, "via", "m.gguf");
        },
        fragment: "symlinked directories",
      },
      {
        label: "directory",
        prepare: async () => {
          const dir = path.join(config.containedDir, "adir");
          await fs.mkdir(dir, { recursive: true });
          return dir;
        },
        fragment: "regular file",
      },
      {
        label: "missing",
        prepare: async () => path.join(config.containedDir, "missing.gguf"),
        fragment: "model_path does not exist",
      },
      {
        label: "abandoned partial",
        prepare: async () => writeModelFile("abandoned.gguf.part"),
        fragment: "reserved partial",
      },
    ];
    for (const testCase of cases) {
      const modelPath = await testCase.prepare();
      const spawnCalls: Array<{ file: string; args: string[] }> = [];
      await configureEngine(stub, modelPath);
      const manager = createContainedEngineManager({ spawn: stubSpawnWrapper(spawnCalls) as never });
      await expect(manager.start()).rejects.toThrow(testCase.fragment);
      expect(spawnCalls).toHaveLength(0);
    }
    void cases.length;
  });

  it("rejects binary or model replacement between hashing and the final identity check", async () => {
    // Binary replaced (unlink + new inode) at the hook boundary.
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    await configureEngine(stub, modelPath);
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const binaryReplacement = createContainedEngineManager({
      spawn: stubSpawnWrapper(spawnCalls) as never,
      beforeFinalIdentityCheck: async () => {
        await fs.rm(stub.path, { force: true });
        await fs.writeFile(stub.path, STUB_ENGINE + "// replaced\n", { mode: 0o755 });
        await fs.chmod(stub.path, 0o755);
      },
    });
    await expect(binaryReplacement.start()).rejects.toThrow("binary_path changed during the pre-spawn proof");
    expect(spawnCalls).toHaveLength(0);

    // Model content rewritten in place at the hook boundary (same inode,
    // changed high-resolution timestamps).
    await configureEngine(await writeStubEngine("llama-server-2"), modelPath);
    const modelReplacement = createContainedEngineManager({
      spawn: stubSpawnWrapper(spawnCalls) as never,
      beforeFinalIdentityCheck: async () => {
        await fs.writeFile(modelPath, "tampered-weights");
      },
    });
    await expect(modelReplacement.start()).rejects.toThrow("model_path changed during the pre-spawn proof");
    expect(spawnCalls).toHaveLength(0);
  });

  it("reads back a disabled config as present but inert", async () => {
    await writeContainedConfig({ enabled: false });
    const stored = await readContainedConfig();
    expect(stored?.enabled).toBe(false);
    expect(config.containedDir).toBeTruthy();
  });
});

describe("reserved artifact predicate", () => {
  it("rejects dot-only names, the reserved partials directory, and every ASCII-case .part suffix", () => {
    expect(RESERVED_PARTIALS_BASENAME).toBe(".borealis-partials");
    for (const name of [
      ".",
      "..",
      "...",
      ".borealis-partials",
      ".BOREALIS-PARTIALS",
      ".Borealis-Partials",
      "x.part",
      "x.PART",
      "x.pArT",
      ".part",
      "model.gguf.part",
    ]) {
      expect(isReservedArtifactBasename(name)).toBe(true);
    }
    for (const name of ["model.gguf", "x.part.gz", "parts", ".hidden", "part", "x.parts"]) {
      expect(isReservedArtifactBasename(name)).toBe(false);
    }
  });
});

describe("engine start/stop lifecycle", () => {
  interface LifecycleFixture {
    readonly stub: StubFixture;
    readonly modelPath: string;
  }

  async function fixture(): Promise<LifecycleFixture> {
    const stub = await writeStubEngine();
    const modelPath = await writeModelFile();
    await configureEngine(stub, modelPath);
    return { stub, modelPath };
  }

  async function tryStartUntil(manager: ReturnType<typeof createContainedEngineManager>) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return await manager.start();
      } catch (error) {
        if (error instanceof ContainedConfigError && /already running or still settling|stopping/.test(error.message)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        throw error;
      }
    }
    throw new Error("engine start never became admissible");
  }

  for (const boundary of ["config", "proof", "port"] as const) {
    it(`stop drains a deferred ${boundary} boundary without spawning and admits no second start`, async () => {
      await fixture();
      const gate = deferred();
      const spawnCalls: Array<{ file: string; args: string[] }> = [];
      let readConfigCalls = 0;
      let proofCalls = 0;
      let portCalls = 0;
      const prove = trackedProve();

      const manager = createContainedEngineManager({
        spawn: stubSpawnWrapper(spawnCalls) as never,
        probe: (async () => false) as never,
        readConfig:
          boundary === "config"
            ? async () => {
                readConfigCalls += 1;
                await gate.promise;
                return readContainedConfig();
              }
            : undefined,
        proveFiles:
          boundary === "proof"
            ? async (cfg) => {
                proofCalls += 1;
                const proof = await prove.fn(cfg);
                await gate.promise;
                return proof;
              }
            : undefined,
        reservePort:
          boundary === "port"
            ? async () => {
                portCalls += 1;
                await gate.promise;
                return 1;
              }
            : undefined,
        healthTimeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      const startPromise = manager.start();
      await waitFor(() =>
        boundary === "config" ? readConfigCalls === 1 : boundary === "proof" ? proofCalls === 1 : portCalls === 1
      );

      // A concurrent second start is rejected before doing any setup work.
      await expect(manager.start()).rejects.toThrow(/already running or still settling/);

      let stopResolved = false;
      const stopPromise = manager.stop().then((status) => {
        stopResolved = true;
        return status;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Stop remains pending until setup settles: the boundary is still held.
      expect(stopResolved).toBe(false);

      gate.resolve();
      const stopped = await stopPromise;
      // The engine never spawned, so stop reports the inert terminal state.
      expect(["off", "stopped"]).toContain(stopped.state);
      await expect(startPromise).rejects.toThrow(/canceled/);
      expect(spawnCalls).toHaveLength(0);
      // Proof handles opened before the held boundary are closed on drain.
      for (const tracked of prove.tracked) expect(tracked.closed()).toBe(true);

      // A later start begins fresh (the slot was released by stop).
      const restarted = await tryStartUntil(manager);
      expect(["starting", "healthy"]).toContain(restarted.state);
      await manager.stop();
    });
  }

  it("a late probe resolving true after stop never marks or applies the engine", async () => {
    await fixture();
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const holdProbe = deferred();
    let probeEntered = false;
    const applied: string[] = [];
    let stopResolved = false;
    const manager = createContainedEngineManager({
      spawn: stubSpawnWrapper(spawnCalls) as never,
      probe: (async () => {
        probeEntered = true;
        await holdProbe.promise;
        return true;
      }) as never,
      applyEndpoint: async (url) => {
        applied.push(url);
      },
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    await manager.start();
    await waitFor(() => probeEntered);
    const stopPromise = manager.stop().then((status) => {
      stopResolved = true;
      return status;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopResolved).toBe(false);

    holdProbe.resolve();
    const stopped = await stopPromise;
    expect(stopped.state).toBe("stopped");
    expect(applied).toEqual([]);
    const final = manager.snapshot();
    expect(final.state).toBe("stopped");
    expect(final.endpoint_host).toBeNull();
  });

  it("drains an already-entered apply before running restore", async () => {
    await fixture();
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const order: string[] = [];
    const applyEntered = deferred();
    const applyHold = deferred();
    let appliedOnce = false;
    let stopResolved = false;
    const manager = createContainedEngineManager({
      spawn: stubSpawnWrapper(spawnCalls) as never,
      probe: (async () => true) as never,
      applyEndpoint: async () => {
        if (appliedOnce) return;
        appliedOnce = true;
        order.push("apply-entered");
        applyEntered.resolve();
        await applyHold.promise;
        order.push("apply-settled");
      },
      restoreEndpoint: async () => {
        order.push("restore");
      },
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    await manager.start();
    await applyEntered.promise;
    const stopPromise = manager.stop().then((status) => {
      stopResolved = true;
      return status;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopResolved).toBe(false);

    applyHold.resolve();
    const stopped = await stopPromise;
    expect(stopped.state).toBe("stopped");
    expect(order).toEqual(["apply-entered", "apply-settled", "restore"]);
  });

  it("child exit during a deferred probe leaves the pump inert and stop settles", async () => {
    await fixture();
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    const holdProbe = deferred();
    let probeEntered = false;
    let spawnedChild: ChildProcess | undefined;
    const manager = createContainedEngineManager({
      spawn: ((file: string, args: readonly string[], options?: unknown) => {
        const child = stubSpawnWrapper(spawnCalls)(file, args, options);
        spawnedChild = child;
        return child;
      }) as never,
      probe: (async () => {
        probeEntered = true;
        await holdProbe.promise;
        return false;
      }) as never,
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    await manager.start();
    await waitFor(() => probeEntered);
    spawnedChild!.kill("SIGTERM");
    holdProbe.resolve();
    await waitForState(() => manager.snapshot(), "crashed");
    const stopped = await manager.stop();
    expect(stopped.state).toBe("stopped");
  });

  it("restarts quickly after a crash using one fresh generation pump", async () => {
    const { stub } = await fixture();
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    let spawnIndex = 0;
    const manager = createContainedEngineManager({
      spawn: ((file: string, args: readonly string[], options?: unknown) => {
        if (spawnIndex++ === 0) {
          spawnCalls.push({ file, args: [...args] });
          return nodeSpawn(process.execPath, ["-e", "setTimeout(() => process.exit(3), 30)"]);
        }
        return stubSpawnWrapper(spawnCalls)(file, args, options);
      }) as never,
      probe: stubProbe(spawnCalls),
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    await manager.start();
    await waitForState(() => manager.snapshot(), "crashed");
    const restarted = await tryStartUntil(manager);
    expect(["starting", "healthy"]).toContain(restarted.state);
    await waitForState(() => manager.snapshot(), "healthy");
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]?.file).toBe(stub.path);
    await manager.stop();
  });

  it("concurrent stops share one promise and escalate TERM to KILL for the exact child", async () => {
    await fixture();
    let fake!: FakeChild;
    const manager = createContainedEngineManager({
      spawn: (() => {
        fake = new FakeChild();
        return fake as never;
      }) as never,
      probe: (async () => false) as never,
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
      killTimeoutMs: 40,
      postKillTimeoutMs: 40,
    });
    await manager.start();
    const first = manager.stop();
    const second = manager.stop();
    expect(first).toBe(second);
    const [a, b] = await Promise.all([first, second]);
    expect(a.state).toBe("stopped");
    expect(b.state).toBe("stopped");
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails stop and poisons future starts when the exact child cannot be reaped", async () => {
    await fixture();
    const spawnCalls: Array<{ file: string; args: string[] }> = [];
    let readConfigCalls = 0;
    let fake!: FakeChild;
    const manager = createContainedEngineManager({
      spawn: (() => {
        spawnCalls.push({ file: "fake", args: [] });
        fake = new FakeChild({ immortal: true });
        return fake as never;
      }) as never,
      probe: (async () => false) as never,
      readConfig: async () => {
        readConfigCalls += 1;
        return readContainedConfig();
      },
      healthTimeoutMs: 10_000,
      pollIntervalMs: 50,
      killTimeoutMs: 30,
      postKillTimeoutMs: 30,
    });

    await manager.start();
    await expect(manager.stop()).rejects.toBeInstanceOf(ContainedEngineLifecycleError);

    // Every later start is rejected before config/proof/port/spawn work.
    const readsBefore = readConfigCalls;
    const spawnsBefore = spawnCalls.length;
    await expect(manager.start()).rejects.toBeInstanceOf(ContainedEngineLifecycleError);
    await expect(manager.start()).rejects.toBeInstanceOf(ContainedEngineLifecycleError);
    expect(readConfigCalls).toBe(readsBefore);
    expect(spawnCalls).toHaveLength(spawnsBefore);

    // A late exit event must not clear the poisoned ownership.
    fake.forceExit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(manager.start()).rejects.toBeInstanceOf(ContainedEngineLifecycleError);
    expect(readConfigCalls).toBe(readsBefore);
    expect(spawnCalls).toHaveLength(spawnsBefore);
    // The terminal stop reservation is retained: stop reports the same failure.
    await expect(manager.stop()).rejects.toBeInstanceOf(ContainedEngineLifecycleError);
  });
});

/** Deterministic virtual child: records signals and emits exit on demand. */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly signals: string[] = [];
  readonly killSignaled = false;
  #immortal: boolean;

  constructor(options: { immortal?: boolean } = {}) {
    super();
    this.#immortal = options.immortal ?? false;
  }

  kill(signal?: string): boolean {
    this.signals.push(signal ?? "SIGTERM");
    if (!this.#immortal && (signal === undefined || signal === "SIGKILL")) {
      setTimeout(() => this.forceExit(), 0);
    }
    return true;
  }

  forceExit(): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = "SIGKILL";
    this.emit("exit");
    this.emit("close");
  }
}
