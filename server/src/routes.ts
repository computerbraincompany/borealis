import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type { FastifyInstance } from "fastify";
import { requireAuth, getAccountId } from "./auth.js";
import { config } from "./config.js";
import { pool, q } from "./db.js";
import { ingestSource, isTabularSource, sanitizeDatasetName } from "./ingest.js";
import { runAgent } from "./agent.js";
import { discoverChatModels } from "./llm.js";
import { py } from "./pythonClient.js";
import {
  assertSelectedSourcesAvailable,
  parseSourceScopeInput,
  replaceChatSourceScope,
  resolveChatSourceScope,
  SourceScopeError,
  type SourceScopeInput,
} from "./sourceScope.js";
import { acceptChatTurn } from "./turnContext.js";

export async function routes(app: FastifyInstance) {
  await app.register(import("@fastify/multipart"), { limits: { fileSize: 150 * 1024 * 1024 } });

  app.addHook("onError", (req, reply, err, done) => {
    if (err.message === "unauthorized") reply.code(401).send({ error: "unauthorized" });
    else console.error("route error", err);
    done();
  });

  // --------------------------------------------------------------- models
  app.get("/api/models", { preHandler: requireAuth }, async (req, reply) => {
    const refresh = (req.query as { refresh?: unknown }).refresh === "1";
    const result = await discoverChatModels({ refresh });
    return reply.send({
      models: result.models,
      default_model: config.chatModel,
      discovery: result.discovery,
    });
  });

  // ---------------------------------------------------------------- chats
  app.get("/api/chats", { preHandler: requireAuth }, async (req, reply) => {
    const rows = await q(`SELECT id, title, model, source_mode, created_at FROM chats WHERE account_id=$1 ORDER BY created_at DESC`, [getAccountId(req)]);
    return reply.send(rows);
  });

  app.post("/api/chats", { preHandler: requireAuth }, async (req, reply) => {
    let parsed: { title: string; scope: SourceScopeInput };
    try {
      parsed = parseChatCreateBody(req.body);
    } catch (error) {
      return sendSourceScopeError(reply, error);
    }
    const accountId = getAccountId(req);
    const chatId = uuid();

    // A legacy/all chat needs only one statement, which is already atomic.
    if (parsed.scope.source_mode === "all") {
      const [row] = await q(
        `INSERT INTO chats (id, account_id, title, model, source_mode)
         VALUES ($1,$2,$3,$4,'all')
         RETURNING id, title, model, source_mode, created_at`,
        [chatId, accountId, parsed.title, config.chatModel]
      );
      return reply.send(row);
    }

    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      await assertSelectedSourcesAvailable(client, accountId, parsed.scope.source_ids);
      const insert = await client.query(
        `INSERT INTO chats (id, account_id, title, model, source_mode)
         VALUES ($1,$2,$3,$4,'selected')
         RETURNING id, title, model, source_mode, created_at`,
        [chatId, accountId, parsed.title, config.chatModel]
      );
      if (parsed.scope.source_ids.length) {
        await client.query(
          `INSERT INTO chat_sources (chat_id, source_id, account_id)
           SELECT $1, source_id, $2 FROM unnest($3::uuid[]) AS selected(source_id)`,
          [chatId, accountId, parsed.scope.source_ids]
        );
      }
      await client.query("COMMIT");
      inTransaction = false;
      return reply.send(insert.rows[0]);
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK").catch(() => {});
      return sendSourceScopeError(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/api/chats/:id", { preHandler: requireAuth }, async (req, reply) => {
    const chatId = (req.params as any).id;
    const account = getAccountId(req);
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      const chatResult = await client.query(
        `SELECT id, title, model, created_at FROM chats WHERE id=$1 AND account_id=$2`,
        [chatId, account]
      );
      const chat = chatResult.rows[0];
      if (!chat) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return reply.code(404).send({ error: "chat not found" });
      }
      const sourceScope = await resolveChatSourceScope(client, account, chatId);
      const msgs = await client.query(
        `SELECT id, role, content, meta, created_at FROM messages WHERE chat_id=$1 ORDER BY id`,
        [chatId]
      );
      await client.query("COMMIT");
      inTransaction = false;
      return reply.send({ ...chat, source_mode: sourceScope.mode, sources: sourceScope.attached, messages: msgs.rows });
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK").catch(() => {});
      return sendSourceScopeError(reply, error);
    } finally {
      client.release();
    }
  });

  app.put("/api/chats/:id/sources", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const sourceScope = await replaceChatSourceScope(
        getAccountId(req),
        (req.params as any).id,
        req.body
      );
      return reply.send({ source_mode: sourceScope.mode, sources: sourceScope.attached });
    } catch (error) {
      return sendSourceScopeError(reply, error);
    }
  });

  app.patch("/api/chats/:id", { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "body must contain exactly model" });
    }
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "model" || typeof (body as { model?: unknown }).model !== "string") {
      return reply.code(400).send({ error: "body must contain exactly model" });
    }
    const model = (body as { model: string }).model.trim();
    if (model.length < 1 || model.length > 256) {
      return reply.code(400).send({ error: "model must contain between 1 and 256 characters" });
    }
    if (model === config.embedModel) {
      return reply.code(400).send({ error: "embedding model cannot be selected for chat" });
    }

    const [chat] = await q(
      `UPDATE chats SET model=$3 WHERE id=$1 AND account_id=$2
       RETURNING id, title, model, source_mode, created_at`,
      [(req.params as any).id, getAccountId(req), model]
    );
    if (!chat) return reply.code(404).send({ error: "chat not found" });
    return reply.send(chat);
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
    const body = req.body as { content?: unknown } | undefined;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) return reply.code(400).send({ error: "empty message" });
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "content")) {
      return reply.code(400).send({ error: "message body must contain only content" });
    }

    let turn;
    try {
      turn = await acceptChatTurn(account, chatId, content);
    } catch (error) {
      return sendSourceScopeError(reply, error);
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const emit = (ev: any) => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    emit({ type: "user-saved", message_id: turn.userMessage.id });

    try {
      await runAgent({ accountId: account, ...turn, content: turn.userMessage.content, emit });
    } catch (error: unknown) {
      console.warn("agent run failed", safeAgentFailureSummary(error));
      emit({ type: "error", message: publicAgentFailureMessage() });
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

    const base = sanitizeDatasetName(safeOriginal);
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

  app.post("/api/sources/:id/reingest", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const id = (req.params as any).id;
    const [src] = await q(`SELECT * FROM sources WHERE id=$1 AND account_id=$2`, [id, account]);
    if (!src) return reply.code(404).send({ error: "source not found" });
    if (!src.file_path) return reply.code(400).send({ error: "source has no uploaded file" });

    let name = src.name;
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
      const base = sanitizeDatasetName(src.display_name || name);
      name = base;
      let n = 1;
      while ((await q(`SELECT 1 FROM sources WHERE account_id=$1 AND name=$2 AND id<>$3`, [account, name, id])).length) {
        name = `${base}_${n++}`;
      }
    }
    const [updated] = await q(
      `UPDATE sources SET name=$2, status='index', meta = meta - 'error' WHERE id=$1 RETURNING *`,
      [id, name]
    );
    ingestSource({
      accountId: account,
      sourceId: src.id,
      name,
      filePath: src.file_path,
      mime: src.mime || "application/octet-stream",
      kind: src.kind,
      displayName: src.display_name,
      url: src.url || undefined,
      connector: src.connector || undefined,
    }).catch((e) => console.error("async reingest failed", e));
    return reply.send({ ...updated, processing: true });
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
    // Keep in sync with python/app/reports.py CSP.
    return reply
      .header(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
          + "img-src data:; connect-src 'none'; "
          + "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
      )
      .header("X-Content-Type-Options", "nosniff")
      .type("text/html")
      .send(await fs.readFile(row.html_path, "utf8"));
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

function parseChatCreateBody(body: unknown): { title: string; scope: SourceScopeInput } {
  const value = body ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceScopeError(400, "invalid chat body");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["title", "source_mode", "source_ids"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new SourceScopeError(400, "invalid chat body");
  }
  if (record.title !== undefined && typeof record.title !== "string") {
    throw new SourceScopeError(400, "invalid chat body");
  }
  const title = (record.title as string | undefined) || "New chat";
  const hasMode = Object.prototype.hasOwnProperty.call(record, "source_mode");
  const hasIds = Object.prototype.hasOwnProperty.call(record, "source_ids");
  const scope = !hasMode && !hasIds
    ? { source_mode: "all" as const }
    : parseSourceScopeInput(Object.fromEntries(
        Object.entries(record).filter(([key]) => key === "source_mode" || key === "source_ids")
      ));
  return { title, scope };
}

function sendSourceScopeError(reply: any, error: unknown) {
  if (error instanceof SourceScopeError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  throw error;
}

export function publicAgentFailureMessage(): string {
  return "The selected model could not complete this turn. Check the saved model and endpoint logs, then try again.";
}

function safeAgentFailureSummary(error: unknown): { name: string; status?: number; code?: string } {
  if (!error || typeof error !== "object") return { name: "UnknownError" };
  const value = error as { name?: unknown; status?: unknown; code?: unknown };
  const stableLabel = (candidate: unknown): string | undefined => {
    if (typeof candidate !== "string") return undefined;
    return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(candidate) ? candidate : undefined;
  };
  const code = stableLabel(value.code);
  return {
    name: stableLabel(value.name) ?? "Error",
    ...(typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
      ? { status: value.status }
      : {}),
    ...(code ? { code } : {}),
  };
}

function mimeKind(mime: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (isTabularSource(filePath, mime)) return "tabular";
  if (mime.includes("pdf") || ext === ".pdf") return "document";
  if (mime.includes("word") || ext === ".docx" || ext === ".doc") return "document";
  return "document";
}

async function syncConnector(account: string, conn: any): Promise<any> {
  const configVal = typeof conn.config === "string" ? JSON.parse(conn.config) : conn.config;
  const [src] = await q(
    `SELECT id, file_path, name, kind FROM sources WHERE account_id=$1 AND connector=$2`,
    [account, conn.id]
  );
  const display = configVal.name || conn.name;
  let dset: any;
  if (src) {
    dset = await py.resync(account, conn.target_table, configVal.url, display);
  } else {
    dset = await py.registerDataset(account, conn.target_table, {
      kind: "url",
      url: configVal.url,
      originalName: display,
    });
  }
  // always regenerate RAG chunks from the fetched content
  if (src) {
    const refreshedFilePath = typeof dset?.location === "string" && dset.location
      ? dset.location
      : src.file_path;
    if (refreshedFilePath !== src.file_path) {
      await q(`UPDATE sources SET file_path=$2 WHERE id=$1 AND account_id=$3`, [src.id, refreshedFilePath, account]);
    }
    await ingestSource({
      accountId: account,
      sourceId: src.id,
      name: src.name,
      filePath: refreshedFilePath,
      mime: "text/csv",
      kind: src.kind,
      displayName: display,
      url: configVal.url,
      connector: conn.id,
    });
  } else {
    const [created] = await q(
      `INSERT INTO sources (id, account_id, name, kind, connector, display_name, file_path, url, mime, status)
       VALUES ($1,$2,$3,'tabular',$4,$5,$6,$7,'text/csv','index') RETURNING *`,
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
