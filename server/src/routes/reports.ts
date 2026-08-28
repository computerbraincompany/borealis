import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { REPORT_CSP } from "../data/reports.js";
import { ArtifactNotFoundError, type PublishedReport } from "../db/stores/runStore.js";
import { completeReportArtifactCleanup } from "../reportCleanup.js";
import { resolveReportArtifact } from "../storageArtifacts.js";
import { storageRuntime } from "../storageRuntime.js";
import { idParamsSchema } from "./schemas.js";

const reportRenameSchema = {
  type: "object",
  required: ["title"],
  additionalProperties: false,
  properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

/** The list/rename DTO: report metadata and lineage, never filesystem paths. */
function publicReport(row: PublishedReport) {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    chat_id: row.chat_id,
    chat_title: row.chat_title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
    supersedes: row.supersedes,
  };
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reports", { preHandler: requireAuth }, async (req, reply) => {
    const rows = await storageRuntime().runs.listPublishedReports(getAccountId(req));
    return reply.send(rows.map(publicReport));
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
      version: row.version,
      supersedes: row.supersedes,
      ...(row.payload === undefined ? {} : { payload: row.payload }),
    });
  });

  app.patch(
    "/api/reports/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema, body: reportRenameSchema } },
    async (req, reply) => {
      const row = await storageRuntime().runs.renamePublishedReport(
        getAccountId(req),
        (req.params as any).id,
        (req.body as any).title
      );
      if (!row) return reply.code(404).send({ error: "report not found" });
      return reply.send(publicReport(row));
    }
  );

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
