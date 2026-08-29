import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import {
  clearContainedConfig,
  ContainedConfigError,
  readContainedConfig,
  writeContainedConfig,
} from "../contained/configStore.js";
import { createContainedDownloadManager, ContainedDownloadError } from "../contained/downloadManager.js";
import { installHttpBoundary } from "../httpErrors.js";
import { containedRoutes } from "../routes/contained.js";
import { config } from "../config.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ownerAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}`,
};

const apps: FastifyInstance[] = [];
const servers: http.Server[] = [];
let previousContainedDir: string | undefined;
let tempDataDir = "";

beforeEach(async () => {
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-contained-"));
  previousContainedDir = process.env.CONTAINED_DIR;
  process.env.CONTAINED_DIR = path.join(tempDataDir, "models");
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
  await fs.rm(tempDataDir, { recursive: true, force: true });
  tempDataDir = "";
});

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function startFixtureServer(): Promise<string> {
  const payload = Buffer.from("contained-model-bytes-".repeat(400));
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const start = Number(String(range).split("=")[1].split("-")[0]);
      const body = payload.subarray(start);
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
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
  return `http://127.0.0.1:${port}/model.gguf`;
}

async function waitForState(
  manager: ReturnType<typeof createContainedDownloadManager>,
  filename: string,
  states: string[]
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = manager.snapshot().find((download) => download.filename === filename);
    if (current && states.includes(current.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`download ${filename} never reached ${states.join("/")}`);
}

describe("contained config store", () => {
  it("round-trips a valid enabled config with 0600 mode", async () => {
    const saved = await writeContainedConfig({
      enabled: true,
      binaryPath: "/opt/homebrew/bin/llama-server",
      modelPath: path.join(tempDataDir, "models", "model.gguf"),
      extraArgs: ["-ngl", "99"],
    });
    expect(saved).toMatchObject({
      enabled: true,
      binary_path: "/opt/homebrew/bin/llama-server",
      extra_args: ["-ngl", "99"],
    });
    const read = await readContainedConfig();
    expect(read).toEqual(saved);
    const stat = await fs.stat(path.join(config.storageDir, "contained.json"));
    expect(stat.mode & 0o777).toBe(0o600);
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
        extraArgs: Array(33).fill("a"),
      })
    ).rejects.toBeInstanceOf(ContainedConfigError);
  });
});

describe("contained download manager", () => {
  it("downloads, verifies, and atomically lands the file", async () => {
    const url = await startFixtureServer();
    const payload = Buffer.from("contained-model-bytes-".repeat(400));
    const manager = createContainedDownloadManager();

    const started = await manager.start({ url, filename: "model.gguf", sha256: sha256Hex(payload) });
    expect(started).toMatchObject({ state: "downloading", filename: "model.gguf" });

    await waitForState(manager, "model.gguf", ["complete"]);
    const landed = await fs.readFile(path.join(config.containedDir, "model.gguf"));
    expect(landed.equals(payload)).toBe(true);
    await expect(fs.stat(path.join(config.containedDir, "model.gguf.part"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on checksum mismatch and removes the partial artifact", async () => {
    const url = await startFixtureServer();
    const manager = createContainedDownloadManager();

    await manager.start({ url, filename: "bad.gguf", sha256: sha256Hex(Buffer.from("other-bytes")) });
    await waitForState(manager, "bad.gguf", ["failed"]);
    const state = manager.snapshot().find((download) => download.filename === "bad.gguf");
    expect(state?.error).toContain("checksum mismatch");
    await expect(fs.stat(path.join(config.containedDir, "bad.gguf.part"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes from the byte range of an interrupted download", async () => {
    const url = await startFixtureServer();
    const payload = Buffer.from("contained-model-bytes-".repeat(400));
    const manager = createContainedDownloadManager();

    // Pre-seed the .part as if a previous attempt stopped midway.
    await fs.mkdir(config.containedDir, { recursive: true });
    const partial = payload.subarray(0, 1000);
    await fs.writeFile(path.join(config.containedDir, "resume.gguf.part"), partial);

    await manager.start({ url, filename: "resume.gguf", sha256: sha256Hex(payload) });
    await waitForState(manager, "resume.gguf", ["complete"]);
    const landed = await fs.readFile(path.join(config.containedDir, "resume.gguf"));
    expect(landed.equals(payload)).toBe(true);
    const state = manager.snapshot().find((download) => download.filename === "resume.gguf");
    expect(state?.bytes_received).toBe(payload.length);
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
});

describe("contained routes", () => {
  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify();
    apps.push(app);
    installHttpBoundary(app);
    await app.register(containedRoutes);
    await app.ready();
    return app;
  }

  it("requires authentication", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/contained" });
    expect(response.statusCode).toBe(401);
  });

  it("stores config and reports downloads with state", async () => {
    const app = await buildApp();
    const url = await startFixtureServer();
    const payload = Buffer.from("contained-model-bytes-".repeat(400));

    const saved = await app.inject({
      method: "PUT",
      url: "/api/contained/config",
      headers: ownerAuth,
      body: { enabled: false },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ enabled: false });

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/contained/config",
      headers: ownerAuth,
      body: { enabled: true, binary_path: "relative", model_path: "/tmp/model" },
    });
    expect(invalid.statusCode).toBe(400);

    const started = await app.inject({
      method: "POST",
      url: "/api/contained/downloads",
      headers: ownerAuth,
      body: { url, filename: "route.gguf", sha256: sha256Hex(payload) },
    });
    expect(started.statusCode).toBe(202);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await app.inject({ method: "GET", url: "/api/contained", headers: ownerAuth });
      const downloads = state.json().downloads as Array<{ filename: string; state: string }>;
      if (downloads.find((download) => download.filename === "route.gguf")?.state === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const final = await app.inject({ method: "GET", url: "/api/contained", headers: ownerAuth });
    const downloads = final.json().downloads as Array<{ filename: string; state: string }>;
    expect(downloads.find((download) => download.filename === "route.gguf")?.state).toBe("complete");

    const cancelMissing = await app.inject({
      method: "DELETE",
      url: "/api/contained/downloads/missing.gguf",
      headers: ownerAuth,
    });
    expect(cancelMissing.statusCode).toBe(404);
  });
});
