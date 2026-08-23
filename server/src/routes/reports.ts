import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { pool, q } from "../db.js";
import { removeReportArtifacts, resolveReportArtifact } from "../storageArtifacts.js";
import { idParamsSchema } from "./schemas.js";

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reports", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const rows = await q(
      `SELECT r.id, r.title, r.subtitle, r.created_at, r.updated_at, c.title AS chat_title, c.id AS chat_id
       FROM reports r LEFT JOIN chats c ON r.chat_id=c.id
       WHERE r.account_id=$1 AND r.status='published' ORDER BY r.created_at DESC`,
      [account]
    );
    return reply.send(rows);
  });

  app.get("/api/reports/:id", { preHandler: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const [row] = await q(
      `SELECT id, title, subtitle, created_at, updated_at, html_path, pdf_path
       FROM reports WHERE id=$1 AND account_id=$2 AND status='published'`,
      [(req.params as any).id, getAccountId(req)]
    );
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
      const [row] = await q(`SELECT html_path FROM reports WHERE id=$1 AND account_id=$2 AND status='published'`, [
        (req.params as any).id,
        getAccountId(req),
      ]);
      if (!row) return reply.code(404).send({ error: "report not found" });
      const artifact = await resolveReportArtifact({
        accountId: getAccountId(req),
        reportId: (req.params as any).id,
        filePath: row.html_path,
        kind: "html",
      });
      if (!artifact) return reply.code(404).send({ error: "html not available" });
      return reply
        .header(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
            "img-src data:; connect-src 'none'; " +
            "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        )
        .header("X-Content-Type-Options", "nosniff")
        .type("text/html")
        .send(await fs.readFile(artifact, "utf8"));
    }
  );

  app.get(
    "/api/reports/:id/pdf",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const [row] = await q(`SELECT pdf_path FROM reports WHERE id=$1 AND account_id=$2 AND status='published'`, [
        (req.params as any).id,
        getAccountId(req),
      ]);
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
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("BEGIN");
        inTransaction = true;
        const selected = await client.query(
          `SELECT id, html_path, pdf_path FROM reports
           WHERE id=$1 AND account_id=$2 AND status='published' FOR UPDATE`,
          [reportId, accountId]
        );
        const row = selected.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return reply.code(404).send({ error: "report not found" });
        }
        // Remove the proven UUID-scoped files while the durable row remains.
        // A crash can therefore be retried through this endpoint instead of
        // orphaning files after a DB-first delete.
        await removeReportArtifacts({
          accountId,
          reportId: row.id,
          htmlPath: row.html_path,
          pdfPath: row.pdf_path,
        });
        await client.query(`DELETE FROM reports WHERE id=$1 AND account_id=$2 AND status='published'`, [
          reportId,
          accountId,
        ]);
        await client.query("COMMIT");
        inTransaction = false;
      } catch (error) {
        if (inTransaction) await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return reply.send({ ok: true });
    }
  );
}
