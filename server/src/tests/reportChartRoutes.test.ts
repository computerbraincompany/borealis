import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const artifactState = vi.hoisted(() => ({
  root: `${process.cwd()}/.vitest-report-routes-${process.pid}`,
}));
vi.mock("../config.js", () => ({
  config: {
    jwtSecret: "vitest-secret-that-is-longer-than-32-chars-123456",
    uploadDir: `${artifactState.root}/uploads`,
    reportDir: `${artifactState.root}/reports`,
  },
}));

import { signToken } from "../auth.js";
import { encodeJson } from "../db/codecs.js";
import { chartRoutes } from "../routes/charts.js";
import { reportRoutes } from "../routes/reports.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { createReportResourceDirectory } from "../storageArtifacts.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_REPORT = "22222222-2222-4222-8222-222222222222";
const FOREIGN_REPORT = "33333333-3333-4333-8333-333333333333";
const PENDING_REPORT = "44444444-4444-4444-8444-444444444444";
const DRIFTED_REPORT = "55555555-5555-4555-8555-555555555555";
const OWNER_CHART = "66666666-6666-4666-8666-666666666666";
const FOREIGN_CHART = "77777777-7777-4777-8777-777777777777";
const PENDING_CHART = "88888888-8888-4888-8888-888888888888";
const NO_PNG_CHART = "99999999-9999-4999-8999-999999999999";

const ownerAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}`,
};
const foreignAuth = {
  authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}`,
};

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  await fs.rm(artifactState.root, { recursive: true, force: true });
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-report-chart-routes-"));
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
  await fs.rm(artifactState.root, { recursive: true, force: true });
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

describe("published report and chart routes", () => {
  it("keeps reads tenant-scoped and hides every pending artifact", async () => {
    await insertReport(OWNER_REPORT, OWNER, "published", "Owner report");
    await insertReport(FOREIGN_REPORT, FOREIGN, "published", "Foreign report");
    await insertReport(PENDING_REPORT, OWNER, "pending", "Pending report");
    await insertChart(OWNER_CHART, OWNER, "published", "owner", "owner-png");
    await insertChart(FOREIGN_CHART, FOREIGN, "published", "foreign", "foreign-png");
    await insertChart(PENDING_CHART, OWNER, "pending", "pending", "pending-png");
    const app = await buildApp();

    const ownerReports = await app.inject({ method: "GET", url: "/api/reports", headers: ownerAuth });
    expect(ownerReports.statusCode).toBe(200);
    expect(ownerReports.json()).toEqual([expect.objectContaining({ id: OWNER_REPORT, title: "Owner report" })]);
    expect(ownerReports.body).not.toContain("html_path");
    expect(ownerReports.body).not.toContain("pdf_path");
    await expectStatus(app, `/api/reports/${FOREIGN_REPORT}`, ownerAuth, 404);
    await expectStatus(app, `/api/reports/${PENDING_REPORT}`, ownerAuth, 404);

    const ownerChart = await app.inject({ method: "GET", url: `/api/charts/${OWNER_CHART}`, headers: ownerAuth });
    expect(ownerChart.statusCode).toBe(200);
    expect(ownerChart.json()).toEqual({
      id: OWNER_CHART,
      spec: { title: "owner" },
      echarts: { series: [] },
      png_base64: "owner-png",
    });
    await expectStatus(app, `/api/charts/${FOREIGN_CHART}`, ownerAuth, 404);
    await expectStatus(app, `/api/charts/${PENDING_CHART}`, ownerAuth, 404);

    const foreignReports = await app.inject({ method: "GET", url: "/api/reports", headers: foreignAuth });
    expect(foreignReports.json()).toEqual([expect.objectContaining({ id: FOREIGN_REPORT, title: "Foreign report" })]);
  });

  it("serves HTML and PDF only after exact account/report path proof", async () => {
    const directory = await createReportResourceDirectory(OWNER, OWNER_REPORT);
    const htmlPath = path.join(directory, "report.html");
    const pdfPath = path.join(directory, "report.pdf");
    await fs.writeFile(htmlPath, "<!doctype html><title>Owned report</title>");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7\nowned"));
    await insertReport(OWNER_REPORT, OWNER, "published", "Owned report", htmlPath, pdfPath);

    const outside = path.join(artifactState.root, "outside.html");
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, "private");
    await insertReport(DRIFTED_REPORT, OWNER, "published", "Drifted report", outside, outside);
    const app = await buildApp();

    const detail = await app.inject({ method: "GET", url: `/api/reports/${OWNER_REPORT}`, headers: ownerAuth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: OWNER_REPORT, has_html: true, has_pdf: true });

    const html = await app.inject({ method: "GET", url: `/api/reports/${OWNER_REPORT}/html`, headers: ownerAuth });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain("Owned report");
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(html.headers["x-content-type-options"]).toBe("nosniff");

    const pdf = await app.inject({ method: "GET", url: `/api/reports/${OWNER_REPORT}/pdf`, headers: ownerAuth });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.headers["content-disposition"]).toBe('attachment; filename="report.pdf"');

    const drifted = await app.inject({ method: "GET", url: `/api/reports/${DRIFTED_REPORT}`, headers: ownerAuth });
    expect(drifted.json()).toMatchObject({ has_html: false, has_pdf: false });
    await expectStatus(app, `/api/reports/${DRIFTED_REPORT}/html`, ownerAuth, 404);
    await expectStatus(app, `/api/reports/${DRIFTED_REPORT}/pdf`, ownerAuth, 404);
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("private");
  });

  it("returns a stable absence response when a published chart has no PNG export", async () => {
    await insertChart(NO_PNG_CHART, OWNER, "published", "no png", null);
    const app = await buildApp();

    const chart = await app.inject({ method: "GET", url: `/api/charts/${NO_PNG_CHART}`, headers: ownerAuth });
    expect(chart.statusCode).toBe(200);
    expect(chart.json()).toMatchObject({ id: NO_PNG_CHART, png_base64: null });

    const png = await app.inject({ method: "POST", url: `/api/charts/${NO_PNG_CHART}/png`, headers: ownerAuth });
    expect(png.statusCode).toBe(404);
    expect(png.json()).toEqual({ error: "chart export not available" });
  });
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await reportRoutes(app);
  await chartRoutes(app);
  await app.ready();
  return app;
}

async function insertReport(
  id: string,
  accountId: string,
  status: "pending" | "published",
  title: string,
  htmlPath: string | null = null,
  pdfPath: string | null = null
): Promise<void> {
  await storageRuntime().ledger.run(
    `INSERT INTO reports (id,account_id,status,title,html_path,pdf_path) VALUES (?,?,?,?,?,?)`,
    [id, accountId, status, title, htmlPath, pdfPath]
  );
}

async function insertChart(
  id: string,
  accountId: string,
  status: "pending" | "published",
  title: string,
  pngBase64: string | null
): Promise<void> {
  await storageRuntime().ledger.run(
    `INSERT INTO charts (id,account_id,status,spec,echarts,png_base64) VALUES (?,?,?,?,?,?)`,
    [id, accountId, status, encodeJson({ title }), encodeJson({ series: [] }), pngBase64]
  );
}

async function expectStatus(
  app: FastifyInstance,
  url: string,
  headers: Record<string, string>,
  statusCode: number
): Promise<void> {
  const response = await app.inject({ method: "GET", url, headers });
  expect(response.statusCode).toBe(statusCode);
}
