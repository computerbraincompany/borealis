import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    jwtSecret: "vitest-secret-that-is-longer-than-32-chars-123456",
    uploadDir: "/tmp/borealis-report-cleanup-uploads",
    reportDir: "/tmp/borealis-report-cleanup-reports",
  },
}));
vi.mock("../storageArtifacts.js", () => ({
  removeReportArtifacts: vi.fn(),
  resolveReportArtifact: vi.fn(),
}));

import { signToken } from "../auth.js";
import { repairReportArtifactCleanup } from "../reportCleanup.js";
import { reportRoutes } from "../routes/reports.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { removeReportArtifacts } from "../storageArtifacts.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPORT = "22222222-2222-4222-8222-222222222222";
const PENDING_REPORT = "33333333-3333-4333-8333-333333333333";
const HTML_PATH = `/safe/${OWNER}/${REPORT}/report.html`;
const PDF_PATH = `/safe/${OWNER}/${REPORT}/report.pdf`;
const auth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = {
  authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}`,
};
const removeArtifactsMock = vi.mocked(removeReportArtifacts);
const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  removeArtifactsMock.mockReset();
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-report-cleanup-"));
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
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

describe("durable report artifact cleanup", () => {
  it("hides the published row and persists exact cleanup intent before removing files", async () => {
    await insertReport(REPORT, "published", HTML_PATH, PDF_PATH);
    removeArtifactsMock.mockImplementationOnce(async (input) => {
      await expect(storageRuntime().runs.getPublishedReport(OWNER, REPORT)).resolves.toBeUndefined();
      await expect(storageRuntime().runs.listReportArtifactCleanupIntents()).resolves.toEqual([
        expect.objectContaining({
          id: REPORT,
          accountId: OWNER,
          htmlPath: HTML_PATH,
          pdfPath: PDF_PATH,
          attempts: 0,
          lastError: null,
        }),
      ]);
      expect(input).toEqual({ accountId: OWNER, reportId: REPORT, htmlPath: HTML_PATH, pdfPath: PDF_PATH });
      return true;
    });
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/reports/${REPORT}`, headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(removeArtifactsMock).toHaveBeenCalledOnce();
    await expect(storageRuntime().runs.listReportArtifactCleanupIntents()).resolves.toEqual([]);
    await expect(storageRuntime().runs.getPublishedReport(OWNER, REPORT)).resolves.toBeUndefined();
  });

  it("retains a failed marker, denies cross-tenant replay, and retries the same deletion idempotently", async () => {
    await insertReport(REPORT, "published", HTML_PATH, PDF_PATH);
    removeArtifactsMock.mockRejectedValueOnce(new Error("raw filesystem failure must not escape"));
    const app = await buildApp();

    const failed = await app.inject({ method: "DELETE", url: `/api/reports/${REPORT}`, headers: auth });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "report cleanup deferred" });
    expect(failed.body).not.toContain("raw filesystem failure");
    await expect(storageRuntime().runs.listReportArtifactCleanupIntents()).resolves.toEqual([
      expect.objectContaining({
        id: REPORT,
        accountId: OWNER,
        htmlPath: HTML_PATH,
        pdfPath: PDF_PATH,
        attempts: 1,
        lastError: "REPORT_ARTIFACT_CLEANUP_FAILED",
      }),
    ]);

    const denied = await app.inject({ method: "DELETE", url: `/api/reports/${REPORT}`, headers: foreignAuth });
    expect(denied.statusCode).toBe(404);
    expect(removeArtifactsMock).toHaveBeenCalledTimes(1);

    removeArtifactsMock.mockResolvedValueOnce(true);
    const retried = await app.inject({ method: "DELETE", url: `/api/reports/${REPORT}`, headers: auth });
    expect(retried.statusCode).toBe(200);
    expect(removeArtifactsMock).toHaveBeenNthCalledWith(2, {
      accountId: OWNER,
      reportId: REPORT,
      htmlPath: HTML_PATH,
      pdfPath: PDF_PATH,
    });
    await expect(storageRuntime().runs.listReportArtifactCleanupIntents()).resolves.toEqual([]);

    const completedReplay = await app.inject({ method: "DELETE", url: `/api/reports/${REPORT}`, headers: auth });
    expect(completedReplay.statusCode).toBe(404);
    expect(removeArtifactsMock).toHaveBeenCalledTimes(2);
  });

  it("repairs persisted intents once and never exposes pending reports to deletion", async () => {
    await insertReport(REPORT, "published", HTML_PATH, PDF_PATH);
    await storageRuntime().runs.reservePublishedReportDeletion(OWNER, REPORT);
    await insertReport(PENDING_REPORT, "pending", `/safe/${OWNER}/${PENDING_REPORT}/report.html`, null);
    removeArtifactsMock.mockResolvedValue(true);
    const app = await buildApp();

    const pending = await app.inject({ method: "DELETE", url: `/api/reports/${PENDING_REPORT}`, headers: auth });
    expect(pending.statusCode).toBe(404);
    await expect(
      storageRuntime().ledger.get("SELECT status FROM reports WHERE id=?", [PENDING_REPORT])
    ).resolves.toEqual({ status: "pending" });
    expect(removeArtifactsMock).not.toHaveBeenCalled();

    await expect(repairReportArtifactCleanup()).resolves.toEqual({ attempted: 1, completed: 1, failed: 0 });
    await expect(repairReportArtifactCleanup()).resolves.toEqual({ attempted: 0, completed: 0, failed: 0 });
    expect(removeArtifactsMock).toHaveBeenCalledOnce();
  });

  it("clears a pathless legacy intent as an idempotent success without filesystem deletion", async () => {
    await insertReport(REPORT, "published", null, null);
    await storageRuntime().runs.reservePublishedReportDeletion(OWNER, REPORT);

    await expect(repairReportArtifactCleanup()).resolves.toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(removeArtifactsMock).not.toHaveBeenCalled();
    await expect(storageRuntime().runs.listReportArtifactCleanupIntents()).resolves.toEqual([]);
    await expect(repairReportArtifactCleanup()).resolves.toEqual({ attempted: 0, completed: 0, failed: 0 });
  });
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await reportRoutes(app);
  await app.ready();
  return app;
}

async function insertReport(
  id: string,
  status: "pending" | "published",
  htmlPath: string | null,
  pdfPath: string | null
): Promise<void> {
  await storageRuntime().ledger.run(
    `INSERT INTO reports (id,account_id,status,title,html_path,pdf_path) VALUES (?,?,?,'Report',?,?)`,
    [id, OWNER, status, htmlPath, pdfPath]
  );
}
