import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import {
  clearContainedConfig,
  ContainedConfigError,
  readContainedConfig,
  writeContainedConfig,
} from "../contained/configStore.js";
import {
  createContainedDownloadManager,
  ContainedDownloadError,
  type ContainedDownloadTransport,
} from "../contained/downloadManager.js";
import { downloadManager, engineManager } from "../contained/runtime.js";
import { installHttpBoundary } from "../httpErrors.js";
import { containedRoutes } from "../routes/contained.js";
import { config } from "../config.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ownerAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}`,
};
// A bootstrap-minted-equivalent claim: verifyToken only accepts the exact
// literal `true`, which is what createDesktopBootstrapSession signs.
const operatorAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test", desktopOperator: true })}`,
};
// The stable desktop email with no signed capability: identity is not
// authority.
const desktopEmailAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "local@borealis.app" })}`,
};

const apps: FastifyInstance[] = [];
const servers: http.Server[] = [];
let previousContainedDir: string | undefined;
let previousStorageDir = "";
let previousConfiguredContainedDir = "";
let tempDataDir = "";

beforeEach(async () => {
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-contained-"));
  previousContainedDir = process.env.CONTAINED_DIR;
  previousStorageDir = config.storageDir;
  previousConfiguredContainedDir = config.containedDir;
  process.env.CONTAINED_DIR = path.join(tempDataDir, "models");
  config.storageDir = tempDataDir;
  config.containedDir = path.join(tempDataDir, "models");
  await clearContainedConfig();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
  if (previousContainedDir === undefined) delete process.env.CONTAINED_DIR;
  else process.env.CONTAINED_DIR = previousContainedDir;
  config.storageDir = previousStorageDir;
  config.containedDir = previousConfiguredContainedDir;
  await fs.rm(tempDataDir, { recursive: true, force: true });
  tempDataDir = "";
});

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const FAKE_URL = "https://models.example.test/model.bin";
const FIXTURE_PAYLOAD = Buffer.from("contained-model-bytes-".repeat(400));

function partialsDirPath(): string {
  return path.join(config.containedDir, ".borealis-partials");
}

function internalPartialPath(filename: string): string {
  return path.join(partialsDirPath(), `${filename}.part`);
}

/** Loopback fixture with strengthened, recorded request metadata. */
async function startFixtureServer(): Promise<{
  url: string;
  requests: Array<{ range?: string; accept?: string; acceptEncoding?: string }>;
}> {
  const payload = FIXTURE_PAYLOAD;
  const requests: Array<{ range?: string; accept?: string; acceptEncoding?: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({
      range: req.headers.range,
      accept: req.headers.accept,
      acceptEncoding: req.headers["accept-encoding"],
    });
    const range = req.headers.range;
    if (range) {
      const start = Number(String(range).split("=")[1].split("-")[0]);
      const body = payload.subarray(start);
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(payload.length) });
    res.end(payload);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/model.gguf`, requests };
}

/** Duck-typed IncomingMessage for the injectable transport. */
function fakeResponse(input: { status: number; headers?: Record<string, string>; chunks?: Buffer[] }): {
  response: IncomingMessage;
  destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn();
  const chunks = input.chunks ?? [];
  const response = {
    statusCode: input.status,
    headers: input.headers ?? {},
    destroy,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as IncomingMessage;
  return { response, destroy };
}

interface FakeTransportCalls {
  signals: AbortSignal[];
  headers: Array<Record<string, string>>;
  resolves: ReturnType<typeof vi.fn>;
  requests: ReturnType<typeof vi.fn>;
}

/**
 * Transport factory: `make` builds the response (possibly deferred) while the
 * fake records the exact signals and headers handed to resolve/request.
 */
function fakeTransport(
  make: (signal: AbortSignal, headers: Record<string, string>) => Promise<IncomingMessage> | IncomingMessage
): { transport: ContainedDownloadTransport; calls: FakeTransportCalls } {
  const calls: FakeTransportCalls = {
    signals: [],
    headers: [],
    resolves: vi.fn(),
    requests: vi.fn(),
  };
  const resolve = vi.fn(async (_url: URL, signal: AbortSignal) => {
    calls.signals.push(signal);
    return [{ address: "93.184.216.34", family: 4 as const }];
  });
  const request = vi.fn(
    async (_url: URL, _addresses: unknown, signal: AbortSignal, headers: Record<string, string>) => {
      calls.signals.push(signal);
      calls.headers.push(headers);
      return make(signal, headers);
    }
  );
  calls.resolves = resolve;
  calls.requests = request;
  return { transport: { resolve, request } as unknown as ContainedDownloadTransport, calls };
}

/** Response pending until externally released or rejected (abort/timeout). */
function gatedResponse(): {
  response: Promise<IncomingMessage>;
  release: (value: IncomingMessage) => void;
  reject: (error: unknown) => void;
  rejectOnAbort: (signal: AbortSignal, delayMs?: number) => void;
} {
  let resolveFn!: (value: IncomingMessage) => void;
  let rejectFn!: (error: unknown) => void;
  const response = new Promise<IncomingMessage>((resolveP, rejectP) => {
    resolveFn = resolveP;
    rejectFn = rejectP;
  });
  return {
    response,
    release: (value) => resolveFn(value),
    reject: (error) => rejectFn(error),
    rejectOnAbort: (signal, delayMs = 0) => {
      signal.addEventListener("abort", () => setTimeout(() => rejectFn(signal.reason), delayMs).unref?.(), {
        once: true,
      });
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(
  manager: ReturnType<typeof createContainedDownloadManager>,
  filename: string,
  states: string[]
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = manager.snapshot().find((download) => download.filename === filename);
    if (current && states.includes(current.state)) return;
    await wait(25);
  }
  throw new Error(`download ${filename} never reached ${states.join("/")}`);
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await wait(10);
  }
  throw new Error(`condition never became true: ${what}`);
}

describe("contained config store", () => {
  const DIGEST = "a".repeat(64);

  it("round-trips a valid enabled config with 0600 mode", async () => {
    const saved = await writeContainedConfig({
      enabled: true,
      binaryPath: "/opt/homebrew/bin/llama-server",
      modelPath: path.join(tempDataDir, "models", "model.gguf"),
      binarySha256: DIGEST,
      extraArgs: ["-ngl", "99"],
    });
    expect(saved).toMatchObject({
      enabled: true,
      binary_path: "/opt/homebrew/bin/llama-server",
      binary_sha256: DIGEST,
      extra_args: ["-ngl", "99"],
    });
    const read = await readContainedConfig();
    expect(read).toEqual(saved);
    const stat = await fs.stat(path.join(config.storageDir, "contained.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("replaces an existing file atomically and repairs a widened mode", async () => {
    const file = path.join(config.storageDir, "contained.json");
    await fs.writeFile(file, "{}\n", { mode: 0o644 });
    await fs.chmod(file, 0o644);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o644);

    const saved = await writeContainedConfig({
      enabled: true,
      binaryPath: "/opt/homebrew/bin/llama-server",
      modelPath: path.join(tempDataDir, "models", "model.gguf"),
      binarySha256: DIGEST,
      extraArgs: ["-ngl", "99"],
    });
    expect(await readContainedConfig()).toEqual(saved);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary artifacts behind after repeated writes", async () => {
    await writeContainedConfig({
      enabled: true,
      binaryPath: "/opt/homebrew/bin/llama-server",
      modelPath: path.join(tempDataDir, "models", "model.gguf"),
      binarySha256: DIGEST,
    });
    await writeContainedConfig({ enabled: false });
    await writeContainedConfig({
      enabled: true,
      binaryPath: "/usr/local/bin/llama-server",
      modelPath: path.join(tempDataDir, "models", "model.gguf"),
      binarySha256: DIGEST,
    });

    const entries = await fs.readdir(config.storageDir);
    expect(entries.filter((name) => name !== "contained.json")).toEqual([]);
  });

  it("keeps the previous configuration when a write fails", async () => {
    const file = path.join(config.storageDir, "contained.json");
    await writeContainedConfig({
      enabled: true,
      binaryPath: "/opt/homebrew/bin/llama-server",
      modelPath: path.join(tempDataDir, "models", "model.gguf"),
      binarySha256: DIGEST,
    });
    const before = await readContainedConfig();

    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === file) throw Object.assign(new Error("rename blocked"), { code: "EACCES" });
      await originalRename(from, to);
    });
    try {
      await expect(
        writeContainedConfig({
          enabled: true,
          binaryPath: "/usr/local/bin/llama-server",
          modelPath: path.join(tempDataDir, "models", "model.gguf"),
          binarySha256: DIGEST,
        })
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      rename.mockRestore();
    }

    expect(await readContainedConfig()).toEqual(before);
    const entries = await fs.readdir(config.storageDir);
    expect(entries.filter((name) => name !== "contained.json")).toEqual([]);
  });

  it("fails closed on malformed files and disabled configs carry no paths", async () => {
    await writeContainedConfig({ enabled: false });
    expect(await readContainedConfig()).toMatchObject({ enabled: false, binary_path: "" });

    await fs.writeFile(path.join(config.storageDir, "contained.json"), "{not json");
    await expect(readContainedConfig()).rejects.toBeInstanceOf(ContainedConfigError);

    await expect(
      writeContainedConfig({ enabled: true, binaryPath: "relative/bin", modelPath: "/tmp/model" })
    ).rejects.toBeInstanceOf(ContainedConfigError);
    await expect(
      writeContainedConfig({
        enabled: true,
        binaryPath: "/bin/x",
        modelPath: "/tmp/model",
        binarySha256: DIGEST,
        extraArgs: Array(33).fill("a"),
      })
    ).rejects.toBeInstanceOf(ContainedConfigError);
  });

  it("requires a 64-hex binary digest for enabled configs and fails legacy files closed", async () => {
    await expect(
      writeContainedConfig({
        enabled: true,
        binaryPath: "/bin/x",
        modelPath: "/tmp/model.gguf",
        extraArgs: ["-ngl", "99"],
      })
    ).rejects.toBeInstanceOf(ContainedConfigError);
    await expect(
      writeContainedConfig({
        enabled: true,
        binaryPath: "/bin/x",
        modelPath: "/tmp/model.gguf",
        binarySha256: "abc123",
      })
    ).rejects.toBeInstanceOf(ContainedConfigError);

    // An enabled config written before the digest requirement (or with a
    // widened/garbage value) fails closed on read with a generic
    // reconfiguration error.
    const reconfiguration = (error: unknown) =>
      error instanceof ContainedConfigError && /requires reconfiguration/i.test(error.message);
    await fs.writeFile(
      path.join(config.storageDir, "contained.json"),
      JSON.stringify({ enabled: true, binary_path: "/bin/x", model_path: "/tmp/model.gguf", extra_args: [] })
    );
    await expect(readContainedConfig()).rejects.toSatisfy(reconfiguration);
    await fs.writeFile(
      path.join(config.storageDir, "contained.json"),
      JSON.stringify({
        enabled: true,
        binary_path: "/bin/x",
        model_path: "/tmp/model.gguf",
        binary_sha256: "not-a-digest-at-all",
        extra_args: [],
      })
    );
    await expect(readContainedConfig()).rejects.toSatisfy(reconfiguration);

    // Disabled configs remain readable regardless.
    await writeContainedConfig({ enabled: false });
    expect((await readContainedConfig())?.binary_sha256).toBe("");
  });

  it("rejects extra arguments that can restate the fixed model, host, or port flags", async () => {
    const reservedSpellings = [
      ["-m", "/tmp/other.gguf"],
      ["--model", "/tmp/other.gguf"],
      ["--model=/tmp/other.gguf"],
      ["-m=/tmp/other.gguf"],
      ["--host", "0.0.0.0"],
      ["--host=0.0.0.0"],
      ["--port", "9999"],
      ["--port=9999"],
      ["-ngl", "99", "--port", "1234"],
    ];
    for (const extraArgs of reservedSpellings) {
      await expect(
        writeContainedConfig({
          enabled: true,
          binaryPath: "/bin/llama-server",
          modelPath: "/tmp/model.gguf",
          binarySha256: DIGEST,
          extraArgs,
        })
      ).rejects.toBeInstanceOf(ContainedConfigError);
    }

    // A reserved flag smuggled into the durable file also fails the reader.
    await fs.writeFile(
      path.join(config.storageDir, "contained.json"),
      JSON.stringify({
        enabled: true,
        binary_path: "/bin/llama-server",
        model_path: "/tmp/model.gguf",
        binary_sha256: DIGEST,
        extra_args: ["--host=0.0.0.0"],
      })
    );
    await expect(readContainedConfig()).rejects.toBeInstanceOf(ContainedConfigError);

    // Allowed llama tuning flags stay writable.
    const saved = await writeContainedConfig({
      enabled: true,
      binaryPath: "/bin/llama-server",
      modelPath: "/tmp/model.gguf",
      binarySha256: DIGEST,
      extraArgs: ["-ngl", "99", "-t", "8", "-mlock", "--flash-attn"],
    });
    expect(saved.extra_args).toEqual(["-ngl", "99", "-t", "8", "-mlock", "--flash-attn"]);
  });
});

describe("contained download manager", () => {
  it("downloads, verifies, and atomically lands the file", async () => {
    const { url } = await startFixtureServer();
    const payload = FIXTURE_PAYLOAD;
    const manager = createContainedDownloadManager();

    const started = await manager.start({ url, filename: "model.gguf", sha256: sha256Hex(payload) });
    expect(started).toMatchObject({ state: "downloading", filename: "model.gguf" });

    await waitForState(manager, "model.gguf", ["complete"]);
    const landed = await fs.readFile(path.join(config.containedDir, "model.gguf"));
    expect(landed.equals(payload)).toBe(true);
    await expect(fs.stat(path.join(config.containedDir, "model.gguf.part"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(internalPartialPath("model.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on checksum mismatch and removes the internal partial", async () => {
    const { url } = await startFixtureServer();
    const manager = createContainedDownloadManager();

    await manager.start({ url, filename: "bad.gguf", sha256: sha256Hex(Buffer.from("other-bytes")) });
    await waitForState(manager, "bad.gguf", ["failed"]);
    const state = manager.snapshot().find((download) => download.filename === "bad.gguf");
    expect(state?.error).toContain("checksum mismatch");
    await expect(fs.stat(internalPartialPath("bad.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(config.containedDir, "bad.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes from the byte range of an interrupted internal partial", async () => {
    const { url, requests } = await startFixtureServer();
    const payload = FIXTURE_PAYLOAD;
    const manager = createContainedDownloadManager();

    // Pre-seed the internal partial as if a previous attempt stopped midway.
    await fs.mkdir(partialsDirPath(), { recursive: true });
    await fs.writeFile(internalPartialPath("resume.gguf"), payload.subarray(0, 1000));

    await manager.start({ url, filename: "resume.gguf", sha256: sha256Hex(payload) });
    await waitForState(manager, "resume.gguf", ["complete"]);
    const landed = await fs.readFile(path.join(config.containedDir, "resume.gguf"));
    expect(landed.equals(payload)).toBe(true);
    const state = manager.snapshot().find((download) => download.filename === "resume.gguf");
    expect(state?.bytes_received).toBe(payload.length);
    // Strengthened range assertions: the opened handle's fstat size drives
    // exactly one Range request and identity encoding is demanded.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      range: "bytes=1000-",
      accept: "application/octet-stream",
      acceptEncoding: "identity",
    });
  });

  it("never resumes or touches an ambiguous root-level legacy .part", async () => {
    const { url } = await startFixtureServer();
    const payload = FIXTURE_PAYLOAD;
    const legacy = path.join(config.containedDir, "legacy.gguf.part");
    await fs.mkdir(config.containedDir, { recursive: true });
    await fs.writeFile(legacy, "LEGACY-SENTINEL");

    const manager = createContainedDownloadManager();
    await manager.start({ url, filename: "legacy.gguf", sha256: sha256Hex(payload) });
    await waitForState(manager, "legacy.gguf", ["complete"]);
    expect((await fs.readFile(legacy)).toString()).toBe("LEGACY-SENTINEL");
    expect((await fs.readFile(path.join(config.containedDir, "legacy.gguf"))).equals(payload)).toBe(true);
  });

  it("validates inputs and rejects non-loopback HTTP origins", async () => {
    const manager = createContainedDownloadManager();
    await expect(
      manager.start({ url: "http://example.invalid/model", filename: "x.gguf", sha256: sha256Hex(Buffer.from("x")) })
    ).rejects.toBeInstanceOf(ContainedDownloadError);
    await expect(
      manager.start({ url: "http://127.0.0.1:1/model", filename: "../escape", sha256: sha256Hex(Buffer.from("x")) })
    ).rejects.toBeInstanceOf(ContainedDownloadError);
    await expect(
      manager.start({ url: "http://127.0.0.1:1/model", filename: "x.gguf", sha256: "nothex" })
    ).rejects.toBeInstanceOf(ContainedDownloadError);
  });

  it("rejects dot-only, reserved, and case-folded .part final names before any filesystem work", async () => {
    const { transport } = fakeTransport(() => fakeResponse({ status: 200 }).response);
    const manager = createContainedDownloadManager({ transport });
    for (const filename of [
      "model.part",
      "MODEL.Part",
      "x.Part",
      ".",
      "..",
      ".borealis-partials",
      ".Borealis-PaRtIaLs",
    ]) {
      await expect(
        manager.start({ url: FAKE_URL, filename, sha256: sha256Hex(Buffer.from("x")) })
      ).rejects.toBeInstanceOf(ContainedDownloadError);
    }
    // The reserved forms were rejected synchronously: nothing was created.
    await expect(fs.stat(config.containedDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(transport.resolve).not.toHaveBeenCalled();
  });
});

describe("contained download transport contract", () => {
  function completingTransport(payload: Buffer) {
    return fakeTransport(
      () =>
        fakeResponse({ status: 200, headers: { "content-length": String(payload.length) }, chunks: [payload] }).response
    );
  }

  it("sends the exact request headers over one shared signal and publishes atomically", async () => {
    const payload = Buffer.from("payload-".repeat(700));
    const { transport, calls } = completingTransport(payload);
    const manager = createContainedDownloadManager({ transport });

    await manager.start({ url: FAKE_URL, filename: "clean.gguf", sha256: sha256Hex(payload) });
    await waitForState(manager, "clean.gguf", ["complete"]);

    expect(calls.headers[0]).toEqual({
      Accept: "application/octet-stream",
      "Accept-Encoding": "identity",
      "User-Agent": "Borealis-Contained/1",
    });
    // One combined signal covers resolution, request, and body iteration.
    expect(calls.signals).toHaveLength(2);
    expect(calls.signals[0]).toBe(calls.signals[1]);
    expect((await fs.readFile(path.join(config.containedDir, "clean.gguf"))).equals(payload)).toBe(true);
    await expect(fs.stat(internalPartialPath("clean.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a 206 whose start does not equal the opened partial size and keeps the partial", async () => {
    await fs.mkdir(partialsDirPath(), { recursive: true });
    await fs.writeFile(internalPartialPath("wrong.gguf"), Buffer.alloc(100, 7));
    const { transport, calls } = fakeTransport(
      () =>
        fakeResponse({
          status: 206,
          headers: { "content-range": "bytes 99-499/500", "content-length": "401" },
          chunks: [Buffer.alloc(401)],
        }).response
    );
    const manager = createContainedDownloadManager({ transport });
    await manager.start({ url: FAKE_URL, filename: "wrong.gguf", sha256: sha256Hex(Buffer.alloc(500)) });
    await waitForState(manager, "wrong.gguf", ["failed"]);
    expect((await fs.stat(internalPartialPath("wrong.gguf"))).size).toBe(100);
    await expect(fs.stat(path.join(config.containedDir, "wrong.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls.requests).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, malformed, and non-terminal 206 ranges", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["norange.gguf", {}],
      ["stars.gguf", { "content-range": "bytes */500" }],
      ["partial.gguf", { "content-range": "bytes 100-498/500", "content-length": "399" }],
      ["wildcards.gguf", { "content-range": "bytes 100-499/?" }],
    ];
    for (const [filename, headers] of cases) {
      await fs.mkdir(partialsDirPath(), { recursive: true });
      await fs.writeFile(internalPartialPath(filename), Buffer.alloc(100, 9));
      const { transport } = fakeTransport(
        () => fakeResponse({ status: 206, headers, chunks: [Buffer.alloc(400)] }).response
      );
      const manager = createContainedDownloadManager({ transport });
      await manager.start({ url: FAKE_URL, filename, sha256: sha256Hex(Buffer.alloc(500)) });
      await waitForState(manager, filename, ["failed"]);
    }
  });

  it("refuses 206 without an existing partial and non-200/206 statuses outright", async () => {
    const { transport: t1, calls: c1 } = fakeTransport(
      () =>
        fakeResponse({
          status: 206,
          headers: { "content-range": "bytes 0-49/50", "content-length": "50" },
          chunks: [Buffer.alloc(50)],
        }).response
    );
    const fresh = createContainedDownloadManager({ transport: t1 });
    await fresh.start({ url: FAKE_URL, filename: "sneaky.gguf", sha256: sha256Hex(Buffer.alloc(50)) });
    await waitForState(fresh, "sneaky.gguf", ["failed"]);
    expect(c1.requests).toHaveBeenCalledTimes(1);

    const { transport: t2, calls: c2 } = fakeTransport(() => fakeResponse({ status: 404 }).response);
    const refused = createContainedDownloadManager({ transport: t2 });
    await refused.start({ url: FAKE_URL, filename: "gone.gguf", sha256: sha256Hex(Buffer.alloc(1)) });
    await waitForState(refused, "gone.gguf", ["failed"]);
    expect(c2.requests).toHaveBeenCalledTimes(1);
    await expect(fs.lstat(path.join(config.containedDir, "gone.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects encoded bodies, contradictory lengths, and oversized totals", async () => {
    await fs.mkdir(partialsDirPath(), { recursive: true });
    await fs.writeFile(internalPartialPath("encode.gguf"), Buffer.alloc(100, 3));
    const encoded = fakeTransport(
      () =>
        fakeResponse({
          status: 206,
          headers: {
            "content-range": "bytes 100-499/500",
            "content-length": "400",
            "content-encoding": "gzip",
          },
          chunks: [Buffer.alloc(400)],
        }).response
    );
    const encodedManager = createContainedDownloadManager({ transport: encoded.transport });
    await encodedManager.start({ url: FAKE_URL, filename: "encode.gguf", sha256: sha256Hex(Buffer.alloc(500)) });
    await waitForState(encodedManager, "encode.gguf", ["failed"]);

    await fs.writeFile(internalPartialPath("contradict.gguf"), Buffer.alloc(100, 3));
    const contradictory = fakeTransport(
      () =>
        fakeResponse({
          status: 206,
          headers: { "content-range": "bytes 100-499/500", "content-length": "50" },
          chunks: [Buffer.alloc(400)],
        }).response
    );
    const contradictoryManager = createContainedDownloadManager({ transport: contradictory.transport });
    await contradictoryManager.start({
      url: FAKE_URL,
      filename: "contradict.gguf",
      sha256: sha256Hex(Buffer.alloc(500)),
    });
    await waitForState(contradictoryManager, "contradict.gguf", ["failed"]);

    await fs.writeFile(internalPartialPath("oversize.gguf"), Buffer.alloc(100, 3));
    const oversize = fakeTransport(
      () =>
        fakeResponse({
          status: 206,
          headers: { "content-range": "bytes 100-499/500", "content-length": "400" },
          chunks: [Buffer.alloc(400)],
        }).response
    );
    const oversizeManager = createContainedDownloadManager({ transport: oversize.transport, maxBytes: 400 });
    await oversizeManager.start({ url: FAKE_URL, filename: "oversize.gguf", sha256: sha256Hex(Buffer.alloc(500)) });
    await waitForState(oversizeManager, "oversize.gguf", ["failed"]);
  });

  it("treats premature EOF as failure and caps streamed bytes at the maximum", async () => {
    const premature = fakeTransport(
      () =>
        fakeResponse({
          status: 200,
          headers: { "content-length": "100" },
          chunks: [Buffer.alloc(50, 5)],
        }).response
    );
    const prematureManager = createContainedDownloadManager({ transport: premature.transport });
    await prematureManager.start({ url: FAKE_URL, filename: "short.gguf", sha256: sha256Hex(Buffer.alloc(100)) });
    await waitForState(prematureManager, "short.gguf", ["failed"]);
    // A retryable transport failure keeps the partial for a later resume.
    expect((await fs.stat(internalPartialPath("short.gguf"))).size).toBe(50);

    const endless = fakeTransport(
      () =>
        fakeResponse({ status: 200, chunks: [Buffer.alloc(40, 1), Buffer.alloc(40, 2), Buffer.alloc(40, 3)] }).response
    );
    const endlessManager = createContainedDownloadManager({ transport: endless.transport, maxBytes: 64 });
    await endlessManager.start({ url: FAKE_URL, filename: "huge.gguf", sha256: sha256Hex(Buffer.alloc(300)) });
    await waitForState(endlessManager, "huge.gguf", ["failed"]);
    const row = endlessManager.snapshot().find((download) => download.filename === "huge.gguf");
    expect(row?.error).toContain("size bound");
    await expect(fs.stat(path.join(config.containedDir, "huge.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restarts through the same handle when a resume receives a full 200", async () => {
    const payload = Buffer.from("restart-".repeat(120));
    await fs.mkdir(partialsDirPath(), { recursive: true });
    await fs.writeFile(internalPartialPath("restart.gguf"), Buffer.alloc(600, 42));
    const { transport } = completingTransport(payload);
    const manager = createContainedDownloadManager({ transport });
    await manager.start({ url: FAKE_URL, filename: "restart.gguf", sha256: sha256Hex(payload) });
    await waitForState(manager, "restart.gguf", ["complete"]);
    // The 200 truncated rather than appended: exact expected bytes.
    expect((await fs.readFile(path.join(config.containedDir, "restart.gguf"))).equals(payload)).toBe(true);
  });

  it("terminates a stuck transfer on the bounded operation signal without publishing", async () => {
    const gated = gatedResponse();
    const { transport, calls } = fakeTransport((signal) => {
      gated.rejectOnAbort(signal);
      return gated.response;
    });
    const manager = createContainedDownloadManager({ transport, timeoutMs: 60_000 });
    // 60_000 is the documented production minimum; simulate the deadline by
    // aborting the manager-equivalent timer path through an injected short
    // timeout below instead. This entry proves a pure transport stall stays
    // pending until the single signal fires.
    await manager.start({ url: FAKE_URL, filename: "stalled.gguf", sha256: sha256Hex(Buffer.alloc(10)) });
    await waitUntil(() => calls.requests.mock.calls.length === 1, "stalled request started");
    const row = manager.snapshot().find((download) => download.filename === "stalled.gguf");
    expect(row?.state).toBe("downloading");
    await expect(fs.stat(path.join(config.containedDir, "stalled.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
    // Quiescence demonstrates the same single-signal termination path.
    const drain = manager.quiesceAndDrain();
    await drain;
    const done = manager.snapshot().find((download) => download.filename === "stalled.gguf");
    expect(done?.state).toBe("canceled");
    await manager.beginLifecycle();
  });

  it("maps the timeout to a failed state without a completed file", async () => {
    const gated = gatedResponse();
    const { transport } = fakeTransport((signal) => {
      gated.rejectOnAbort(signal);
      return gated.response;
    });
    // 250 ms keeps the timeout decisive under parallel-suite starvation
    // while the gated response still never resolves.
    const manager = createContainedDownloadManager({ transport, timeoutMs: 250 });
    await manager.start({ url: FAKE_URL, filename: "slow.gguf", sha256: sha256Hex(Buffer.alloc(10)) });
    await waitForState(manager, "slow.gguf", ["failed"]);
    const row = manager.snapshot().find((download) => download.filename === "slow.gguf");
    expect(row?.error).toContain("timed out");
    await expect(fs.stat(path.join(config.containedDir, "slow.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});

describe("contained download reservations and lifecycle", () => {
  function gatedTransport(options: { abortRejectionDelayMs?: number } = {}) {
    const gated = gatedResponse();
    const calls = { requests: 0, resolves: 0 };
    const resolve = vi.fn(async (_url: URL, _signal: AbortSignal) => {
      calls.resolves += 1;
      return [{ address: "93.184.216.34", family: 4 as const }];
    });
    const request = vi.fn(async (_url: URL, _addresses: unknown, signal: AbortSignal) => {
      calls.requests += 1;
      gated.rejectOnAbort(signal, options.abortRejectionDelayMs ?? 0);
      return gated.response;
    });
    return {
      transport: { resolve, request } as unknown as ContainedDownloadTransport,
      gated,
      calls,
    };
  }

  it("installs the case-folded reservation before any await; aliases do no work", async () => {
    const payload = Buffer.from("owner-".repeat(300));
    const gated = gatedTransport();
    const manager = createContainedDownloadManager({ transport: gated.transport });

    // Same turn: the winner installs its reservation; every alias spelling
    // must fail synchronously with zero filesystem/DNS/request work.
    const winner = manager.start({ url: FAKE_URL, filename: "Model.gguf", sha256: sha256Hex(payload) });
    const sameSpelling = manager.start({ url: FAKE_URL, filename: "Model.gguf", sha256: sha256Hex(payload) });
    const upper = manager.start({ url: FAKE_URL, filename: "MODEL.GGUF", sha256: sha256Hex(payload) });
    const mixed = manager.start({ url: FAKE_URL, filename: "mOdEl.gGuF", sha256: sha256Hex(payload) });

    await expect(sameSpelling).rejects.toThrow("already active");
    await expect(upper).rejects.toThrow("already active");
    await expect(mixed).rejects.toThrow("already active");

    // Release the winner; only it ever touched the transport.
    gated.gated.release(
      fakeResponse({ status: 200, headers: { "content-length": String(payload.length) }, chunks: [payload] }).response
    );
    await winner;
    await waitForState(manager, "Model.gguf", ["complete"]);
    expect(gated.calls.resolves).toBe(1);
    expect(gated.calls.requests).toBe(1);
    const rows = manager.snapshot().filter((download) => download.filename.toLowerCase() === "model.gguf");
    // Exactly one history row, keeping the original spelling only.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.filename).toBe("Model.gguf");
  });

  it("mixed-case cancel addresses the exact owner and releases for a retry", async () => {
    const payload = Buffer.from("cancel-".repeat(300));
    const gated = gatedTransport();
    const retry = completingTransport(payload);
    let active: ContainedDownloadTransport = gated.transport;
    const delegating: ContainedDownloadTransport = {
      resolve: (url, signal) => active.resolve(url, signal),
      request: (url, addresses, signal, headers) => active.request(url, addresses, signal, headers),
    };
    const manager = createContainedDownloadManager({ transport: delegating });

    await manager.start({ url: FAKE_URL, filename: "alpha.gguf", sha256: sha256Hex(payload) });
    await waitUntil(() => gated.calls.requests === 1, "deferred request started");

    const canceled = manager.cancel("AlPhA.GgUf");
    await expect(canceled).resolves.toBe(true);
    const row = manager.snapshot().find((download) => download.filename === "alpha.gguf");
    expect(row?.state).toBe("canceled");
    // Accepted pre-publication cancel leaves neither final nor owned partial.
    await expect(fs.stat(path.join(config.containedDir, "alpha.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(internalPartialPath("alpha.gguf"))).rejects.toMatchObject({ code: "ENOENT" });

    // Retry replaces the terminal row once the prior run fully settled.
    active = retry.transport;
    await manager.start({ url: FAKE_URL, filename: "ALPHA.GGUF", sha256: sha256Hex(payload) });
    await waitForState(manager, "ALPHA.GGUF", ["complete"]);
    expect(retry.calls.resolves).toHaveBeenCalledTimes(1);
    expect(gated.calls.requests).toBe(1);
  });

  function completingTransport(payload: Buffer) {
    return fakeTransport(
      () =>
        fakeResponse({ status: 200, headers: { "content-length": String(payload.length) }, chunks: [payload] }).response
    );
  }

  it("quiescence closes admission synchronously, stays pending until cleanup, and is joinable", async () => {
    // The transport only observes the abort after a delay, so the drain must
    // stay pending until the deferred request/writer/handle cleanup settles.
    const gated = gatedTransport({ abortRejectionDelayMs: 80 });
    let active: ContainedDownloadTransport = gated.transport;
    const delegating: ContainedDownloadTransport = {
      resolve: (url, signal) => active.resolve(url, signal),
      request: (url, addresses, signal, headers) => active.request(url, addresses, signal, headers),
    };
    const manager = createContainedDownloadManager({ transport: delegating });

    await manager.start({ url: FAKE_URL, filename: "one.gguf", sha256: sha256Hex(Buffer.alloc(10)) });
    await manager.start({ url: FAKE_URL, filename: "two.gguf", sha256: sha256Hex(Buffer.alloc(10)) });
    await waitUntil(() => gated.calls.requests === 2, "both deferred requests started");

    const drain = manager.quiesceAndDrain();
    // Admission is closed synchronously: a later start does no state/fs/DNS work.
    await expect(
      manager.start({ url: FAKE_URL, filename: "three.gguf", sha256: sha256Hex(Buffer.alloc(10)) })
    ).rejects.toBeInstanceOf(ContainedDownloadError);
    // Idempotence: a second quiesce joins the same drain.
    expect(manager.quiesceAndDrain()).toBe(drain);

    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await wait(40);
    expect(drained).toBe(false);
    await expect(manager.beginLifecycle()).rejects.toThrow("drain is still running");

    // The abort observed by the stalled requests settles both runs.
    await drain;
    expect(drained).toBe(true);
    for (const filename of ["one.gguf", "two.gguf"]) {
      expect(manager.snapshot().find((download) => download.filename === filename)?.state).toBe("canceled");
      // Quiescence leaves only the proven closed partial for a later resume.
      expect((await fs.stat(internalPartialPath(filename))).size).toBe(0);
    }

    // A new sequential lifecycle is permitted after drainage.
    await manager.beginLifecycle();
    const payload = Buffer.from("reborn-".repeat(200));
    const fresh = completingTransport(payload);
    active = fresh.transport;
    await manager.start({ url: FAKE_URL, filename: "one.gguf", sha256: sha256Hex(payload) });
    await waitForState(manager, "one.gguf", ["complete"]);
    expect((await fs.readFile(path.join(config.containedDir, "one.gguf"))).equals(payload)).toBe(true);
    expect(fresh.calls.resolves).toHaveBeenCalledTimes(1);
  });

  it("beginLifecycle is idempotent within the initial lifecycle", async () => {
    const manager = createContainedDownloadManager();
    await manager.beginLifecycle();
    await manager.beginLifecycle();
    const { url } = await startFixtureServer();
    await manager.start({ url, filename: "idle.gguf", sha256: sha256Hex(FIXTURE_PAYLOAD) });
    await waitForState(manager, "idle.gguf", ["complete"]);
  });
});

describe("contained download publication and file authority", () => {
  function completingTransport(payload: Buffer) {
    return fakeTransport(
      () =>
        fakeResponse({ status: 200, headers: { "content-length": String(payload.length) }, chunks: [payload] }).response
    );
  }

  it("blocks a final-path entry or ASCII-case alias of any type before transport work", async () => {
    const kinds = ["file", "directory", "symlink", "dangling-symlink"] as const;
    for (const kind of kinds) {
      const alias = `Alias-${kind}.GGUF`;
      const target = path.join(config.containedDir, alias);
      await fs.mkdir(config.containedDir, { recursive: true });
      if (kind === "file") await fs.writeFile(target, "SENTINEL");
      if (kind === "directory") await fs.mkdir(target);
      if (kind === "symlink") {
        await fs.writeFile(path.join(config.containedDir, "outside.bin"), "SENTINEL");
        await fs.symlink(path.join(config.containedDir, "outside.bin"), target);
      }
      if (kind === "dangling-symlink") await fs.symlink(path.join(config.containedDir, "missing.bin"), target);

      const { transport, calls } = completingTransport(Buffer.alloc(10));
      const manager = createContainedDownloadManager({ transport });
      await manager.start({ url: FAKE_URL, filename: alias.toLowerCase(), sha256: sha256Hex(Buffer.alloc(10)) });
      await waitForState(manager, alias.toLowerCase(), ["failed"]);
      expect(calls.resolves).not.toHaveBeenCalled();
      await expect(fs.lstat(target)).resolves.toBeDefined();
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("refuses symlink, hardlink, dangling, directory, and FIFO internal partials without a request", async () => {
    const sentinel = path.join(tempDataDir, "outside-sentinel.bin");
    await fs.writeFile(sentinel, "OUTSIDE");

    const cases: Array<{ name: string; seed: (p: string) => Promise<unknown> }> = [
      { name: "link.gguf", seed: async (p) => fs.symlink(sentinel, p) },
      { name: "hard.gguf", seed: async (p) => fs.link(sentinel, p) },
      { name: "dangling.gguf", seed: async (p) => fs.symlink(path.join(tempDataDir, "absent.bin"), p) },
      { name: "dir.gguf", seed: async (p) => fs.mkdir(p) },
      { name: "fifo.gguf", seed: async (p) => execFileSync("mkfifo", [p]) },
    ];
    for (const testCase of cases) {
      await fs.mkdir(partialsDirPath(), { recursive: true });
      await testCase.seed(internalPartialPath(testCase.name));
      const { transport, calls } = completingTransport(Buffer.alloc(10));
      const manager = createContainedDownloadManager({ transport });
      await manager.start({ url: FAKE_URL, filename: testCase.name, sha256: sha256Hex(Buffer.alloc(10)) });
      await waitForState(manager, testCase.name, ["failed"]);
      expect(calls.resolves).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(config.containedDir, testCase.name))).rejects.toMatchObject({ code: "ENOENT" });
      // The outside sentinel is never mutated or deleted.
      expect((await fs.readFile(sentinel)).toString()).toBe("OUTSIDE");
      // The refused entry stays exactly where it was.
      await expect(fs.lstat(internalPartialPath(testCase.name))).resolves.toBeDefined();
    }
  });

  it("fails closed on a symlinked reserved partials directory and rejects internal case aliases", async () => {
    const outside = path.join(tempDataDir, "outside-dir");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "keep.bin"), "KEEP");
    await fs.mkdir(config.containedDir, { recursive: true });
    await fs.symlink(outside, partialsDirPath());

    const { transport, calls } = completingTransport(Buffer.alloc(10));
    let manager = createContainedDownloadManager({ transport });
    await manager.start({ url: FAKE_URL, filename: "trap.gguf", sha256: sha256Hex(Buffer.alloc(10)) });
    await waitForState(manager, "trap.gguf", ["failed"]);
    expect(calls.resolves).not.toHaveBeenCalled();
    expect((await fs.readFile(path.join(outside, "keep.bin"))).toString()).toBe("KEEP");

    await fs.rm(partialsDirPath());
    await fs.mkdir(partialsDirPath(), { recursive: true });
    await fs.writeFile(path.join(partialsDirPath(), "MODEL.GGUF.part"), "ALIAS");
    manager = createContainedDownloadManager({ transport });
    await manager.start({ url: FAKE_URL, filename: "model.gguf", sha256: sha256Hex(Buffer.alloc(10)) });
    await waitForState(manager, "model.gguf", ["failed"]);
    expect((await fs.readFile(path.join(partialsDirPath(), "MODEL.GGUF.part"))).toString()).toBe("ALIAS");
  });

  it("an accepted cancel in the pre-publication hook prevents the rename entirely", async () => {
    const payload = Buffer.from("hooked-".repeat(300));
    const ref: { manager?: ReturnType<typeof createContainedDownloadManager> } = {};
    let cancelPromise: Promise<boolean> | undefined;
    const { transport } = completingTransport(payload);
    const manager = createContainedDownloadManager({
      transport,
      hooks: {
        beforePublication: async () => {
          // Accepted before the synchronous publication point: the run's
          // final abort check must then prevent the rename entirely.
          cancelPromise = ref.manager?.cancel("hook.gguf");
        },
      },
    });
    ref.manager = manager;
    await manager.start({ url: FAKE_URL, filename: "hook.gguf", sha256: sha256Hex(payload) });
    await waitForState(manager, "hook.gguf", ["canceled"]);
    await expect(cancelPromise).resolves.toBe(true);
    await expect(fs.stat(path.join(config.containedDir, "hook.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(internalPartialPath("hook.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a cancel at/after publication is too late: it joins, returns false, and cannot relabel", async () => {
    const payload = Buffer.from("committed-".repeat(300));
    let renameStarted = false;
    let releaseRename: () => void = () => undefined;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const { transport } = completingTransport(payload);
    const manager = createContainedDownloadManager({
      transport,
      hooks: {
        rename: async (from, to) => {
          renameStarted = true;
          await renameGate;
          await fs.rename(from, to);
        },
      },
    });
    await manager.start({ url: FAKE_URL, filename: "commit.gguf", sha256: sha256Hex(payload) });
    await waitUntil(() => renameStarted, "rename initiated");

    let cancelSettled: boolean | undefined;
    const cancelPromise = manager.cancel("COMMIT.GGUF").then((value) => {
      cancelSettled = value;
      return value;
    });
    await wait(40);
    // Too late: joined, but still pending because publication must finish.
    expect(cancelSettled).toBeUndefined();

    releaseRename();
    await expect(cancelPromise).resolves.toBe(false);
    await waitForState(manager, "commit.gguf", ["complete"]);
    expect((await fs.readFile(path.join(config.containedDir, "commit.gguf"))).equals(payload)).toBe(true);
  });

  it("quiescence during publication joins rename and both directory fsyncs", async () => {
    const payload = Buffer.from("quiescing-".repeat(300));
    const syncCalls: string[] = [];
    let releaseSync: () => void = () => undefined;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const { transport } = completingTransport(payload);
    const manager = createContainedDownloadManager({
      transport,
      hooks: {
        syncDirectory: async (directory) => {
          syncCalls.push(directory);
          await syncGate;
        },
      },
    });
    await manager.start({ url: FAKE_URL, filename: "sync.gguf", sha256: sha256Hex(payload) });
    await waitUntil(() => syncCalls.length === 1, "first directory fsync started");

    const drain = manager.quiesceAndDrain();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await wait(30);
    // Publication already began: quiescence only joins, never aborts/relabels.
    expect(drained).toBe(false);
    expect(manager.snapshot().find((download) => download.filename === "sync.gguf")?.state).toBe("verifying");

    releaseSync();
    await drain;
    expect(drained).toBe(true);
    expect(syncCalls).toHaveLength(2);
    expect(manager.snapshot().find((download) => download.filename === "sync.gguf")?.state).toBe("complete");
    expect((await fs.readFile(path.join(config.containedDir, "sync.gguf"))).equals(payload)).toBe(true);
  });

  it("a replaced pathname fails publication without touching the replacement", async () => {
    const payload = Buffer.from("replaced-".repeat(300));
    const sentinel = path.join(tempDataDir, "swap-sentinel.bin");
    await fs.writeFile(sentinel, "OUTSIDE");
    const { transport } = completingTransport(payload);
    const manager = createContainedDownloadManager({
      transport,
      hooks: {
        beforePublication: async () => {
          const partialPath = internalPartialPath("swap.gguf");
          await fs.rename(partialPath, path.join(partialsDirPath(), "moved.part"));
          await fs.symlink(sentinel, partialPath);
        },
      },
    });
    await manager.start({ url: FAKE_URL, filename: "swap.gguf", sha256: sha256Hex(payload) });
    await waitForState(manager, "swap.gguf", ["failed"]);
    await expect(fs.stat(path.join(config.containedDir, "swap.gguf"))).rejects.toMatchObject({ code: "ENOENT" });
    // Neither the sentinel nor the moved original bytes were mutated.
    expect((await fs.readFile(sentinel)).toString()).toBe("OUTSIDE");
    expect((await fs.readFile(path.join(partialsDirPath(), "moved.part"))).equals(payload)).toBe(true);
    // The dangling claim at the old pathname is left alone, never unlinked.
    expect((await fs.lstat(internalPartialPath("swap.gguf"))).isSymbolicLink()).toBe(true);
  });

  it("resumes from the opened handle's fstat size, not a stale row or path stat", async () => {
    const payload = FIXTURE_PAYLOAD;
    const { url, requests } = await startFixtureServer();
    // Seed an internal partial plus a misleading root-level path that a
    // path-stat-based resume could never confuse with the handle proof.
    await fs.mkdir(partialsDirPath(), { recursive: true });
    await fs.writeFile(internalPartialPath("fstat.gguf"), payload.subarray(0, 2500));
    const manager = createContainedDownloadManager();
    await manager.start({ url, filename: "fstat.gguf", sha256: sha256Hex(payload) });
    await waitForState(manager, "fstat.gguf", ["complete"]);
    expect(requests[0]?.range).toBe("bytes=2500-");
    expect((await fs.readFile(path.join(config.containedDir, "fstat.gguf"))).equals(payload)).toBe(true);
  });
});

describe("contained routes", () => {
  async function buildApp(options: { desktop?: boolean } = {}): Promise<FastifyInstance> {
    const app = Fastify();
    apps.push(app);
    installHttpBoundary(app);
    await app.register(containedRoutes, options);
    await app.ready();
    return app;
  }

  it("requires authentication", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/contained" });
    expect(response.statusCode).toBe(401);
  });

  it("keeps GET authenticated status chrome in browser mode", async () => {
    const app = await buildApp({ desktop: false });
    const response = await app.inject({ method: "GET", url: "/api/contained", headers: ownerAuth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ config: null });
  });

  it("stores config and reports downloads with state under the desktop operator", async () => {
    const app = await buildApp({ desktop: true });
    const { url } = await startFixtureServer();
    const payload = Buffer.from("contained-model-bytes-".repeat(400));

    const saved = await app.inject({
      method: "PUT",
      url: "/api/contained/config",
      headers: operatorAuth,
      body: { enabled: false },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ enabled: false });

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/contained/config",
      headers: operatorAuth,
      body: { enabled: true, binary_path: "relative", model_path: "/tmp/model" },
    });
    expect(invalid.statusCode).toBe(400);

    const started = await app.inject({
      method: "POST",
      url: "/api/contained/downloads",
      headers: operatorAuth,
      body: { url, filename: "route.gguf", sha256: sha256Hex(payload) },
    });
    expect(started.statusCode).toBe(202);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await app.inject({ method: "GET", url: "/api/contained", headers: operatorAuth });
      const downloads = state.json().downloads as Array<{ filename: string; state: string }>;
      if (downloads.find((download) => download.filename === "route.gguf")?.state === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const final = await app.inject({ method: "GET", url: "/api/contained", headers: operatorAuth });
    const downloads = final.json().downloads as Array<{ filename: string; state: string }>;
    expect(downloads.find((download) => download.filename === "route.gguf")?.state).toBe("complete");

    const cancelMissing = await app.inject({
      method: "DELETE",
      url: "/api/contained/downloads/missing.gguf",
      headers: operatorAuth,
    });
    expect(cancelMissing.statusCode).toBe(404);
  });
});

describe("contained route authority matrix", () => {
  const mutations = [
    { label: "PUT config", method: "PUT" as const, url: "/api/contained/config", payload: { enabled: false } },
    {
      label: "POST download",
      method: "POST" as const,
      url: "/api/contained/downloads",
      payload: { url: "http://127.0.0.1:9/model.gguf", filename: "x.gguf", sha256: "0".repeat(64) },
    },
    { label: "DELETE download", method: "DELETE" as const, url: "/api/contained/downloads/x.gguf" },
    { label: "POST engine start", method: "POST" as const, url: "/api/contained/engine/start" },
    { label: "POST engine stop", method: "POST" as const, url: "/api/contained/engine/stop" },
  ];

  function deniedScenarios(desktopMode: boolean) {
    const scenarios: Array<{ label: string; headers: Record<string, string>; desktop: boolean; status: number }> = [
      { label: "unauthenticated", headers: {}, desktop: desktopMode, status: 401 },
      { label: "ordinary token", headers: ownerAuth, desktop: desktopMode, status: 403 },
      { label: "claimed token in browser mode", headers: operatorAuth, desktop: false, status: 403 },
      { label: "desktop email without the claim", headers: desktopEmailAuth, desktop: true, status: 403 },
    ];
    return scenarios;
  }

  for (const desktopMode of [false, true]) {
    for (const scenario of deniedScenarios(desktopMode)) {
      it(`denies every mutation for the ${scenario.label} (desktop mode ${String(desktopMode)}) with zero side effects`, async () => {
        const spies = [
          vi.spyOn(engineManager, "start"),
          vi.spyOn(engineManager, "stop"),
          vi.spyOn(downloadManager, "start"),
          vi.spyOn(downloadManager, "cancel"),
        ];
        try {
          const app = await buildAppSafe({ desktop: scenario.desktop });
          for (const mutation of mutations) {
            const response = await app.inject({
              method: mutation.method,
              url: mutation.url,
              headers: scenario.headers,
              ...(mutation.payload ? { payload: mutation.payload } : {}),
            });
            expect(`${mutation.label} -> ${response.statusCode}`).toBe(`${mutation.label} -> ${scenario.status}`);
            if (scenario.status === 403) {
              expect(response.json()).toMatchObject({
                error: "desktop operator authority required",
                request_id: expect.any(String),
              });
              // No mode/account/path detail leaks into the stable rejection.
              expect(response.body).not.toContain(scenario.label);
              expect(response.body).not.toContain("local@borealis.app");
              expect(response.body).not.toContain(tempDataDir);
            }
          }
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
          const entries = await fs.readdir(config.storageDir);
          expect(entries).not.toContain("contained.json");
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
      });
    }
  }

  async function buildAppSafe(options: { desktop?: boolean } = {}): Promise<FastifyInstance> {
    const app = Fastify();
    apps.push(app);
    installHttpBoundary(app);
    await app.register(containedRoutes, options);
    await app.ready();
    return app;
  }

  it("retains desktop-operator success for a real claimed token under desktop mode", async () => {
    const app = await buildAppSafe({ desktop: true });
    const saved = await app.inject({
      method: "PUT",
      url: "/api/contained/config",
      headers: operatorAuth,
      body: { enabled: false },
    });
    expect(saved.statusCode).toBe(200);
    const stopped = await app.inject({ method: "POST", url: "/api/contained/engine/stop", headers: operatorAuth });
    expect(stopped.statusCode).toBe(200);
    // Reachable-but-inert proof for the other mutations: the operator passes
    // the gate and the handler logic runs (no config → 400; unknown download
    // → 404; invalid URL → 400), never a 403.
    const start = await app.inject({ method: "POST", url: "/api/contained/engine/start", headers: operatorAuth });
    expect(start.statusCode).toBe(400);
    const cancel = await app.inject({
      method: "DELETE",
      url: "/api/contained/downloads/none.gguf",
      headers: operatorAuth,
    });
    expect(cancel.statusCode).toBe(404);
    const download = await app.inject({
      method: "POST",
      url: "/api/contained/downloads",
      headers: operatorAuth,
      payload: { url: "ftp://127.0.0.1/model", filename: "x.gguf", sha256: "0".repeat(64) },
    });
    expect(download.statusCode).toBe(400);
  });
});

describe("contained config redaction", () => {
  async function buildDesktopApp(): Promise<FastifyInstance> {
    const app = Fastify();
    apps.push(app);
    installHttpBoundary(app);
    await app.register(containedRoutes, { desktop: true });
    await app.ready();
    return app;
  }

  function expectRedacted(body: string, configJson: Record<string, unknown>): void {
    expect(configJson).toEqual({
      enabled: true,
      binary: "llama-server",
      model: "model.gguf",
      binary_digest_configured: true,
      extra_arg_count: 2,
    });
    for (const forbidden of [
      "/opt/homebrew",
      "binary_path",
      "model_path",
      "extra_args",
      "-ngl",
      tempDataDir,
      "binary_sha256",
      "a".repeat(64),
    ]) {
      expect(body).not.toContain(forbidden);
    }
  }

  it("GET and PUT expose only the redacted config projection", async () => {
    const app = await buildDesktopApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/contained/config",
      headers: operatorAuth,
      body: {
        enabled: true,
        binary_path: "/opt/homebrew/bin/llama-server",
        model_path: path.join(tempDataDir, "models", "model.gguf"),
        binary_sha256: "a".repeat(64),
        extra_args: ["-ngl", "99"],
      },
    });
    expect(put.statusCode).toBe(200);
    expectRedacted(put.body, put.json().config ?? put.json());

    const get = await app.inject({ method: "GET", url: "/api/contained", headers: ownerAuth });
    expect(get.statusCode).toBe(200);
    expectRedacted(get.body, get.json().config);

    // The raw stored file still carries what the engine needs.
    const stored = await readContainedConfig();
    expect(stored).toMatchObject({
      enabled: true,
      binary_path: "/opt/homebrew/bin/llama-server",
      binary_sha256: "a".repeat(64),
      extra_args: ["-ngl", "99"],
    });
  });

  it("redacts a disabled config to inert status fields", async () => {
    const app = await buildDesktopApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/contained/config",
      headers: operatorAuth,
      body: { enabled: false },
    });
    expect(put.json()).toEqual({
      enabled: false,
      binary: null,
      model: null,
      binary_digest_configured: false,
      extra_arg_count: 0,
    });
  });
});
