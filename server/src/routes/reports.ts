import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { catalogPageQuerySchema, catalogResponse, parseCatalogPageQuery } from "../catalogPagination.js";
import { REPORT_CSP } from "../data/reports.js";
import { ArtifactNotFoundError, type PublishedReport } from "../db/stores/runStore.js";
import { completeReportArtifactCleanup } from "../reportCleanup.js";
import { resolveReportArtifact } from "../storageArtifacts.js";
import { storageRuntime } from "../storageRuntime.js";
import { BODYLESS_MUTATION_LIMIT_BYTES, COMPACT_JSON_BODY_LIMIT_BYTES } from "./bodyLimits.js";
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
  app.get(
    "/api/reports",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const page = await storageRuntime().runs.listPublishedReports(
        getAccountId(req),
        parseCatalogPageQuery("reports", req.query)
      );
      return reply.send(catalogResponse("reports", { items: page.items.map(publicReport), next: page.next }));
    }
  );

  app.get("/api/reports/:id", { onRequest: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const accountId = getAccountId(req);
    let row = await storageRuntime().runs.getPublishedReport(accountId, (req.params as any).id);
    let sharedByAccount = false;
    let ownerId = accountId;
    if (!row) {
      ownerId = (await storageRuntime().runs.getReportShareOwner(accountId, (req.params as any).id)) ?? "";
      if (ownerId) {
        row = await storageRuntime().runs.getPublishedReport(ownerId, (req.params as any).id);
        sharedByAccount = row !== undefined;
      }
    }
    if (!row) return reply.code(404).send({ error: "report not found" });
    const [htmlArtifact, pdfArtifact] = await Promise.all([
      resolveReportArtifact({ accountId: ownerId, reportId: row.id, filePath: row.html_path, kind: "html" }),
      resolveReportArtifact({ accountId: ownerId, reportId: row.id, filePath: row.pdf_path, kind: "pdf" }),
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
      ...(sharedByAccount ? { shared_by_account: true } : {}),
      // The stored normalized payload stays owner-only; share recipients never see it.
      ...(sharedByAccount || row.payload === undefined ? {} : { payload: row.payload }),
    });
  });

  app.patch(
    "/api/reports/:id",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: reportRenameSchema },
    },
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
    { onRequest: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const reportId = (req.params as any).id;
      let row = await storageRuntime().runs.getPublishedReport(accountId, reportId);
      let ownerId = accountId;
      if (!row) {
        // Share recipients read through the owner's account scope, never their own.
        ownerId = (await storageRuntime().runs.getReportShareOwner(accountId, reportId)) ?? "";
        if (ownerId) row = await storageRuntime().runs.getPublishedReport(ownerId, reportId);
      }
      if (!row) return reply.code(404).send({ error: "report not found" });
      const artifact = await resolveReportArtifact({
        accountId: ownerId,
        reportId,
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
    { onRequest: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const reportId = (req.params as any).id;
      let row = await storageRuntime().runs.getPublishedReport(accountId, reportId);
      let ownerId = accountId;
      if (!row) {
        // Share recipients read through the owner's account scope, never their own.
        ownerId = (await storageRuntime().runs.getReportShareOwner(accountId, reportId)) ?? "";
        if (ownerId) row = await storageRuntime().runs.getPublishedReport(ownerId, reportId);
      }
      if (!row) return reply.code(404).send({ error: "report not found" });
      const artifact = await resolveReportArtifact({
        accountId: ownerId,
        reportId,
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

  app.post(
    "/api/reports/:id/shares",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["recipient_account_id"],
          additionalProperties: false,
          properties: {
            recipient_account_id: {
              type: "string",
              pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const shared = await storageRuntime().runs.shareReport(
          getAccountId(req),
          (req.params as any).id,
          (req.body as any).recipient_account_id
        );
        return reply.code(201).send(shared);
      } catch (error) {
        if (error instanceof ArtifactNotFoundError) return reply.code(404).send({ error: "report not found" });
        if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    }
  );

  app.get(
    "/api/reports/:id/shares",
    { onRequest: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      return reply.send(await storageRuntime().runs.listReportShares(getAccountId(req), (req.params as any).id));
    }
  );

  app.delete(
    "/api/reports/:id/shares/:recipient",
    {
      onRequest: requireAuth,
      bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES,
      schema: {
        params: {
          type: "object",
          required: ["id", "recipient"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            },
            recipient: {
              type: "string",
              pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            },
          },
        },
      },
    },
    async (req, reply) => {
      const revoked = await storageRuntime().runs.revokeReportShare(
        getAccountId(req),
        (req.params as any).id,
        (req.params as any).recipient
      );
      if (!revoked) return reply.code(404).send({ error: "share not found" });
      return reply.send({ ok: true });
    }
  );

  app.get(
    "/api/reports/shared",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const page = await storageRuntime().runs.listSharedReports(
        getAccountId(req),
        parseCatalogPageQuery("shared_reports", req.query)
      );
      return reply.send(catalogResponse("shared_reports", page));
    }
  );

  app.delete(
    "/api/reports/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
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
