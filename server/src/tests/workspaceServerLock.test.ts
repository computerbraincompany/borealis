import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initDb: vi.fn(),
  closeDb: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
  shutdownActiveRuns: vi.fn(),
  startIngestionWorkers: vi.fn(),
  stopIngestionWorkers: vi.fn(),
  restoreDatasets: vi.fn(),
  shutdownDatasetWorker: vi.fn(),
  initializeRuntimeSettings: vi.fn(),
  closeRuntimeSettings: vi.fn(),
  automationStart: vi.fn(),
  automationStop: vi.fn(),
}));

vi.mock("../db.js", () => ({ initDb: mocks.initDb, closeDb: mocks.closeDb }));
vi.mock("../chatRuns.js", () => ({
  recoverInterruptedRuns: mocks.recoverInterruptedRuns,
  shutdownActiveRuns: mocks.shutdownActiveRuns,
}));
vi.mock("../ingest.js", () => ({
  startIngestionWorkers: mocks.startIngestionWorkers,
  stopIngestionWorkers: mocks.stopIngestionWorkers,
  restoreDatasets: mocks.restoreDatasets,
}));
vi.mock("../data/datasets.js", () => ({ shutdownDatasetWorker: mocks.shutdownDatasetWorker }));
vi.mock("../runtimeSettings.js", () => ({
  initializeRuntimeSettings: mocks.initializeRuntimeSettings,
  closeRuntimeSettings: mocks.closeRuntimeSettings,
}));
vi.mock("../automationRuntime.js", () => ({
  automationRunner: () => ({ start: mocks.automationStart, stop: mocks.automationStop }),
}));
vi.mock("../routes.js", () => ({ routes: async (_app: FastifyInstance) => undefined }));

import { config } from "../config.js";
import { startBorealisServer } from "../serverApp.js";
import { acquireWorkspaceLock, WorkspaceLockedError, workspaceLockPath } from "../workspaceLock.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function runLockedStartup(options: {
  readonly workspace: string;
  readonly sqlitePath: string;
  readonly lanceDirectory: string;
  readonly uploadDirectory: string;
  readonly reportDirectory: string;
  readonly containedDirectory: string;
  readonly jwtSecretFile: string;
}): Promise<void> {
  const serverAppUrl = new URL("../serverApp.ts", import.meta.url).href;
  const tsxBin = path.resolve("node_modules", ".bin", "tsx");
  const script = `import(${JSON.stringify(serverAppUrl)}).then(async ({ startBorealisServer }) => {
    try {
      await startBorealisServer({ desktop: false, host: "127.0.0.1", port: 0, logger: false });
      process.exitCode = 9;
    } catch (error) {
      if (error?.code !== "WORKSPACE_LOCKED") throw error;
      process.stdout.write("WORKSPACE_LOCKED");
    }
  });`;
  const { stdout } = await execFileAsync(tsxBin, ["--eval", script], {
    env: {
      PATH: process.env.PATH,
      BOREALIS_DESKTOP: "1",
      BOREALIS_DATA_DIR: options.workspace,
      SQLITE_PATH: options.sqlitePath,
      LANCEDB_DIR: options.lanceDirectory,
      UPLOAD_DIR: options.uploadDirectory,
      REPORT_DIR: options.reportDirectory,
      CONTAINED_DIR: options.containedDirectory,
      JWT_SECRET_FILE: options.jwtSecretFile,
    },
  });
  expect(stdout).toBe("WORKSPACE_LOCKED");
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.initDb.mockResolvedValue(undefined);
  mocks.closeDb.mockResolvedValue(undefined);
  mocks.recoverInterruptedRuns.mockResolvedValue(0);
  mocks.shutdownActiveRuns.mockResolvedValue(0);
  mocks.startIngestionWorkers.mockResolvedValue(undefined);
  mocks.stopIngestionWorkers.mockResolvedValue(undefined);
  mocks.restoreDatasets.mockResolvedValue({ restored: 0, failed: 0 });
  mocks.shutdownDatasetWorker.mockResolvedValue(undefined);
  mocks.initializeRuntimeSettings.mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("server workspace lock lifecycle", () => {
  it("does not mutate durable paths before a second process is rejected by the exact lock", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-server-lock-no-touch-"));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, "workspace");
    await fs.mkdir(workspace);
    const paths = {
      workspace,
      sqlitePath: path.join(workspace, "runtime", "sqlite", "borealis.sqlite"),
      lanceDirectory: path.join(workspace, "runtime", "lancedb"),
      uploadDirectory: path.join(workspace, "runtime", "uploads"),
      reportDirectory: path.join(workspace, "runtime", "reports"),
      containedDirectory: path.join(workspace, "runtime", "models"),
      jwtSecretFile: path.join(workspace, "secrets", "jwt.secret"),
    };
    const pathsThatMustStayMissing = [
      path.dirname(paths.sqlitePath),
      paths.lanceDirectory,
      paths.uploadDirectory,
      paths.reportDirectory,
      paths.containedDirectory,
      paths.jwtSecretFile,
    ];
    const lock = await acquireWorkspaceLock(workspace);
    try {
      await runLockedStartup(paths);
      for (const candidate of pathsThatMustStayMissing) {
        await expect(fs.lstat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
      }

      const secret = "existing-jwt-secret-with-at-least-thirty-two-characters\n";
      await fs.mkdir(path.dirname(paths.jwtSecretFile), { recursive: true });
      await fs.writeFile(paths.jwtSecretFile, secret, { mode: 0o644 });
      await fs.chmod(paths.jwtSecretFile, 0o644);

      await runLockedStartup(paths);
      expect(await fs.readFile(paths.jwtSecretFile, "utf8")).toBe(secret);
      expect((await fs.stat(paths.jwtSecretFile)).mode & 0o777).toBe(0o644);
      for (const candidate of pathsThatMustStayMissing.slice(0, -1)) {
        await expect(fs.lstat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await lock.release();
    }
  });

  it("holds the exact lock while serving and releases it after orderly shutdown", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-server-lock-"));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, "workspace");
    await fs.mkdir(workspace);
    const previousStorageDirectory = config.storageDir;
    config.storageDir = workspace;
    try {
      const server = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      const namespace = workspaceLockPath(workspace);
      expect((await fs.stat(namespace)).mode & 0o777).toBe(0o700);
      const owner = (await fs.readdir(namespace)).find((name) => name.startsWith("owner."));
      expect(owner).toBeDefined();
      expect((await fs.stat(path.join(namespace, owner!))).mode & 0o777).toBe(0o600);
      await expect(acquireWorkspaceLock(workspace)).rejects.toBeInstanceOf(WorkspaceLockedError);

      await server.close();
      await server.close();
      expect(await fs.readdir(namespace)).toEqual([]);
      const nextOwner = await acquireWorkspaceLock(workspace);
      await nextOwner.release();
    } finally {
      config.storageDir = previousStorageDirectory;
    }
  });

  it("releases the exact lock when startup fails after acquisition", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-server-lock-failure-"));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, "workspace");
    await fs.mkdir(workspace);
    const previousStorageDirectory = config.storageDir;
    config.storageDir = workspace;
    mocks.initDb.mockRejectedValueOnce(new Error("simulated startup failure"));
    try {
      await expect(startBorealisServer({ host: "127.0.0.1", port: 0, logger: false })).rejects.toThrow(
        "simulated startup failure"
      );
      expect(await fs.readdir(workspaceLockPath(workspace))).toEqual([]);
      const nextOwner = await acquireWorkspaceLock(workspace);
      await nextOwner.release();
    } finally {
      config.storageDir = previousStorageDirectory;
    }
  });
});
