/**
 * Durable document-rewrite execution — the M13 stage-3 vertical test.
 *
 * Like the vertical agent-turn suite, this crosses every seam without module
 * mocks: the real HTTP rewrite routes, the durable `document_rewrites` ledger,
 * the real account-authorized streaming client, and the terminal SQLite
 * transactions. The only stand-in is the protocol-minimal scripted provider on
 * a loopback port. Bodies are inspected in memory only and never logged. The
 * suite proves the contract that matters: an accepted proposal and a rejected
 * stale proposal through actual HTTP routes, with no provider replay after an
 * interrupted call and no transport under an unacknowledged remote provider.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { signToken } from "../auth.js";
import { createDocumentRewriteRunner, bindDefaultDocumentRewriteRunner } from "../documentRewriteRunner.js";
import { DocumentValidationError } from "../documentTypes.js";
import { SCHEMA_V23 } from "../db/migrations.js";
import { routes } from "../routes.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { assistantTextChunks, startScriptedOpenAiServer, type ScriptedOpenAiServer } from "./scriptedOpenAiServer.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const CHAT_MODEL = "rewrite-chat-model";
const EMBED_MODEL = "rewrite-embed-model";
const SECTION_ID = "c1111111-1111-4111-8111-111111111111";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER_ID, email: "owner@example.test" })}` };

const apps: FastifyInstance[] = [];
const providers: ScriptedOpenAiServer[] = [];
const directories: string[] = [];
const runners: Array<ReturnType<typeof createDocumentRewriteRunner>> = [];
const releaseHolds: Array<() => void> = [];

function deferred<T = undefined>(): { promise: Promise<T>; resolve: (value?: T) => void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done as (value?: T) => void;
  });
  releaseHolds.push(() => resolve(undefined));
  return { promise, resolve };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

afterEach(async () => {
  for (const release of releaseHolds.splice(0)) release();
  for (const runner of runners.splice(0)) await runner.stop();
  bindDefaultDocumentRewriteRunner(undefined);
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(providers.splice(0).map((provider) => provider.close().catch(() => undefined)));
  closeRuntimeSettings();
  await closeStorageRuntime();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 4 }))
  );
});

async function bootWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-rewrite-runner-"));
  directories.push(directory);
  await initializeStorageRuntime({
    sqlitePath: path.join(directory, "ledger.sqlite"),
    lanceDirectory: path.join(directory, "lancedb"),
    embeddingDimension: 3,
  });
  await storageRuntime().ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    OWNER_ID,
    "owner@example.test",
    "test-password-hash",
  ]);
  await storageRuntime().ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    OTHER_ID,
    "other@example.test",
    "test-password-hash",
  ]);
  await initializeRuntimeSettings({ settingsFile: path.join(directory, "settings.json"), env: {} });
  return directory;
}

async function pointProviderAt(origin: string): Promise<void> {
  await runtimeSettingsStore().patch({ llmBaseUrl: origin, chatModel: CHAT_MODEL, embedModel: EMBED_MODEL });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await app.register(routes);
  await app.ready();
  return app;
}

function ownRunner(): ReturnType<typeof createDocumentRewriteRunner> {
  const runner = createDocumentRewriteRunner({
    store: storageRuntime().documents,
    chats: storageRuntime().chats,
    cancelPollIntervalMs: 40,
    claimIntervalMs: 250,
  });
  runners.push(runner);
  bindDefaultDocumentRewriteRunner(runner);
  return runner;
}

async function createDocumentWithSection(
  app: FastifyInstance,
  markdown = "Revenue grew twelve percent across every region.",
  evidence: unknown[] = []
): Promise<{ documentId: string; revisionId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/documents",
    headers: ownerAuth,
    body: {
      title: "Rewrite vertical",
      tree: { title: "Rewrite vertical", sections: [{ id: SECTION_ID, heading: "Findings", markdown }], evidence },
    },
  });
  expect(response.statusCode).toBe(201);
  return { documentId: response.json().document.id, revisionId: response.json().revision.id };
}

async function getRewrite(app: FastifyInstance, documentId: string, rewriteId: string): Promise<any> {
  const response = await app.inject({
    method: "GET",
    url: `/api/documents/${documentId}/rewrites/${rewriteId}`,
    headers: ownerAuth,
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function waitForRewriteStatus(
  app: FastifyInstance,
  documentId: string,
  rewriteId: string,
  statuses: readonly string[],
  timeoutMs = 15_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rewrite = await getRewrite(app, documentId, rewriteId);
    if (statuses.includes(rewrite.status)) return rewrite;
    if (Date.now() > deadline) throw new Error(`rewrite ${rewriteId} stalled in status ${rewrite.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForProviderCall(arrived: Promise<unknown>, timeoutMs = 5_000): Promise<void> {
  await Promise.race([arrived, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

async function requestRewrite(
  app: FastifyInstance,
  documentId: string,
  revisionId: string,
  selectionText: string,
  instruction = "Rewrite it more crisply.",
  range?: { range_start: number; range_end: number }
): Promise<any> {
  const response = await app.inject({
    method: "POST",
    url: `/api/documents/${documentId}/rewrites`,
    headers: ownerAuth,
    body: {
      base_revision_id: revisionId,
      section_id: SECTION_ID,
      ...(range ?? {}),
      selection_sha256: sha256(selectionText),
      instruction,
    },
  });
  return response;
}

describe("document rewrite runner (vertical)", () => {
  it(
    "proposes through the provider, accepts into a model-authored revision, and applies once",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [
        assistantTextChunks(CHAT_MODEL, ["Revenue climbed ", "12% across all regions."]),
      ]);
      providers.push(provider);
      await pointProviderAt(provider.origin);
      const runner = ownRunner();
      runner.start();
      const app = await buildApp();
      const { documentId, revisionId } = await createDocumentWithSection(app);

      const created = await requestRewrite(
        app,
        documentId,
        revisionId,
        "Revenue grew twelve percent across every region."
      );
      expect(created.statusCode).toBe(202);
      const rewrite = await waitForRewriteStatus(app, documentId, created.json().id, [
        "completed",
        "failed",
        "cancelled",
      ]);
      expect(rewrite).toMatchObject({ status: "completed", model: CHAT_MODEL });
      expect(rewrite.replacement).toBe("Revenue climbed 12% across all regions.");

      // Exactly one streaming chat call, no tools, with only the bounded
      // selection/instruction/context material in the user message.
      expect(provider.calls).toHaveLength(1);
      const body = provider.calls[0] as Record<string, unknown>;
      expect(body.model).toBe(CHAT_MODEL);
      expect(body.stream).toBe(true);
      expect(body.tools).toBeUndefined();
      expect(body.max_tokens).toBe(8_192);
      const messages = body.messages as Array<{ role: string; content: string }>;
      expect(messages[0].role).toBe("system");
      expect(messages[1].content).toContain("Revenue grew twelve percent across every region.");
      expect(messages[1].content).toContain("Rewrite it more crisply.");
      expect(messages[1].content).toContain("Copied evidence context");

      // Acceptance creates one model-authored draft revision under CAS.
      const accepted = await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/rewrites/${rewrite.id}/accept`,
        headers: ownerAuth,
      });
      expect(accepted.statusCode).toBe(201);
      const payload = accepted.json().revision.payload;
      expect(accepted.json().revision).toMatchObject({ revision: 2, author_kind: "model" });
      expect(payload.sections[0].markdown).toBe("Revenue climbed 12% across all regions.");

      // One-shot: a second acceptance can never re-apply the proposal.
      const replay = await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/rewrites/${rewrite.id}/accept`,
        headers: ownerAuth,
      });
      expect(replay.statusCode).toBe(409);
      expect(replay.json().code).toBe("DOCUMENT_REWRITE_ALREADY_APPLIED");
    }
  );

  it(
    "rejects acceptance after the head moves, marking the proposal durably stale and inspectable",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [assistantTextChunks(CHAT_MODEL, ["Climbed 12%."])]);
      providers.push(provider);
      await pointProviderAt(provider.origin);
      const runner = ownRunner();
      runner.start();
      const app = await buildApp();
      const { documentId, revisionId } = await createDocumentWithSection(app);

      const created = await requestRewrite(
        app,
        documentId,
        revisionId,
        "Revenue grew twelve percent across every region."
      );
      expect(created.statusCode).toBe(202);
      const rewrite = await waitForRewriteStatus(app, documentId, created.json().id, ["completed"]);

      // A concurrent save moves the head.
      const saved = await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/revisions`,
        headers: ownerAuth,
        body: {
          base_revision_id: revisionId,
          tree: {
            title: "Rewrite vertical",
            sections: [{ id: SECTION_ID, heading: "Findings", markdown: "Manual edit landed first." }],
          },
        },
      });
      expect(saved.statusCode).toBe(201);

      const stale = await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/rewrites/${rewrite.id}/accept`,
        headers: ownerAuth,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("DOCUMENT_REWRITE_STALE");
      expect(stale.json().current_head).toMatchObject({ revision: 2 });

      const inspected = await getRewrite(app, documentId, rewrite.id);
      expect(inspected.status).toBe("stale");
      expect(inspected.replacement).toBe("Climbed 12%.");

      // A stale proposal can never be applied, even explicitly.
      const forced = await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/rewrites/${rewrite.id}/accept`,
        headers: ownerAuth,
      });
      expect(forced.statusCode).toBe(409);
      expect(forced.json().code).toBe("DOCUMENT_REWRITE_STALE");

      // The head is untouched by the rejected acceptance.
      const head = await app.inject({ method: "GET", url: `/api/documents/${documentId}`, headers: ownerAuth });
      expect(head.json().current_revision).toBe(2);
    }
  );

  it(
    "cancels a running provider call through the durable flag without a second call",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const hold = deferred();
      const arrived = deferred();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [assistantTextChunks(CHAT_MODEL, ["too late"])], {
        onCall: async () => {
          arrived.resolve();
          await hold.promise;
        },
      });
      providers.push(provider);
      await pointProviderAt(provider.origin);
      const runner = ownRunner();
      runner.start();
      const app = await buildApp();
      const { documentId, revisionId } = await createDocumentWithSection(app);

      const created = await requestRewrite(
        app,
        documentId,
        revisionId,
        "Revenue grew twelve percent across every region."
      );
      expect(created.statusCode).toBe(202);
      await waitForRewriteStatus(app, documentId, created.json().id, ["running"]);
      await waitForProviderCall(arrived.promise);

      // One active rewrite per document while the provider call is held.
      const second = await requestRewrite(
        app,
        documentId,
        revisionId,
        "Revenue grew twelve percent across every region.",
        "Another pass."
      );
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe("DOCUMENT_REWRITE_ACTIVE");

      const cancelled = await app.inject({
        method: "DELETE",
        url: `/api/documents/${documentId}/rewrites/${created.json().id}`,
        headers: ownerAuth,
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().action).toBe("cancelling");
      hold.resolve();

      const settled = await waitForRewriteStatus(app, documentId, created.json().id, ["cancelled"]);
      expect(settled.replacement).toBeNull();
      expect(provider.calls).toHaveLength(1);
    }
  );

  it(
    "marks an interrupted running rewrite failed on shutdown and startup resume without replaying the provider",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const hold = deferred();
      const arrived = deferred();
      const provider = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [assistantTextChunks(CHAT_MODEL, ["never delivered"])],
        {
          onCall: async () => {
            arrived.resolve();
            await hold.promise;
          },
        }
      );
      providers.push(provider);
      await pointProviderAt(provider.origin);
      const runner = ownRunner();
      runner.start();
      const app = await buildApp();
      const { documentId, revisionId } = await createDocumentWithSection(app);

      const created = await requestRewrite(
        app,
        documentId,
        revisionId,
        "Revenue grew twelve percent across every region."
      );
      expect(created.statusCode).toBe(202);
      await waitForRewriteStatus(app, documentId, created.json().id, ["running"]);
      await waitForProviderCall(arrived.promise);

      // An orderly shutdown interrupts the in-flight call. No half-applied
      // rewrite exists: the row durably fails and the head never moved.
      await runner.stop();
      hold.resolve();
      const interrupted = await getRewrite(app, documentId, created.json().id);
      expect(interrupted.status).toBe("failed");
      expect(interrupted.error_code).toBe("SERVER_RESTARTED");

      // A fresh runner recovers any still-running rows and never replays the
      // interrupted provider call: a new request is required.
      const recovered = ownRunner();
      recovered.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(provider.calls).toHaveLength(1);
      const stillFailed = await getRewrite(app, documentId, created.json().id);
      expect(stillFailed.status).toBe("failed");
      const head = await app.inject({ method: "GET", url: `/api/documents/${documentId}`, headers: ownerAuth });
      expect(head.json().current_revision).toBe(1);
    }
  );

  it(
    "recovers a crash-staged running row as failed on startup without any provider call",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [
        assistantTextChunks(CHAT_MODEL, ["should never run"]),
      ]);
      providers.push(provider);
      await pointProviderAt(provider.origin);
      const app = await buildApp();
      const { documentId, revisionId } = await createDocumentWithSection(app);

      // Stage the exact durable state a crash leaves behind: a dispatched row
      // whose provider call died with the previous process. No runner ran.
      const staged = await storageRuntime().documents.acceptDocumentRewriteRequest(OWNER_ID, documentId, {
        baseRevisionId: revisionId,
        sectionId: SECTION_ID,
        selectionSha256: sha256("Revenue grew twelve percent across every region."),
        instruction: "Tighten it.",
      });
      await storageRuntime().documents.markDocumentRewriteRunning(OWNER_ID, documentId, staged.id, CHAT_MODEL);

      const runner = ownRunner();
      runner.start();
      const recovered = await waitForRewriteStatus(app, documentId, staged.id, ["failed"]);
      expect(recovered.error_code).toBe("SERVER_RESTARTED");
      expect(provider.calls).toHaveLength(0);
    }
  );

  it(
    "makes no transport under an unacknowledged remote provider and unblocks after acknowledgment",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [
        assistantTextChunks(CHAT_MODEL, ["Unlocked replacement."]),
      ]);
      providers.push(provider);

      // A route-level request against an unacknowledged remote provider is a
      // 403 before any payload persistence.
      await pointProviderAt("https://remote-provider.example.test");
      const app = await buildApp();
      const { documentId, revisionId } = await createDocumentWithSection(app);
      const blocked = await requestRewrite(
        app,
        documentId,
        revisionId,
        "Revenue grew twelve percent across every region."
      );
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe("REMOTE_EGRESS_CONSENT_REQUIRED");
      const list = await app.inject({
        method: "GET",
        url: `/api/documents/${documentId}/rewrites`,
        headers: ownerAuth,
      });
      expect(list.json().items).toHaveLength(0);

      // Acknowledgment unblocks without a restart; the loopback provider
      // needs no consent at all.
      const ack = await app.inject({
        method: "POST",
        url: "/api/consent/remote-egress",
        headers: ownerAuth,
        body: {},
      });
      expect(ack.statusCode).toBeLessThan(300);
      await pointProviderAt(provider.origin);

      const runner = ownRunner();
      runner.start();
      const created = await requestRewrite(
        app,
        documentId,
        revisionId,
        "Revenue grew twelve percent across every region."
      );
      expect(created.statusCode).toBe(202);
      const completed = await waitForRewriteStatus(app, documentId, created.json().id, ["completed"]);
      expect(completed.replacement).toBe("Unlocked replacement.");
    }
  );

  it(
    "fails a queued claim with the consent code and zero transport when a remote provider appears before dispatch",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [assistantTextChunks(CHAT_MODEL, ["must not run"])]);
      providers.push(provider);
      await pointProviderAt(provider.origin);
      const app = await buildApp();
      const { documentId, revisionId } = await createDocumentWithSection(app);

      // A queued row accepted under a local provider, then Settings switches
      // to an unacknowledged remote provider before the claim dispatches.
      const queued = await storageRuntime().documents.acceptDocumentRewriteRequest(OWNER_ID, documentId, {
        baseRevisionId: revisionId,
        sectionId: SECTION_ID,
        selectionSha256: sha256("Revenue grew twelve percent across every region."),
        instruction: "Tighten it.",
      });
      await pointProviderAt("https://remote-provider.example.test");

      const runner = ownRunner();
      runner.start();
      const failed = await waitForRewriteStatus(app, documentId, queued.id, ["failed"]);
      expect(failed.error_code).toBe("REMOTE_EGRESS_CONSENT_REQUIRED");
      expect(provider.calls).toHaveLength(0);
    }
  );

  it(
    "fails malformed or oversize model output with a generic code and keeps the draft intact",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [
        assistantTextChunks(CHAT_MODEL, ["   ", "  "]),
        assistantTextChunks(CHAT_MODEL, ["x".repeat(20_001)]),
      ]);
      providers.push(provider);
      await pointProviderAt(provider.origin);
      const runner = ownRunner();
      runner.start();
      const app = await buildApp();
      const { documentId, revisionId } = await createDocumentWithSection(app);

      const blank = await requestRewrite(
        app,
        documentId,
        revisionId,
        "Revenue grew twelve percent across every region.",
        "Blank output run."
      );
      expect(blank.statusCode).toBe(202);
      const blankRun = await waitForRewriteStatus(app, documentId, blank.json().id, ["failed"]);
      expect(blankRun.error_code).toBe("DOCUMENT_REWRITE_OUTPUT_REJECTED");

      const oversize = await requestRewrite(
        app,
        documentId,
        revisionId,
        "Revenue grew twelve percent across every region.",
        "Oversize output run."
      );
      expect(oversize.statusCode).toBe(202);
      const oversizeRun = await waitForRewriteStatus(app, documentId, oversize.json().id, ["failed"]);
      expect(oversizeRun.error_code).toBe("DOCUMENT_REWRITE_OUTPUT_REJECTED");
      expect(oversizeRun.replacement).toBeNull();
      expect(provider.calls).toHaveLength(2);

      const head = await app.inject({ method: "GET", url: `/api/documents/${documentId}`, headers: ownerAuth });
      expect(head.json().current_revision).toBe(1);
    }
  );

  it(
    "bounds the prompt to selection plus copied evidence context and copies evidence references",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [
        assistantTextChunks(CHAT_MODEL, ["Grounded replacement."]),
      ]);
      providers.push(provider);
      await pointProviderAt(provider.origin);
      const runner = ownRunner();
      runner.start();
      const app = await buildApp();
      // 100 near-max excerpts serialize past the 24,000-character rewrite
      // context bound while staying under the revision's 100,000-character
      // evidence budget.
      const evidence = Array.from({ length: 100 }, () => ({
        id: randomUUID(),
        source_id: randomUUID(),
        source_name: "ledger.csv",
        generation: 3,
        content_identity: "sha256:context-boundary",
        locator: "row 1",
        excerpt: "e".repeat(700),
      }));
      const response = await app.inject({
        method: "POST",
        url: "/api/documents",
        headers: ownerAuth,
        body: {
          title: "Evidence-bound doc",
          tree: {
            title: "Evidence-bound doc",
            sections: [{ id: SECTION_ID, heading: "Findings", markdown: "Grew twelve percent." }],
            evidence,
          },
        },
      });
      expect(response.statusCode).toBe(201);
      const documentId = response.json().document.id;
      const revisionId = response.json().revision.id;

      const created = await requestRewrite(app, documentId, revisionId, "Grew twelve percent.");
      expect(created.statusCode).toBe(202);
      const rewrite = await waitForRewriteStatus(app, documentId, created.json().id, ["completed"]);
      expect(rewrite.evidence_refs).toEqual(evidence.map((entry) => entry.id));

      // The serialized 100-reference evidence block is far past the bound;
      // the prompt must carry only what fits plus an explicit omission line.
      expect(provider.calls).toHaveLength(1);
      const userMessage = (provider.calls[0].messages as Array<{ role: string; content: string }>)[1].content;
      expect(userMessage.length).toBeLessThanOrEqual(24_000 + 8_000 + 2_000 + 400);
      expect(userMessage).toContain("additional copied evidence references omitted from this prompt");

      const accepted = await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/rewrites/${rewrite.id}/accept`,
        headers: ownerAuth,
      });
      expect(accepted.statusCode).toBe(201);
      // Acceptance copies the evidence snapshot through untouched.
      expect(accepted.json().revision.payload.evidence.map((entry: { id: string }) => entry.id)).toEqual(
        evidence.map((entry) => entry.id)
      );
    }
  );

  it("applies an exact astral-plane selection with surrogate-safe boundaries", { timeout: 60_000 }, async () => {
    await bootWorkspace();
    const provider = await startScriptedOpenAiServer(CHAT_MODEL, [assistantTextChunks(CHAT_MODEL, ["lost 🦊"])]);
    providers.push(provider);
    await pointProviderAt(provider.origin);
    const runner = ownRunner();
    runner.start();
    const app = await buildApp();
    const { documentId, revisionId } = await createDocumentWithSection(app, "the 🦊 jumped 🦊");

    // 0..14 covers "the 🦊 jumped " with whole-surrogate boundaries; 14 is
    // just before the astral fox's high surrogate, so it is admissible.
    const created = await requestRewrite(app, documentId, revisionId, "the 🦊 jumped ", "Rewrite.", {
      range_start: 0,
      range_end: 14,
    });
    expect(created.statusCode).toBe(202);
    const rewrite = await waitForRewriteStatus(app, documentId, created.json().id, ["completed", "failed"]);
    expect(rewrite.status).toBe("completed");

    const accepted = await app.inject({
      method: "POST",
      url: `/api/documents/${documentId}/rewrites/${rewrite.id}/accept`,
      headers: ownerAuth,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().revision.payload.sections[0].markdown).toBe("lost 🦊🦊");
  });

  it("rejects a rewrite request whose base revision is not owned or exists", async () => {
    await bootWorkspace();
    const provider = await startScriptedOpenAiServer(CHAT_MODEL, []);
    providers.push(provider);
    await pointProviderAt(provider.origin);
    const app = await buildApp();
    const response = await requestRewrite(app, randomUUID(), randomUUID(), "whatever", "nope");
    expect(response.statusCode).toBe(404);
  });

  it("ships a byte-identical v023 fixture of the rewrite ledger", async () => {
    const fixtureSql = await fs.readFile(fileURLToPath(new URL("./fixtures/sqlite/v023.sql", import.meta.url)), "utf8");
    expect(fixtureSql).toBe(SCHEMA_V23);
  });

  it("keeps the store contract: blank replacement cannot complete a rewrite", async () => {
    await bootWorkspace();
    const provider = await startScriptedOpenAiServer(CHAT_MODEL, []);
    providers.push(provider);
    await pointProviderAt(provider.origin);
    const app = await buildApp();
    const { documentId, revisionId } = await createDocumentWithSection(app);
    const staged = await storageRuntime().documents.acceptDocumentRewriteRequest(OWNER_ID, documentId, {
      baseRevisionId: revisionId,
      sectionId: SECTION_ID,
      selectionSha256: sha256("Revenue grew twelve percent across every region."),
      instruction: "Tighten it.",
    });
    await storageRuntime().documents.markDocumentRewriteRunning(OWNER_ID, documentId, staged.id, CHAT_MODEL);
    await expect(
      storageRuntime().documents.completeDocumentRewrite(OWNER_ID, documentId, staged.id, { replacement: "   " })
    ).rejects.toBeInstanceOf(DocumentValidationError);
  });
});
