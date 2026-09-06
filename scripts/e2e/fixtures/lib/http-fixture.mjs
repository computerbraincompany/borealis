/**
 * Shared plumbing for the standalone E2E protocol fixtures.
 *
 * Conventions every fixture follows:
 * - bind 127.0.0.1 only, on an OS-assigned port;
 * - print exactly one content-free JSON ready line to stdout (HTTP fixtures;
 *   the stdio MCP fixture reserves stdout for protocol bytes);
 * - never log request/response bodies, tokens, or credentials;
 * - bound every request body;
 * - exit 0 on SIGTERM/SIGINT after closing only its own sockets.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

/** Listen on loopback with an OS-assigned port. */
export function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * Read a request body up to `maxBytes`. Returns the buffer, `null` on
 * overflow (socket destroyed, fail-closed) or on a stream error.
 */
export function readBoundedBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;
    let done = false;
    req.on("data", (piece) => {
      if (done) return;
      received += piece.length;
      if (received > maxBytes) {
        done = true;
        chunks.length = 0;
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(piece);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      resolve(null);
    });
  });
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

/** Constant-time comparison of two UTF-8 strings via fixed-length digests. */
export function secretEqual(a, b) {
  const ha = createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const hb = createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Install SIGTERM/SIGINT handlers that run `cleanup` then exit 0. Only this
 * process is affected; child termination is each fixture's own bookkeeping.
 */
export function installShutdown(cleanup) {
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    try {
      await cleanup();
    } catch {
      /* exit regardless */
    }
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return stop;
}

/** Emit the single content-free ready line on stdout. */
export function emitReady(payload) {
  process.stdout.write(`${JSON.stringify({ protocol: "borealis-e2e-fixture", ...payload })}\n`);
}

/** Log a content-free error line to stderr (never bodies or values). */
export function logError(code) {
  process.stderr.write(`${JSON.stringify({ fixture_error: String(code).slice(0, 80) })}\n`);
}

/**
 * Create a loopback HTTP server whose socket set is tracked so shutdown can
 * destroy keep-alive/SSE sockets without touching anything else.
 */
export function createTrackedServer(handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    server,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** base64url without padding (PKCE and token-friendly). */
export function b64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Parse application/x-www-form-urlencoded bodies into a plain object. */
export function parseForm(buffer) {
  const out = {};
  for (const pair of buffer.toString("utf8").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(key.replace(/\+/g, " "))] = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      return null;
    }
  }
  return out;
}
