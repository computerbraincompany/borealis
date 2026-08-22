import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type { FastifyInstance } from "fastify";
import { requireAuth, getAccountId } from "./auth.js";
import { config } from "./config.js";
import { q } from "./db.js";
import { ingestSource } from "./ingest.js";
import { runAgent } from "./agent.js";
import { py } from "./pythonClient.js";

export async function routes(app: FastifyInstance) {
  await app.register(import("@fastify/multipart"), { limits: { fileSize: 150 * 1024 * 1024 } });

  app.addHook("onError", (req, reply, err, done) => {
    if (err.message === "unauthorized") reply.code(401).send({ error: "unauthorized" });
    else console.error("route error", err);
    done();
  });

  // ---------------------------------------------------------------- chats
  app.get("/api/chats", { preHandler: requireAuth }, async (req, reply) => {
    const rows = await q(`SELECT id, title, created_at FROM chats WHERE account_id=$1 ORDER BY created_at DESC`, [getAccountId(req)]);
    return reply.send(rows);
  });

  app.post("/api/chats", { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { title?: string };
    const [row] = await q(`INSERT INTO chats (id, account_id, title) VALUES ($1,$2,$3) RETURNING id, title, created_at`, [
      uuid(),
      getAccountId(req),
      body.title || "New chat",
    ]);
    return reply.send(row);
  });

  app.get("/api/chats/:id", { preHandler: requireAuth }, async (req, reply) => {
    const chatId = (req.params as any).id;
    const account = getAccountId(req);
    const [chat] = await q(`SELECT id, title, created_at FROM chats WHERE id=$1 AND account_id=$2`, [chatId, account]);
    if (!chat) return reply.code(404).send({ error: "chat not found" });
    const msgs = await q(`SELECT id, role, content, meta, created_at FROM messages WHERE chat_id=$1 ORDER BY id`, [chatId]);
    return reply.send({ ...chat, messages: msgs });
  });

  app.delete("/api/chats/:id", { preHandler: requireAuth }, async (req, reply) => {
    const chatId = (req.params as any).id;
    const account = getAccountId(req);
    const del = await q(`DELETE FROM chats WHERE id=$1 AND account_id=$2 RETURNING id`, [chatId, account]);
    if (!del.length) return reply.code(404).send({ error: "chat not found" });
    return reply.send({ ok: true });
  });

  // POST /api/chats/:id/messages  → SSE stream with the agent
  app.post("/api/chats/:id/messages", { preHandler: requireAuth }, async (req, reply) => {
    const chatId = (req.params as any).id;
    const account = getAccountId(req);
    const body = req.body as { content?: string };
    const content = (body.content || "").trim();
    if (!content) return reply.code(400).send({ error: "empty message" });

    const [chat] = await q(`SELECT id FROM chats WHERE id=$1 AND account_id=$2`, [chatId, account]);
    if (!chat) return reply.code(404).send({ error: "chat not found" });

    const [userMsg] = await q(`INSERT INTO messages (chat_id, role, content) VALUES ($1,'user',$2) RETURNING id`, [chatId, content]);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const emit = (ev: any) => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    emit({ type: "user-saved", message_id: userMsg.id });

    try {
      await runAgent({ accountId: account, chatId, content, emit });
    } catch (e: any) {
      emit({ type: "error", message: String(e?.message || e) });
    } finally {
      reply.raw.end();
    }
  });

  // ---------------------------------------------------------------- sources
  app.get("/api/sources", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const rows = await q(`SELECT * FROM sources WHERE account_id=$1 ORDER BY created_at DESC`, [account]);
    let tabular: any[] = [];
    try {
      tabular = await py.listDatasets(account);
    } catch {
      /* python down */
    }
    const tabularByName = new Map(tabular.map((t) => [t.table, t]));
    const out = rows.map((s) => ({ ...s, ...(s.name && tabularByName.has(s.name) ? { tabular: tabularByName.get(s.name) } : {}) }));
    return reply.send(out);
  });

  app.post("/api/sources/upload", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "no file" });
    const safeOriginal = path.basename(file.filename).replace(/[^\w.\- ]+/g, "_");
    const ts = Date.now();
    const dir = path.join(config.uploadDir, account.slice(0, 8));
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${ts}_${safeOriginal}`);
    await pipeline(file.file, createWriteStream(filePath));

    const base = path.basename(safeOriginal, path.extname(safeOriginal)).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "dataset";
    let name = base;
    let n = 1;
    const exists = await q(`SELECT name FROM sources WHERE account_id=$1 AND name=$2`, [account, name]);
    while (exists.length) {
      name = `${base}_${n++}`;
      const again = await q(`SELECT name FROM sources WHERE account_id=$1 AND name=$2`, [account, name]);
      if (!again.length) break;
    }
    const [src] = await q(
      `INSERT INTO sources (id, account_id, name, kind, display_name, file_path, mime, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'index') RETURNING *`,
      [uuid(), account, name, mimeKind(file.mimetype, filePath), safeOriginal, filePath, file.mimetype]
    );
    ingestSource({
      accountId: account,
      sourceId: src.id,
      name,
      filePath,
      mime: file.mimetype,
      kind: src.kind,
      displayName: safeOriginal,
    }).catch((e) => console.error("async ingest failed", e));
    return reply.send({ ...src, processing: true });
  });

  app.delete("/api/sources/:id", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const id = (req.params as any).id;
    const [src] = await q(`SELECT * FROM sources WHERE id=$1 AND account_id=$2`, [id, account]);
    if (!src) return reply.code(404).send({ error: "source not found" });
    await q(`DELETE FROM chunks WHERE source_id=$1`, [id]);
    if (src.connector) await q(`DELETE FROM connectors WHERE id=$1`, [src.connector]);
    try {
      if (src.file_path) await fs.unlink(src.file_path);
    } catch {}
    try {
      await py.deleteDataset(account, src.name);
    } catch {}
    await q(`DELETE FROM sources WHERE id=$1`, [id]);
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- connectors
  app.get("/api/connectors", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const rows = await q(`SELECT * FROM connectors WHERE account_id=$1 ORDER BY created_at DESC`, [account]);
    return reply.send(rows);
  });

  app.post("/api/connectors", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const body = req.body as { name?: string; type?: string; config?: any };
    const type = body.type || "url_csv";
    if (!["url_csv", "url_json"].includes(type))
      return reply.code(400).send({ error: "unsupported connector type" });
    const configVal = body.config || {};
    if (!configVal.url) return reply.code(400).send({ error: "config.url required" });
    const target = (body.name || "connector")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "connector";
    const [conn] = await q(
      `INSERT INTO connectors (id, account_id, name, type, config, target_table) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [uuid(), account, body.name, type, JSON.stringify(configVal), target]
    );
    try {
      await syncConnector(account, conn);
    } catch (e: any) {
      return reply.send({ ...conn, sync_error: String(e.message || e) });
    }
    return reply.send(conn);
  });

  app.post("/api/connectors/:id/sync", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const [conn] = await q(`SELECT * FROM connectors WHERE id=$1 AND account_id=$2`, [(req.params as any).id, account]);
    if (!conn) return reply.code(404).send({ error: "connector not found" });
    try {
      const r = await syncConnector(account, conn);
      return reply.send(r);
    } catch (e: any) {
      return reply.code(422).send({ error: String(e.message || e) });
    }
  });

  app.delete("/api/connectors/:id", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const [conn] = await q(`SELECT * FROM connectors WHERE id=$1 AND account_id=$2`, [(req.params as any).id, account]);
    if (!conn) return reply.code(404).send({ error: "connector not found" });
    // remove file artifacts (capture paths before the source rows are deleted)
    const paths = await q(`SELECT file_path FROM sources WHERE connector=$1`, [conn.id]).catch(() => []);
    for (const r of paths) if (r.file_path) await fs.unlink(r.file_path).catch(() => {});
    await q(`DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE connector=$1)`, [conn.id]);
    await q(`DELETE FROM sources WHERE connector=$1`, [conn.id]);
    try {
      await py.deleteDataset(account, conn.target_table);
    } catch {}
    await q(`DELETE FROM connectors WHERE id=$1`, [conn.id]);
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- reports
  app.get("/api/reports", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const rows = await q(
      `SELECT r.id, r.title, r.subtitle, r.created_at, r.updated_at, c.title AS chat_title, c.id AS chat_id
       FROM reports r LEFT JOIN chats c ON r.chat_id=c.id WHERE r.account_id=$1 ORDER BY r.created_at DESC`,
      [account]
    );
    return reply.send(rows);
  });

  app.get("/api/reports/:id", { preHandler: requireAuth }, async (req, reply) => {
    const [row] = await q(`SELECT id, title, subtitle, created_at, updated_at, html_path, pdf_path FROM reports WHERE id=$1 AND account_id=$2`, [
      (req.params as any).id,
      getAccountId(req),
    ]);
    if (!row) return reply.code(404).send({ error: "report not found" });
    const htmlExists = await fs.access(row.html_path).then(() => true).catch(() => false);
    const pdfExists = await fs.access(row.pdf_path).then(() => true).catch(() => false);
    return reply.send({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      created_at: row.created_at,
      updated_at: row.updated_at,
      has_html: htmlExists,
      has_pdf: pdfExists,
    });
  });

  app.get("/api/reports/:id/html", { preHandler: requireAuth }, async (req, reply) => {
    const [row] = await q(`SELECT html_path FROM reports WHERE id=$1 AND account_id=$2`, [(req.params as any).id, getAccountId(req)]);
    if (!row) return reply.code(404).send({ error: "report not found" });
    if (!row.html_path || !(await fs.access(row.html_path).then(() => true).catch(() => false)))
      return reply.code(404).send({ error: "html not available" });
    return reply.type("text/html").send(await fs.readFile(row.html_path, "utf8"));
  });

  app.get("/api/reports/:id/pdf", { preHandler: requireAuth }, async (req, reply) => {
    const [row] = await q(`SELECT pdf_path FROM reports WHERE id=$1 AND account_id=$2`, [(req.params as any).id, getAccountId(req)]);
    if (!row) return reply.code(404).send({ error: "report not found" });
    if (!row.pdf_path || !(await fs.access(row.pdf_path).then(() => true).catch(() => false)))
      return reply.code(404).send({ error: "pdf not available" });
    const buf = await fs.readFile(row.pdf_path);
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${row.pdf_path.split("/").pop()}"`)
      .send(buf);
  });

  app.delete("/api/reports/:id", { preHandler: requireAuth }, async (req, reply) => {
    const [row] = await q(`SELECT * FROM reports WHERE id=$1 AND account_id=$2`, [(req.params as any).id, getAccountId(req)]);
    if (!row) return reply.code(404).send({ error: "report not found" });
    for (const p of [row.html_path, row.pdf_path]) if (p) await fs.unlink(p).catch(() => {});
    await q(`DELETE FROM reports WHERE id=$1`, [row.id]);
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- charts
  app.get("/api/charts/:id", { preHandler: requireAuth }, async (req, reply) => {
    const [row] = await q(`SELECT id, spec, echarts FROM charts WHERE id=$1 AND account_id=$2`, [(req.params as any).id, getAccountId(req)]);
    if (!row) return reply.code(404).send({ error: "chart not found" });
    const res = await py.chart(getAccountId(req), row.spec);
    return reply.send({ id: row.id, spec: row.spec, echarts: row.echarts, png: res.png_base64 });
  });

  app.post("/api/charts/:id/png", { preHandler: requireAuth }, async (req, reply) => {
    const [row] = await q(`SELECT spec FROM charts WHERE id=$1 AND account_id=$2`, [(req.params as any).id, getAccountId(req)]);
    if (!row) return reply.code(404).send({ error: "chart not found" });
    const res = await py.chart(getAccountId(req), row.spec);
    return reply.send({ png_base64: res.png_base64 });
  });
}

function mimeKind(mime: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (mime.includes("csv") || ext === ".csv" || ext === ".tsv" || ext === ".xlsx" || ext === ".xls" || ext === ".parquet" || ext === ".jsonl") return "tabular";
  if (mime.includes("pdf") || ext === ".pdf") return "document";
  if (mime.includes("word") || ext === ".docx" || ext === ".doc") return "document";
  return "document";
}

async function syncConnector(account: string, conn: any): Promise<any> {
  const configVal = typeof conn.config === "string" ? JSON.parse(conn.config) : conn.config;
  let dset: any;
  if (conn.type === "url_csv") {
    const existing = (await py.listDatasets(account).catch(() => [])).find((d: any) => d.table === conn.target_table);
    dset = existing
      ? await py.resync(account, conn.target_table, configVal.url)
      : await py.registerDataset(account, conn.target_table, undefined, "url", configVal.url, configVal.name || conn.name);
  } else {
    dset = await py.registerDataset(account, conn.target_table, undefined, "url", configVal.url, configVal.name || conn.name);
  }
  // always regenerate RAG chunks from the fetched content
  const [src] = await q(`SELECT id, file_path, name FROM sources WHERE account_id=$1 AND connector=$2`, [account, conn.id]);
  const display = configVal.name || conn.name;
  if (src) {
    await ingestSource({
      accountId: account,
      sourceId: src.id,
      name: src.name,
      filePath: src.file_path,
      mime: "text/csv",
      kind: src.kind,
      displayName: display,
      url: configVal.url,
      connector: conn.id,
    });
    await q(`UPDATE sources SET status='ready', connector=$2 WHERE id=$1`, [src.id, conn.id]);
  } else {
    const [created] = await q(
      `INSERT INTO sources (id, account_id, name, kind, connector, display_name, file_path, url, mime, status)
       VALUES ($1,$2,$3,'tabular',$4,$5,$6,$7,'text/csv','ready') RETURNING *`,
      [uuid(), account, conn.target_table, conn.id, display, (dset && dset.location) || "", configVal.url]
    );
    await ingestSource({
      accountId: account,
      sourceId: created.id,
      name: conn.target_table,
      filePath: created.file_path,
      mime: "text/csv",
      kind: created.kind,
      displayName: display,
      url: configVal.url,
      connector: conn.id,
    });
  }
  await q(`UPDATE connectors SET last_sync=now() WHERE id=$1`, [conn.id]);
  return { synced: true };
}
