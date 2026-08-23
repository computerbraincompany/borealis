import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { q } from "../db.js";
import { idParamsSchema } from "./schemas.js";

export async function chartRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/charts/:id", { preHandler: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const [row] = await q(
      `SELECT id, spec, echarts, png_base64 FROM charts
       WHERE id=$1 AND account_id=$2 AND status='published'`,
      [(req.params as any).id, getAccountId(req)]
    );
    if (!row) return reply.code(404).send({ error: "chart not found" });
    return reply.send({ id: row.id, spec: row.spec, echarts: row.echarts, png_base64: row.png_base64 });
  });

  app.post(
    "/api/charts/:id/png",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const [row] = await q(`SELECT png_base64 FROM charts WHERE id=$1 AND account_id=$2 AND status='published'`, [
        (req.params as any).id,
        getAccountId(req),
      ]);
      if (!row) return reply.code(404).send({ error: "chart not found" });
      if (!row.png_base64) return reply.code(404).send({ error: "chart export not available" });
      return reply.send({ png_base64: row.png_base64 });
    }
  );
}
