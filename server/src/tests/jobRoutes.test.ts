/**
 * Connected-agents stage 4 — versioned job setup API.
 *
 * Covers the bundled editable starter jobs (`GET /api/jobs`), seeding one
 * into an ordinary versioned agent, and chat-creation-from-job on
 * `POST /api/chats`: suggested libraries expand to explicit READY source ids
 * in stable scope order, the created chat stays selected-empty until the
 * user confirms, foreign/unknown library ids fail cleanly, the 100-source cap
 * fails rather than truncates, and suggested prompts are only returned —
 * never auto-sent (no durable turn is created by a job).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signToken } from "../auth.js";
import { AGENT_TOOLS } from "../agentConfiguration.js";
import { routes } from "../routes.js";
import { closeRuntimeSettings, initializeRuntimeSettings } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { STARTER_JOBS } from "../starterJobs.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_MODEL = "jobs-chat-model";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-jobs-"));
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(runtimeDirectory, "ledger.sqlite"),
    lanceDirectory: path.join(runtimeDirectory, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [OWNER, "owner@example.test"],
    [FOREIGN, "foreign@example.test"],
  ] as const) {
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
  await initializeRuntimeSettings({ settingsFile: path.join(runtimeDirectory, "settings.json"), env: {} });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  closeRuntimeSettings();
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await routes(app, { desktop: false, automationScheduler: { isRunning: () => false } });
  await app.ready();
  return app;
}

async function insertSource(
  accountId: string,
  name: string,
  displayName: string,
  status: "ready" | "index" | "error" = "ready"
): Promise<string> {
  const id = randomUUID();
  await storageRuntime().sources.createSource(accountId, {
    id,
    name,
    kind: "document",
    displayName,
    mime: "text/plain",
    status,
    readyGeneration: status === "ready" ? 1 : null,
  });
  return id;
}

async function createLibrary(name: string, sourceIds: readonly string[]): Promise<string> {
  const library = await storageRuntime().libraries.createLibrary(OWNER, name);
  if (sourceIds.length) await storageRuntime().libraries.replaceMembers(OWNER, library.id, sourceIds);
  return library.id;
}

describe("starter jobs", () => {
  it("serves the two bundled editable jobs with no implicit data and no remote-service requirement", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/jobs", headers: ownerAuth });
    expect(response.statusCode).toBe(200);
    const jobs = response.json().jobs as Record<string, any>[];
    expect(jobs.map((job) => job.id)).toEqual(["starter-finance-analysis", "starter-diligence-memo"]);
    for (const job of jobs) {
      // Editable definitions carry no implicit attached data…
      expect(job.job_setup.library_ids).toEqual([]);
      // …no MCP requirement (built-in tools only), and bounded prompts.
      expect(job.mcp_tools).toBeUndefined();
      expect(job.tools).toEqual([...AGENT_TOOLS]);
      expect(job.instructions.length).toBeGreaterThan(0);
      expect(job.job_setup.starter_prompts.length).toBeGreaterThan(0);
      expect(job.job_setup.starter_prompts.length).toBeLessThanOrEqual(5);
      for (const prompt of job.job_setup.starter_prompts) expect(prompt.length).toBeLessThanOrEqual(2_000);
      expect(job.job_setup.output_template.kind).toBe("instruction");
    }
    // The unauthenticated surface is closed.
    const anonymous = await app.inject({ method: "GET", url: "/api/jobs" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("seeds a starter into an ordinary versioned agent that stays editable", async () => {
    const app = await buildApp();
    const starter = STARTER_JOBS[0]!;
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: ownerAuth,
      payload: {
        name: "My finance job",
        instructions: starter.instructions,
        description: starter.description,
        icon: starter.icon,
        color: starter.color,
        tools: starter.tools,
        job_setup: starter.job_setup,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().job_setup.starter_prompts).toEqual(starter.job_setup.starter_prompts);
    // Editing the seeded job is an ordinary agent revision edit.
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/agents/${created.json().id}`,
      headers: ownerAuth,
      payload: { job_setup: { ...starter.job_setup, starter_prompts: ["Only my prompt."] } },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().current_version).toBe(2);
    expect(edited.json().job_setup.starter_prompts).toEqual(["Only my prompt."]);
  });
});

describe("chat creation from a job", () => {
  it("expands suggested libraries to ready ids, stays selected-empty, and never auto-sends", async () => {
    const app = await buildApp();
    const readyA = await insertSource(OWNER, "a_ready", "A ledger");
    const readyB = await insertSource(OWNER, "b_ready", "B ledger");
    const indexing = await insertSource(OWNER, "c_index", "C ledger", "index");
    const failed = await insertSource(OWNER, "d_error", "D ledger", "error");
    const library = await createLibrary("Finance library", [readyB, indexing, readyA, failed]);

    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { model: CHAT_MODEL, job: { suggested_library_ids: [library] } },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Selected-empty until the user confirms the expanded list.
    expect(body.source_mode).toBe("selected");
    const chatId = body.id as string;
    expect(
      await storageRuntime().ledger.all("SELECT 1 FROM chat_sources WHERE chat_id=?", [chatId])
    ).toEqual([]);
    // Ready ids only, in stable scope order (display-name ordering).
    expect(body.job).toMatchObject({
      suggested_library_ids: [library],
      suggested_source_ids: [readyA, readyB],
      starter_prompts: [],
      output_template: null,
    });
    expect(body.job.suggested_source_ids).not.toContain(indexing);
    expect(body.job.suggested_source_ids).not.toContain(failed);
    // The server never sends anything because of a job.
    expect(await storageRuntime().ledger.get("SELECT 1 FROM messages WHERE chat_id=?", [chatId])).toBeUndefined();
    expect(await storageRuntime().ledger.get("SELECT 1 FROM chat_runs WHERE chat_id=?", [chatId])).toBeUndefined();
  });

  it("returns the bound agent's starter prompts and output template for confirmation", async () => {
    const app = await buildApp();
    const agent = await storageRuntime().agents.createAgent(OWNER, "Job agent", "Do the job.", {
      job_setup: {
        starter_prompts: ["First suggested prompt."],
        output_template: { kind: "instruction", instruction: "Report in three sections." },
        library_ids: [],
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { model: CHAT_MODEL, agent_id: agent.id, job: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().source_mode).toBe("selected");
    expect(response.json().job).toMatchObject({
      starter_prompts: ["First suggested prompt."],
      output_template: { kind: "instruction", instruction: "Report in three sections." },
      suggested_library_ids: [],
      suggested_source_ids: [],
    });
  });

  it("honors an explicitly confirmed scope supplied alongside the job", async () => {
    const app = await buildApp();
    const ready = await insertSource(OWNER, "confirmed_ready", "Confirmed");
    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: {
        model: CHAT_MODEL,
        source_mode: "selected",
        source_ids: [ready],
        job: { suggested_library_ids: [] },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(
      await storageRuntime().ledger.all("SELECT source_id FROM chat_sources WHERE chat_id=?", [response.json().id])
    ).toEqual([{ source_id: ready }]);
    expect(response.json().job.suggested_source_ids).toEqual([]);
  });

  it("rejects foreign or unknown suggested libraries cleanly", async () => {
    const app = await buildApp();
    const foreignLibrary = await storageRuntime().libraries.createLibrary(FOREIGN, "Foreign library");
    for (const [label, ids] of [
      ["foreign", [foreignLibrary.id]],
      ["unknown", [randomUUID()]],
      ["mixed", [randomUUID(), foreignLibrary.id]],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: ownerAuth,
        payload: { model: CHAT_MODEL, job: { suggested_library_ids: ids } },
      });
      expect(response.statusCode, label).toBe(400);
      expect(response.json().error).toMatch(/libraries/i);
    }
    expect(await storageRuntime().ledger.all("SELECT 1 FROM chats")).toEqual([]);
  });

  it("fails the 100-source expansion cap instead of truncating", async () => {
    const app = await buildApp();
    const first: string[] = [];
    const second: string[] = [];
    for (let index = 0; index < 100; index += 1) first.push(await insertSource(OWNER, `s_${index}`, `S ${index}`));
    second.push(await insertSource(OWNER, "s_overflow", "S overflow"));
    const libraryA = await createLibrary("Library A", first);
    const libraryB = await createLibrary("Library B", [...second, ...first.slice(0, 50)]);
    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { model: CHAT_MODEL, job: { suggested_library_ids: [libraryA, libraryB] } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("JOB_SCOPE_LIMIT");
    expect(await storageRuntime().ledger.all("SELECT 1 FROM chats")).toEqual([]);
  });

  it("bounds the suggested library list at the parser boundary", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { model: CHAT_MODEL, job: { suggested_library_ids: Array.from({ length: 11 }, () => randomUUID()) } },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });
});
