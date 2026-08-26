import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { REPORT_CSP } from "../data/reports.js";
import { ArtifactNotFoundError } from "../db/stores/runStore.js";
import { completeReportArtifactCleanup } from "../reportCleanup.js";
import { resolveReportArtifact } from "../storageArtifacts.js";
import { storageRuntime } from "../storageRuntime.js";
import { idParamsSchema } from "./schemas.js";

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reports", { preHandler: requireAuth }, async (req, reply) => {
    const rows = await storageRuntime().runs.listPublishedReports(getAccountId(req));
    return reply.send(rows.map(({ html_path: _htmlPath, pdf_path: _pdfPath, ...report }) => report));
  });

  app.get("/api/reports/:id", { preHandler: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const row = await storageRuntime().runs.getPublishedReport(getAccountId(req), (req.params as any).id);
    if (!row) return reply.code(404).send({ error: "report not found" });
    const [htmlArtifact, pdfArtifact] = await Promise.all([
      resolveReportArtifact({ accountId: getAccountId(req), reportId: row.id, filePath: row.html_path, kind: "html" }),
      resolveReportArtifact({ accountId: getAccountId(req), reportId: row.id, filePath: row.pdf_path, kind: "pdf" }),
    ]);
    return reply.send({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      created_at: row.created_at,
      updated_at: row.updated_at,
      has_html: Boolean(htmlArtifact),
      has_pdf: Boolean(pdfArtifact),
    });
  });

  app.get(
    "/api/reports/:id/html",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const row = await storageRuntime().runs.getPublishedReport(getAccountId(req), (req.params as any).id);
      if (!row) return reply.code(404).send({ error: "report not found" });
      const artifact = await resolveReportArtifact({
        accountId: getAccountId(req),
        reportId: (req.params as any).id,
        filePath: row.html_path,
        kind: "html",
      });
      if (!artifact) return reply.code(404).send({ error: "html not available" });
      return reply
        .header("Content-Security-Policy", REPORT_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .type("text/html")
        .send(await fs.readFile(artifact, "utf8"));
    }
  );

  app.get(
    "/api/reports/:id/pdf",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const row = await storageRuntime().runs.getPublishedReport(getAccountId(req), (req.params as any).id);
      if (!row) return reply.code(404).send({ error: "report not found" });
      const artifact = await resolveReportArtifact({
        accountId: getAccountId(req),
        reportId: (req.params as any).id,
        filePath: row.pdf_path,
        kind: "pdf",
      });
      if (!artifact) return reply.code(404).send({ error: "pdf not available" });
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${path.basename(artifact)}"`)
        .send(await fs.readFile(artifact));
    }
  );

  app.delete(
    "/api/reports/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const reportId = (req.params as any).id;
      let intent;
      try {
        intent = await storageRuntime().runs.reservePublishedReportDeletion(accountId, reportId);
      } catch (error) {
        if (error instanceof ArtifactNotFoundError) {
          return reply.code(404).send({ error: "report not found" });
        }
        throw error;
      }
      const cleanup = await completeReportArtifactCleanup([intent]);
      if (cleanup.failed) return reply.code(503).send({ error: "report cleanup deferred" });
      return reply.send({ ok: true });
    }
  );
}
