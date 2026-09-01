import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireWorkspaceLock, WorkspaceLockedError, workspaceLockPath } from "../workspaceLock.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function lockNamespaceEntries(directory: string): Promise<readonly string[]> {
  return (await fs.readdir(workspaceLockPath(directory))).sort();
}

async function writeStaleCandidate(directory: string, mode = 0o600): Promise<string> {
  const namespace = workspaceLockPath(directory);
  await fs.mkdir(namespace, { mode: 0o700 });
  const pid = 2_147_483_647;
  const publication = randomUUID();
  const candidate = path.join(namespace, `owner.${pid}.${publication}`);
  await fs.writeFile(
    candidate,
    `${JSON.stringify({
      version: 2,
      pid,
      token: "00000000-0000-4000-8000-000000000000",
      publication,
    })}\n`,
    { mode }
  );
  return candidate;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("exact workspace instance lock", () => {
  it("prepares a missing parent chain without creating the workspace itself", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "missing", "nested", "workspace");

    const lock = await acquireWorkspaceLock(directory);
    const canonicalParent = await fs.realpath(path.dirname(directory));
    const canonicalWorkspace = path.join(canonicalParent, path.basename(directory));
    const namespace = workspaceLockPath(canonicalWorkspace);
    expect((await fs.stat(canonicalParent)).isDirectory()).toBe(true);
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(path.dirname(lock.path)).toBe(namespace);
    expect(path.basename(lock.path)).toMatch(/^owner\.\d+\.[0-9a-f-]{36}$/i);
    expect((await fs.stat(namespace)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(lock.path)).mode & 0o777).toBe(0o600);

    await lock.release();
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(namespace)).toEqual([]);
  });

  it("creates a 0600 lock, refuses a concurrent owner, and releases idempotently", async () => {
    const directory = await temporaryDirectory();
    const first = await acquireWorkspaceLock(directory);
    const namespace = path.join(
      await fs.realpath(path.dirname(directory)),
      path.basename(workspaceLockPath(directory))
    );
    expect(path.dirname(first.path)).toBe(namespace);
    expect(path.basename(first.path)).toMatch(/^owner\.\d+\.[0-9a-f-]{36}$/i);
    expect((await fs.stat(namespace)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(first.path)).mode & 0o777).toBe(0o600);
    await expect(acquireWorkspaceLock(directory)).rejects.toBeInstanceOf(WorkspaceLockedError);
    await first.release();
    await first.release();
    await expect(fs.stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lockNamespaceEntries(directory)).toEqual([]);
  });

  it("recovers only a valid owned stale candidate and repairs namespace and record modes", async () => {
    const directory = await temporaryDirectory();
    const stale = await writeStaleCandidate(directory, 0o644);
    await fs.chmod(workspaceLockPath(directory), 0o755);
    const lock = await acquireWorkspaceLock(directory, { processAlive: () => false });
    await expect(fs.lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(workspaceLockPath(directory))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(lock.path)).mode & 0o777).toBe(0o600);
    await lock.release();
    expect(await lockNamespaceEntries(directory)).toEqual([]);
  });

  it("recovers a lock abandoned by a process that exited without orderly release", async () => {
    const directory = await temporaryDirectory();
    const moduleUrl = new URL("../workspaceLock.ts", import.meta.url).href;
    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `const { acquireWorkspaceLock } = await import(${JSON.stringify(moduleUrl)}); await acquireWorkspaceLock(${JSON.stringify(directory)});`,
      ],
      { cwd: process.cwd() }
    );

    expect((await lockNamespaceEntries(directory)).filter((name) => name.startsWith("owner."))).toHaveLength(1);
    const recovered = await acquireWorkspaceLock(directory);
    await recovered.release();
    expect(await lockNamespaceEntries(directory)).toEqual([]);
  });

  it("fails closed on malformed namespace and candidate entries", async () => {
    const directory = await temporaryDirectory();
    const filename = workspaceLockPath(directory);
    await fs.writeFile(filename, "not-json\n", { mode: 0o600 });
    await expect(acquireWorkspaceLock(directory, { processAlive: () => false })).rejects.toBeInstanceOf(
      WorkspaceLockedError
    );

    await fs.unlink(filename);
    const outside = path.join(directory, "outside");
    await fs.writeFile(outside, "private\n", { mode: 0o600 });
    await fs.symlink(outside, filename);
    await expect(acquireWorkspaceLock(directory, { processAlive: () => false })).rejects.toBeInstanceOf(
      WorkspaceLockedError
    );
    expect(await fs.readFile(outside, "utf8")).toBe("private\n");

    await fs.unlink(filename);
    const initial = await acquireWorkspaceLock(directory);
    await initial.release();
    const publication = randomUUID();
    await fs.writeFile(path.join(filename, `owner.123.${publication}`), "not-json\n", { mode: 0o600 });
    await expect(acquireWorkspaceLock(directory, { processAlive: () => false })).rejects.toBeInstanceOf(
      WorkspaceLockedError
    );
  });

  it("does not unlink a lock that changed ownership before release", async () => {
    const directory = await temporaryDirectory();
    const lock = await acquireWorkspaceLock(directory);
    const [, rawPid, publication] = /^owner\.(\d+)\.([0-9a-f-]{36})$/i.exec(path.basename(lock.path))!;
    const replacement = `${JSON.stringify({
      version: 2,
      pid: Number(rawPid),
      token: "11111111-1111-4111-8111-111111111111",
      publication,
    })}\n`;
    const originalRename = fs.rename.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(source) === lock.path && !replaced) {
        replaced = true;
        await fs.unlink(lock.path);
        await fs.writeFile(lock.path, replacement, { mode: 0o600 });
      }
      return originalRename(source, destination);
    });

    await expect(lock.release()).rejects.toBeInstanceOf(WorkspaceLockedError);
    expect(await fs.readFile(lock.path, "utf8")).toBe(replacement);
    expect((await lockNamespaceEntries(directory)).filter((name) => name.startsWith(".reap."))).toEqual([]);
  });

  it("restores a live candidate found inside a dead reaper without unlinking it", async () => {
    const directory = await temporaryDirectory();
    const initial = await acquireWorkspaceLock(directory);
    await initial.release();
    const namespace = workspaceLockPath(directory);
    const publication = randomUUID();
    const candidateName = `owner.${process.pid}.${publication}`;
    const candidate = path.join(namespace, candidateName);
    const reaper = path.join(namespace, `.reap.2147483647.${randomUUID()}.ABC123`);
    await fs.mkdir(reaper, { mode: 0o700 });
    const payload = `${JSON.stringify({
      version: 2,
      pid: process.pid,
      token: "22222222-2222-4222-8222-222222222222",
      publication,
    })}\n`;
    await fs.writeFile(path.join(reaper, candidateName), payload, { mode: 0o600 });

    await expect(acquireWorkspaceLock(directory)).rejects.toBeInstanceOf(WorkspaceLockedError);
    expect(await fs.readFile(candidate, "utf8")).toBe(payload);
    await expect(fs.lstat(reaper)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes an interrupted two-link candidate restoration and reaps the stale owner", async () => {
    const directory = await temporaryDirectory();
    const initial = await acquireWorkspaceLock(directory);
    await initial.release();
    const namespace = workspaceLockPath(directory);
    const stalePid = 2_147_483_647;
    const publication = randomUUID();
    const candidateName = `owner.${stalePid}.${publication}`;
    const candidate = path.join(namespace, candidateName);
    const reaper = path.join(namespace, `.reap.${stalePid}.${randomUUID()}.ABC123`);
    const moved = path.join(reaper, candidateName);
    await fs.mkdir(reaper, { mode: 0o700 });
    await fs.writeFile(
      moved,
      `${JSON.stringify({
        version: 2,
        pid: stalePid,
        token: "33333333-3333-4333-8333-333333333333",
        publication,
      })}\n`,
      { mode: 0o600 }
    );
    await fs.link(moved, candidate);
    expect((await fs.stat(moved)).nlink).toBe(2);

    const recovered = await acquireWorkspaceLock(directory, { processAlive: () => false });
    await expect(fs.lstat(reaper)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lockNamespaceEntries(directory)).toEqual([path.basename(recovered.path)]);
    await recovered.release();
  });

  it("finishes an interrupted two-link empty-temp restoration before cleanup", async () => {
    const directory = await temporaryDirectory();
    const initial = await acquireWorkspaceLock(directory);
    await initial.release();
    const namespace = workspaceLockPath(directory);
    const stalePid = 2_147_483_647;
    const publication = randomUUID();
    const tempName = `.tmp.${stalePid}.${publication}`;
    const temporary = path.join(namespace, tempName);
    const reaper = path.join(namespace, `.reap.${stalePid}.${randomUUID()}.ABC123`);
    const moved = path.join(reaper, tempName);
    await fs.mkdir(reaper, { mode: 0o700 });
    await fs.writeFile(moved, "", { mode: 0o600 });
    await fs.link(moved, temporary);
    expect((await fs.stat(moved)).nlink).toBe(2);

    const recovered = await acquireWorkspaceLock(directory, { processAlive: () => false });
    await expect(fs.lstat(reaper)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lockNamespaceEntries(directory)).toEqual([path.basename(recovered.path)]);
    await recovered.release();
  });

  it("fails closed on an unpaired two-link reaper entry", async () => {
    const directory = await temporaryDirectory();
    const initial = await acquireWorkspaceLock(directory);
    await initial.release();
    const namespace = workspaceLockPath(directory);
    const stalePid = 2_147_483_647;
    const publication = randomUUID();
    const candidateName = `owner.${stalePid}.${publication}`;
    const reaper = path.join(namespace, `.reap.${stalePid}.${randomUUID()}.ABC123`);
    const moved = path.join(reaper, candidateName);
    const unrelated = path.join(directory, "unrelated-link");
    await fs.mkdir(reaper, { mode: 0o700 });
    await fs.writeFile(
      moved,
      `${JSON.stringify({
        version: 2,
        pid: stalePid,
        token: "44444444-4444-4444-8444-444444444444",
        publication,
      })}\n`,
      { mode: 0o600 }
    );
    await fs.link(moved, unrelated);

    await expect(acquireWorkspaceLock(directory, { processAlive: () => false })).rejects.toBeInstanceOf(
      WorkspaceLockedError
    );
    expect((await fs.stat(moved)).nlink).toBe(2);
    await expect(fs.lstat(path.join(namespace, candidateName))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows orderly release to retry after a transient quarantine rename failure", async () => {
    const directory = await temporaryDirectory();
    const lock = await acquireWorkspaceLock(directory);
    const originalRename = fs.rename.bind(fs);
    let failedOnce = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(source) === lock.path && !failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error("simulated transient rename failure"), { code: "EBUSY" });
      }
      return originalRename(source, destination);
    });

    await lock.release().catch(() => undefined);
    await expect(fs.lstat(lock.path)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await lock.release();
    await expect(fs.lstat(lock.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lockNamespaceEntries(directory)).toEqual([]);
  });

  it("serializes stale recovery against a child-process contender while the candidate move is deferred", async () => {
    const directory = await temporaryDirectory();
    const stale = await fs.realpath(await writeStaleCandidate(directory));
    const moduleUrl = new URL("../workspaceLock.ts", import.meta.url).href;
    const originalRename = fs.rename.bind(fs);
    let enteredResolve!: () => void;
    let resumeResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeResolve = resolve;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(source) === stale) {
        enteredResolve();
        await resume;
      }
      return originalRename(source, destination);
    });

    const acquiring = acquireWorkspaceLock(directory);
    await entered;
    try {
      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `const { acquireWorkspaceLock } = await import(${JSON.stringify(moduleUrl)});
           try { await acquireWorkspaceLock(${JSON.stringify(directory)}); process.exitCode = 9; }
           catch (error) { if (error?.code !== "WORKSPACE_LOCKED") throw error; }`,
        ],
        { cwd: process.cwd() }
      );
    } finally {
      resumeResolve();
    }

    const owner = await acquiring;
    expect((await lockNamespaceEntries(directory)).filter((name) => name.startsWith("owner."))).toEqual([
      path.basename(owner.path),
    ]);
    await owner.release();
    expect(await lockNamespaceEntries(directory)).toEqual([]);
  });

  it("recovers crashes immediately before and after atomic candidate publication", async () => {
    const moduleUrl = new URL("../workspaceLock.ts", import.meta.url).href;
    for (const phase of ["before", "after"] as const) {
      const directory = await temporaryDirectory();
      const exitCode = phase === "before" ? 71 : 72;
      const result = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `const fs = (await import("node:fs/promises")).default;
           const originalRename = fs.rename.bind(fs);
           fs.rename = async (source, destination) => {
             const sourceName = String(source).split("/").at(-1) ?? "";
             const destinationName = String(destination).split("/").at(-1) ?? "";
             if (sourceName.startsWith(".tmp.") && destinationName.startsWith("owner.")) {
               ${phase === "after" ? "await originalRename(source, destination);" : ""}
               process.exit(${exitCode});
             }
             return originalRename(source, destination);
           };
           const { acquireWorkspaceLock } = await import(${JSON.stringify(moduleUrl)});
           await acquireWorkspaceLock(${JSON.stringify(directory)});`,
        ],
        { cwd: process.cwd() }
      ).catch((error: unknown) => error as { code: number });
      expect(result).toMatchObject({ code: exitCode });
      expect(await lockNamespaceEntries(directory)).toSatisfy((entries: readonly string[]) =>
        entries.some((name) => name.startsWith(phase === "before" ? ".tmp." : "owner."))
      );

      const recovered = await acquireWorkspaceLock(directory);
      await recovered.release();
      expect(await lockNamespaceEntries(directory)).toEqual([]);
    }
  });
});
