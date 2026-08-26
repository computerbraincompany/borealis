import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeRequestId, runWithRequestContext } from "./requestContext.js";

const installedBoundaries = new WeakSet<FastifyInstance>();

export interface HttpBoundaryOptions {
  readonly notFound?: (req: FastifyRequest, reply: FastifyReply) => unknown;
}

export function installHttpBoundary(app: FastifyInstance, options: HttpBoundaryOptions = {}): void {
  if (installedBoundaries.has(app)) return;
  installedBoundaries.add(app);
  app.addHook("onRequest", (req, reply, done) => {
    const requestId = normalizeRequestId(req.headers["x-request-id"]);
    reply.header("X-Request-ID", requestId);
    runWithRequestContext(requestId, done);
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as {
      message?: string;
      code?: string;
      statusCode?: number;
      validation?: unknown;
      name?: string;
    };
    const requestId = String(reply.getHeader("X-Request-ID") || req.id);
    const code = typeof err.code === "string" ? err.code : undefined;
    if (code === "FST_REQ_FILE_TOO_LARGE" || err.statusCode === 413) {
      return reply.code(413).send({ error: "request payload is too large", request_id: requestId });
    }
    if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || err.statusCode === 415) {
      return reply.code(415).send({ error: "unsupported content type", request_id: requestId });
    }
    if (code === "FST_ERR_CTP_INVALID_JSON_BODY" || err.statusCode === 400) {
      return reply.code(400).send({ error: "invalid request", request_id: requestId });
    }
    if (err.validation) {
      return reply.code(400).send({ error: "invalid request", request_id: requestId });
    }
    req.log.error(
      {
        request_id: requestId,
        error_name: err.name,
        ...(code && /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? { error_code: code } : {}),
      },
      "request failed"
    );
    return reply.code(500).send({ error: "internal server error", request_id: requestId });
  });
  app.setNotFoundHandler((req, reply) => {
    if (options.notFound) return options.notFound(req, reply);
    const requestId = String(reply.getHeader("X-Request-ID") || req.id);
    return reply.code(404).send({ error: "not found", request_id: requestId });
  });
}
