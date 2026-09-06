/**
 * Shared plumbing for the product-acceptance harness.
 *
 * Conventions inherited from scripts/e2e/fixtures:
 * - never log request bodies, prompts, tokens, credentials, or provider
 *   error text; failure records carry stable codes only;
 * - every spawned process is owned (tracked pid) and stopped with SIGTERM
 *   first, escalating to SIGKILL only against that exact pid;
 * - no arbitrary sleeps to hide races: bounded polling with deadlines.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, appendFile } from "node:fs/promises";

export const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `probe` until it returns truthy or the deadline passes. */
export async function pollUntil(probe, { deadlineMs, intervalMs = 100 }) {
  const until = Date.now() + deadlineMs;
  let lastError;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= until) {
      if (lastError) throw lastError;
      return false;
    }
    await sleep(intervalMs);
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/**
 * Spawn an owned child with an explicit minimal environment. The child's
 * stdout lines are routed to `onStdoutLine` (framing by the caller) and its
 * stderr keeps only a bounded, content-free tail for diagnostics.
 */
export function spawnOwned({ command, args, cwd, env, onStdoutLine, label }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const entry = {
    label: label ?? "child",
    child,
    pid: child.pid,
    stderrTail: [],
    exitRecord: null,
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (piece) => {
    for (const line of String(piece).split("\n")) {
      // Bound the retained diagnostic length; never echo bodies wholesale.
      if (line.trim()) entry.stderrTail.push(line.slice(0, 160));
    }
    if (entry.stderrTail.length > 40) entry.stderrTail.splice(0, entry.stderrTail.length - 40);
  });
  if (onStdoutLine) {
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (piece) => {
      buffer += piece;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) onStdoutLine(line);
      }
    });
  } else {
    child.stdout.resume();
  }
  child.on("exit", (code, signal) => {
    entry.exitRecord = { code, signal };
  });
  return entry;
}

/**
 * Request an orderly stop of exactly this child: SIGTERM first (stdin close
 * for stdio-protocol children), then SIGKILL only against the owned pid.
 */
export async function stopOwned(entry, { graceMs = 15_000, viaStdinClose = false } = {}) {
  const { child } = entry;
  let escalated = false;
  if (child.exitCode === null && child.signalCode === null) {
    if (viaStdinClose) child.stdin.end();
    else child.kill("SIGTERM");
  }
  const until = Date.now() + graceMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until) {
    await sleep(50);
  }
  if (child.exitCode === null && child.signalCode === null) {
    escalated = true;
    child.kill("SIGKILL");
    const hard = Date.now() + 5_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < hard) {
      await sleep(50);
    }
  }
  if (!entry.exitRecord && child.exitCode === null && child.signalCode === null) {
    // The exit event is the source of truth; fall back to liveness.
    entry.exitRecord = { code: null, signal: "PENDING" };
  }
  return {
    exited: entry.exitRecord ?? { code: child.exitCode, signal: child.signalCode },
    gone: !pidAlive(entry.pid),
    escalated,
    stderrTail: entry.stderrTail,
  };
}

/** Fetch JSON with a hard deadline; returns { status, body } (body may be null). */
export async function fetchJson(url, { timeoutMs = 10_000, headers, method = "GET", requestBody } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  let body = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
  return { status: response.status, body };
}

export class HarnessError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "HarnessError";
    this.code = code;
  }
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function writeText(file, text) {
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true, mode: 0o700 });
  await writeFile(file, text, "utf8");
}

export async function appendText(file, text) {
  await appendFile(file, text, "utf8");
}

export async function removeTree(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

export function assert(condition, code, detail) {
  if (!condition) throw new HarnessError(code, detail);
}

export function parseArgs(argv) {
  const parsed = { _: [] };
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) parsed[arg.slice(2)] = true;
      else parsed[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      parsed._.push(arg);
    }
  }
  return parsed;
}
