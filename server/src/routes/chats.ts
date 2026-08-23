import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { runAgent } from "../agent.js";
import { getAccountId, requireAuth } from "../auth.js";
import { beginRun, cancelRun, completeRunWithAssistant, finishRunDurably, isRunCancellation } from "../chatRuns.js";
import { config } from "../config.js";
import { pool, q } from "../db.js";
import {
  assertSelectedSourcesAvailable,
  parseSourceScopeInput,
  replaceChatSourceScope,
  resolveChatSourceScope,
  SourceScopeError,
  type SourceScopeInput,
} from "../sourceScope.js";
import { acceptChatTurn } from "../turnContext.js";
import { currentRequestId } from "../requestContext.js";
import {
  UUID_PATTERN,
  chatCreateBodySchema,
  chatPatchBodySchema,
  idParamsSchema,
  sourceScopeBodySchema,
} from "./schemas.js";

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/chats",
    { preHandler: requireAuth, schema: { tags: ["chats"], summary: "List chats" } },
    async (req, reply) => {
      const rows = await q(
        `SELECT id, title, model, source_mode, created_at, updated_at
       FROM chats WHERE account_id=$1 ORDER BY updated_at DESC, id DESC`,
        [getAccountId(req)]
      );
      return reply.send(rows);
    }
  );

  app.post(
    "/api/chats",
    {
      preHandler: requireAuth,
      bodyLimit: 16 * 1024,
      schema: { tags: ["chats"], summary: "Create a chat", body: chatCreateBodySchema },
    },
    async (req, reply) => {
      let parsed: { title: string; titleIsManual: boolean; scope: SourceScopeInput };
      try {
        parsed = parseChatCreateBody(req.body);
      } catch (error) {
        return sendSourceScopeError(reply, error);
      }
      const accountId = getAccountId(req);
      const chatId = randomUUID();
      if (parsed.scope.source_mode === "all") {
        const [row] = await q(
          `INSERT INTO chats (id, account_id, title, title_is_manual, model, source_mode)
         VALUES ($1,$2,$3,$4,$5,'all')
         RETURNING id, title, model, source_mode, created_at, updated_at`,
          [chatId, accountId, parsed.title, parsed.titleIsManual, config.chatModel]
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
          `INSERT INTO chats (id, account_id, title, title_is_manual, model, source_mode)
         VALUES ($1,$2,$3,$4,$5,'selected')
         RETURNING id, title, model, source_mode, created_at, updated_at`,
          [chatId, accountId, parsed.title, parsed.titleIsManual, config.chatModel]
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
    }
  );

  app.get(
    "/api/chats/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chats"],
        summary: "Get a chat with a bounded newest-first history page",
        params: idParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            before_message_id: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const chatId = (req.params as any).id;
      const accountId = getAccountId(req);
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        inTransaction = true;
        const chatResult = await client.query(
          `SELECT id, title, model, created_at, updated_at FROM chats WHERE id=$1 AND account_id=$2`,
          [chatId, accountId]
        );
        const chat = chatResult.rows[0];
        if (!chat) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return reply.code(404).send({ error: "chat not found" });
        }
        const sourceScope = await resolveChatSourceScope(client, accountId, chatId);
        const query = req.query as { before_message_id?: unknown; limit?: unknown };
        const beforeId = parseOptionalPositiveInteger(query.before_message_id, "before_message_id");
        const limit = parseLimit(query.limit, Math.min(config.maxHistoryMessages, 100), 100);
        const messages = await client.query(
          `SELECT id, role, content, content_was_truncated, meta, created_at FROM (
             SELECT id, role, left(content,$4) AS content,
                    length(content)>$4 AS content_was_truncated,
                    CASE WHEN octet_length(meta::text)<=$5 THEN meta
                         ELSE '{"metadata_truncated":true}'::jsonb END AS meta,
                    created_at FROM messages
             WHERE chat_id=$1 AND ($2::bigint IS NULL OR id < $2)
             ORDER BY id DESC LIMIT $3
           ) page ORDER BY id`,
          [chatId, beforeId, limit + 1, config.maxMessageChars, MAX_HISTORY_MESSAGE_META_CHARS]
        );
        const activeRunResult = await client.query(
          `SELECT id, status FROM chat_runs
           WHERE chat_id=$1 AND account_id=$2 AND status IN ('running','cancelling')
           ORDER BY created_at DESC LIMIT 1`,
          [chatId, accountId]
        );
        await client.query("COMMIT");
        inTransaction = false;
        const bounded = buildHistoryPage(messages.rows, limit, config.maxHistoryChars, config.maxMessageChars);
        return reply.send({
          ...chat,
          source_mode: sourceScope.mode,
          sources: sourceScope.attached,
          messages: bounded.messages,
          active_run: activeRunResult.rows[0] ?? null,
          messages_page: {
            has_more: bounded.hasMore,
            next_before_message_id: bounded.hasMore ? (bounded.messages[0]?.id ?? null) : null,
          },
        });
      } catch (error) {
        if (inTransaction) await client.query("ROLLBACK").catch(() => {});
        return sendSourceScopeError(reply, error);
      } finally {
        client.release();
      }
    }
  );

  app.put(
    "/api/chats/:id/sources",
    {
      preHandler: requireAuth,
      bodyLimit: 16 * 1024,
      schema: {
        tags: ["chats"],
        summary: "Replace a chat source scope",
        params: idParamsSchema,
        body: sourceScopeBodySchema,
      },
    },
    async (req, reply) => {
      try {
        const sourceScope = await replaceChatSourceScope(getAccountId(req), (req.params as any).id, req.body);
        return reply.send({ source_mode: sourceScope.mode, sources: sourceScope.attached });
      } catch (error) {
        return sendSourceScopeError(reply, error);
      }
    }
  );

  app.patch(
    "/api/chats/:id",
    {
      preHandler: requireAuth,
      bodyLimit: 4 * 1024,
      schema: {
        tags: ["chats"],
        summary: "Update a chat title or model",
        params: idParamsSchema,
        body: chatPatchBodySchema,
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.code(400).send({ error: "body must contain exactly one of model or title" });
      }
      const keys = Object.keys(body);
      if (keys.length !== 1 || (keys[0] !== "model" && keys[0] !== "title")) {
        return reply.code(400).send({ error: "body must contain exactly one of model or title" });
      }
      const chatId = (req.params as any).id;
      const accountId = getAccountId(req);
      let chat;
      if (keys[0] === "model") {
        if (typeof (body as { model?: unknown }).model !== "string") {
          return reply.code(400).send({ error: "model must contain between 1 and 256 characters" });
        }
        const model = (body as { model: string }).model.trim();
        if (model.length < 1 || model.length > 256) {
          return reply.code(400).send({ error: "model must contain between 1 and 256 characters" });
        }
        if (model === config.embedModel)
          return reply.code(400).send({ error: "embedding model cannot be selected for chat" });
        [chat] = await q(
          `UPDATE chats SET model=$3 WHERE id=$1 AND account_id=$2
         RETURNING id, title, model, source_mode, created_at, updated_at`,
          [chatId, accountId, model]
        );
      } else {
        let title: string;
        try {
          title = parseChatTitle((body as { title?: unknown }).title);
        } catch (error) {
          return sendSourceScopeError(reply, error);
        }
        [chat] = await q(
          `UPDATE chats SET title=$3, title_is_manual=true, updated_at=now()
         WHERE id=$1 AND account_id=$2
         RETURNING id, title, model, source_mode, created_at, updated_at`,
          [chatId, accountId, title]
        );
      }
      if (!chat) return reply.code(404).send({ error: "chat not found" });
      return reply.send(chat);
    }
  );

  app.delete("/api/chats/:id", { preHandler: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const chatId = (req.params as any).id;
    const accountId = getAccountId(req);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(`SELECT id FROM chats WHERE id=$1 AND account_id=$2 FOR UPDATE`, [
        chatId,
        accountId,
      ]);
      if (!selected.rows.length) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "chat not found" });
      }
      const active = await client.query(
        `SELECT id FROM chat_runs
         WHERE chat_id=$1 AND account_id=$2 AND status IN ('running','cancelling') LIMIT 1`,
        [chatId, accountId]
      );
      if (active.rows.length) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "chat has an active run" });
      }
      await client.query(`DELETE FROM chats WHERE id=$1 AND account_id=$2`, [chatId, accountId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return reply.send({ ok: true });
  });

  app.post(
    "/api/chats/:id/messages",
    {
      preHandler: requireAuth,
      // A legal JSON string can require twelve transport bytes per code point
      // when an astral scalar is encoded as a UTF-16 surrogate pair
      // (`\\ud83d\\ude00`). Keep the parser boundary aligned with the decoded
      // code-point limit plus a small fixed object envelope.
      bodyLimit: config.maxMessageChars * 12 + 4_096,
      schema: {
        tags: ["chat-runs"],
        summary: "Accept a turn and stream a durable agent run over SSE",
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["content"],
          additionalProperties: false,
          properties: { content: { type: "string", minLength: 1, maxLength: config.maxMessageChars } },
        },
        response: {
          200: {
            description: "Server-sent events for the accepted durable run",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          400: {
            description: "Invalid message",
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
          },
          413: {
            description: "Message exceeds the configured boundary",
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      const chatId = (req.params as any).id;
      const accountId = getAccountId(req);
      const body = req.body as { content?: unknown } | undefined;
      const content = typeof body?.content === "string" ? body.content.trim() : "";
      if (!content) return reply.code(400).send({ error: "empty message" });
      if (Array.from(content).length > config.maxMessageChars) {
        return reply.code(413).send({ error: `message exceeds ${config.maxMessageChars} characters` });
      }
      let turn;
      try {
        turn = await acceptChatTurn(accountId, chatId, content);
      } catch (error) {
        return sendSourceScopeError(reply, error);
      }

      // Install the controller before publishing the run id, closing the gap
      // where a client could request cancellation before AbortSignal existed.
      const controller = await beginRun(accountId, chatId, turn.runId);
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const emit = (event: any) => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      emit({ type: "run-started", run_id: turn.runId });
      emit({ type: "user-saved", message_id: turn.userMessage.id });
      try {
        const completion = await runAgent({
          accountId,
          ...turn,
          content: turn.userMessage.content,
          emit,
          signal: controller.signal,
        });
        const terminal = await completeRunWithAssistant(accountId, chatId, turn.runId, completion);
        if (terminal.status === "completed" && terminal.message) {
          emit({ type: "delta", text: terminal.message.content });
          emit({
            type: "message",
            roles: [],
            content: terminal.message.content,
            meta: terminal.message.meta,
            message_id: terminal.message.id,
          });
          emit({ type: "done" });
        }
        emit({ type: "run-ended", run_id: turn.runId, status: terminal.status });
      } catch (error) {
        if (isRunCancellation(error)) {
          const terminal = await finishRunDurably(accountId, chatId, turn.runId, "cancelled", "CANCELLED");
          emit({ type: "run-ended", run_id: turn.runId, status: terminal });
        } else {
          req.log.warn({ request_id: currentRequestId(), ...safeAgentFailureSummary(error) }, "agent run failed");
          const terminal = await finishRunDurably(accountId, chatId, turn.runId, "failed", "AGENT_FAILED");
          if (terminal === "failed") emit({ type: "error", message: publicAgentFailureMessage() });
          emit({ type: "run-ended", run_id: turn.runId, status: terminal });
        }
      } finally {
        reply.raw.end();
      }
    }
  );

  app.delete(
    "/api/chats/:id/runs/:runId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["chat-runs"],
        summary: "Cancel an active chat run",
        params: {
          type: "object",
          required: ["id", "runId"],
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
            runId: { type: "string", pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string; runId: string };
      const status = await cancelRun(getAccountId(req), params.id, params.runId);
      if (!status) return reply.code(404).send({ error: "run not found" });
      return reply.send({ ok: true, run_id: params.runId, status });
    }
  );
}

const MAX_HISTORY_MESSAGE_META_CHARS = 32_000;

export function buildHistoryPage(
  chronologicalRows: readonly any[],
  limit: number,
  maxChars: number,
  maxMessageChars: number
): { messages: any[]; hasMore: boolean } {
  const newestFirst = [...chronologicalRows].reverse();
  const acceptedNewestFirst: any[] = [];
  // Account for the enclosing JSON array and inter-row commas as well as each
  // projected message object.
  let used = 2;
  let hasMore = false;
  for (let rowIndex = 0; rowIndex < newestFirst.length; rowIndex += 1) {
    const row = newestFirst[rowIndex];
    if (acceptedNewestFirst.length >= limit) {
      hasMore = true;
      break;
    }
    const rawContent = typeof row.content === "string" ? row.content : "";
    const contentCodePoints = Array.from(rawContent);
    const content = contentCodePoints.slice(0, maxMessageChars).join("");
    const sourceWasTruncated = Boolean(row.content_was_truncated || contentCodePoints.length > maxMessageChars);
    let meta = boundedHistoryMeta(row.meta);
    if (sourceWasTruncated) meta = markHistoryContentTruncated(meta);
    let bounded = { ...row, content, meta };
    delete bounded.content_was_truncated;
    let cost = JSON.stringify(bounded).length + (acceptedNewestFirst.length ? 1 : 0);
    if (used + cost > maxChars) {
      if (acceptedNewestFirst.length === 0) {
        // Even a legal message can expand substantially when JSON escapes
        // control characters. Return one honestly truncated row so the cursor
        // always advances without exceeding the aggregate response boundary.
        meta = markHistoryContentTruncated(meta);
        let low = 0;
        let high = Math.min(contentCodePoints.length, maxMessageChars);
        let fitting = "";
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const candidate = { ...bounded, content: contentCodePoints.slice(0, middle).join(""), meta };
          if (2 + JSON.stringify(candidate).length <= maxChars) {
            fitting = candidate.content;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        bounded = { ...bounded, content: fitting, meta };
        cost = JSON.stringify(bounded).length;
        if (2 + cost <= maxChars) {
          acceptedNewestFirst.push(bounded);
        }
      }
      if (rowIndex + 1 < newestFirst.length) hasMore = true;
      break;
    }
    acceptedNewestFirst.push(bounded);
    used += cost;
  }
  if (acceptedNewestFirst.length < newestFirst.length) hasMore = true;
  return { messages: acceptedNewestFirst.reverse(), hasMore };
}

function markHistoryContentTruncated(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? { ...(meta as Record<string, unknown>), content_truncated: true }
    : { content_truncated: true };
}

function boundedHistoryMeta(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value ?? {});
    if (serialized.length <= MAX_HISTORY_MESSAGE_META_CHARS) return value ?? {};
  } catch {
    // Fall through to the explicit bounded placeholder.
  }
  return { metadata_truncated: true };
}

function parseChatCreateBody(body: unknown): { title: string; titleIsManual: boolean; scope: SourceScopeInput } {
  const value = body ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SourceScopeError(400, "invalid chat body");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["title", "source_mode", "source_ids"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new SourceScopeError(400, "invalid chat body");
  const titleIsManual = Object.prototype.hasOwnProperty.call(record, "title");
  const title = titleIsManual ? parseChatTitle(record.title) : "New chat";
  const hasMode = Object.prototype.hasOwnProperty.call(record, "source_mode");
  const hasIds = Object.prototype.hasOwnProperty.call(record, "source_ids");
  const scope =
    !hasMode && !hasIds
      ? ({ source_mode: "all" } as const)
      : parseSourceScopeInput(
          Object.fromEntries(Object.entries(record).filter(([key]) => key === "source_mode" || key === "source_ids"))
        );
  return { title, titleIsManual, scope };
}

function parseChatTitle(value: unknown): string {
  if (typeof value !== "string") throw new SourceScopeError(400, "title must contain between 1 and 80 characters");
  const title = value.trim();
  const length = Array.from(title).length;
  if (length < 1 || length > 80) throw new SourceScopeError(400, "title must contain between 1 and 80 characters");
  return title;
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max)
    throw new SourceScopeError(400, "invalid pagination limit");
  return parsed;
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new SourceScopeError(400, `invalid ${field}`);
  return parsed;
}

function sendSourceScopeError(reply: any, error: unknown) {
  if (error instanceof SourceScopeError) return reply.code(error.statusCode).send({ error: error.message });
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
