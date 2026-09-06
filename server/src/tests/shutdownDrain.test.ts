/**
 * Shutdown-drain regression: a raw SIGTERM racing live DuckDB dataset-worker
 * traffic must still produce an orderly, clean process exit.
 *
 * Product defect (reported by the E2E harness, documented in
 * `scripts/e2e/HARNESS.md`): SIGTERM within a few seconds of ledger/data-plane
 * traffic could abort the server in `duckdb.node` `AsyncWorker::OnWorkComplete`
 * during Node environment cleanup — an uncaught `Napi::Error` SIGABRT that
 * skips the orderly-shutdown completion and LEAKS the workspace instance-lock
 * owner record (plan 037). The harness gates its own shutdown on the product's
 * readiness surface; this test deliberately does NOT use that gate: it sends a
 * raw SIGTERM while an uncancelled health probe and a real tabular ingestion
 * register are in flight inside the real dataset worker, exactly the scenario
 * the defect describes.
 *
 * The server runs as a subprocess (the abort happens at process teardown, so
 * an in-process server cannot prove the product's exit behavior), composed
 * with the harness' production env contract minus any quiesce mitigation.
 *
 * Runs only under `vitest.integration.config.ts` (serialized native stores).
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { workspaceLockPath } from "../workspaceLock.js";

type OwnedChild = ChildProcessByStdio<null, Readable, Readable>;

const SERVER_READY_TIMEOUT_MS = 90_000;
const PROVIDER_READY_TIMEOUT_MS = 30_000;
// ~14 MB tabular fixture: large enough that the ingestion register RPC is
// executing natively inside the dataset worker when SIGTERM arrives.
const UPLOAD_ROWS = 600_000;
const SIGTERM_GAP_MS = 30;

const ownedChildren: { child: OwnedChild; pid: number }[] = [];
const temporaryRoots: string[] = [];

async function disposeOwnedChildren(): Promise<void> {
  for (const { child, pid } of ownedChildren.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited between the check and the kill.
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      setTimeout(resolve, 10_000).unref();
    });
    // Proof of absence for the tracked pid, not just the handle.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      if (Date.now() >= deadline) throw new Error(`owned pid ${pid} never died`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

afterEach(async () => {
  await disposeOwnedChildren();
});

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function spawnOwned(args: { command: string; args: string[]; cwd: string; env: Record<string, string> }): OwnedChild {
  const child = spawn(args.command, args.args, {
    cwd: args.cwd,
    env: args.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownedChildren.push({ child, pid: child.pid as number });
  return child;
}

function collectStderr(child: OwnedChild): () => string {
  let text = "";
  child.stderr.on("data", (piece: Buffer) => {
    text += String(piece);
    if (text.length > 64_000) text = text.slice(-32_000);
  });
  return () => text;
}

function waitForStdoutLine(
  child: OwnedChild,
  match: (parsed: Record<string, unknown>) => boolean,
  label: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const deadline = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const onData = (piece: Buffer) => {
      buffer += String(piece);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (match(parsed)) {
          clearTimeout(deadline);
          child.stdout.off("data", onData);
          resolve(parsed);
          return;
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      reject(new Error(`process died before ${label} (code=${String(code)} signal=${String(signal)})`));
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listLockOwners(namespacePath: string): Promise<string[]> {
  try {
    return (await fs.readdir(namespacePath)).filter((entry) => entry.startsWith("owner."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function tabularCsv(rows: number): string {
  const parts = ["date,category,amount\n"];
  for (let index = 0; index < rows; index += 1) {
    parts.push(`2026-0${(index % 9) + 1}-0${(index % 28) + 1},cat-${index % 97},${(index % 1000) + 0.5}\n`);
  }
  return parts.join("");
}

describe("dataset-worker shutdown drain", () => {
  it("exits clean with the lock released when SIGTERM races in-flight DuckDB work", { timeout: 240_000 }, async () => {
    const repoRoot = path.resolve(process.cwd(), "..");
    const providerScript = path.join(repoRoot, "scripts", "e2e", "fixtures", "openai-provider.mjs");
    expect(await fs.stat(providerScript).then((stat) => stat.isFile())).toBe(true);

    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-shutdown-drain-")));
    temporaryRoots.push(root);
    const dataDir = path.join(root, "workspace");
    await fs.mkdir(dataDir, { recursive: true });

    // Scripted model provider (embeddings for the ingestion path).
    const provider = spawnOwned({
      command: process.execPath,
      args: [providerScript],
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const providerReady = await waitForStdoutLine(
      provider,
      (parsed) => parsed.protocol === "borealis-e2e-fixture" && typeof parsed.origin === "string",
      "provider ready line",
      PROVIDER_READY_TIMEOUT_MS
    );
    const providerOrigin = String(providerReady.origin);

    // The real production server composition over the tsx entry (identical
    // source to dist), harness env contract, no JWT_SECRET, no quiesce gate.
    const serverEntry = path.join(process.cwd(), "src", "index.ts");
    const server = spawnOwned({
      command: process.execPath,
      args: ["--import", "tsx", serverEntry],
      // cwd stays inside the server package so the dataset worker thread's
      // `--import tsx` execArgv resolves; no durable state lives in cwd.
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? os.homedir(),
        LANG: "en_US.UTF-8",
        NODE_ENV: "production",
        BOREALIS_DATA_DIR: dataDir,
        HOST: "127.0.0.1",
        PORT: "0",
        LLM_BASE_URL: providerOrigin,
        LLM_CHAT_MODEL: "fixture-chat-v1",
        LLM_EMBED_MODEL: "fixture-embed-v1",
        EMBEDDING_DIM: "64",
      },
    });
    const serverStderr = collectStderr(server);
    const listening = await waitForStdoutLine(
      server,
      (parsed) => parsed.msg === "Borealis server listening" && Number.isSafeInteger(parsed.port),
      "server listening line",
      SERVER_READY_TIMEOUT_MS
    );
    const origin = `http://127.0.0.1:${String(listening.port)}`;

    const register = await fetch(`${origin}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "shutdown-drain@borealis.test", password: "borealis-shutdown-drain-pass" }),
    });
    expect(register.status).toBeLessThan(300);
    const { token } = (await register.json()) as { token?: string };
    expect(typeof token).toBe("string");

    // 1. Fire an authenticated health probe WITHOUT awaiting it: its
    //    data_service probe performs real DuckDB open/query/close work in
    //    the worker and nothing on the shutdown path cancels it.
    void fetch(`${origin}/api/health`, { headers: { Authorization: `Bearer ${String(token)}` } }).catch(
      () => undefined
    );

    // 2. Upload a real (large) tabular source; the durable row is reserved
    //    and the ingestion engine begins the register RPC immediately.
    const form = new FormData();
    form.append("file", new Blob([tabularCsv(UPLOAD_ROWS)], { type: "text/csv" }), "drain.csv");
    const upload = await fetch(`${origin}/api/sources/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${String(token)}` },
      body: form,
    });
    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()) as { id?: string; processing?: boolean };
    expect(typeof uploaded.id).toBe("string");
    expect(uploaded.processing).toBe(true);

    // 3. Raw SIGTERM while the health probe and the ingestion register are
    //    still executing inside the dataset worker — the exact defect
    //    scenario, with no harness quiesce gate.
    await new Promise((resolve) => setTimeout(resolve, SIGTERM_GAP_MS));
    server.kill("SIGTERM");

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      server.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const stderr = serverStderr();

    // The abort skipped the ack and leaked the lock; the fix must make the
    // process exit through the orderly path instead.
    expect(
      { code: exit.code, signal: exit.signal },
      `server aborted instead of exiting orderly; stderr tail: ${stderr.slice(-4000)}`
    ).toEqual({ code: 0, signal: null });
    expect(stderr).not.toMatch(/Napi::Error|uncaught exception|libc\+\+abi/);

    // Plan 037: the workspace lock owner record must be gone.
    expect(await listLockOwners(workspaceLockPath(dataDir))).toEqual([]);
    expect(pidAlive(server.pid as number)).toBe(false);
  });
});
