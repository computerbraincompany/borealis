#!/usr/bin/env node
/**
 * Standalone authenticated (HTTP Basic) WebDAV collection fixture.
 *
 * One process serves two loopback origins:
 *   primary   — the DAV:1 collection rooted at E2E_WEBDAV_ROOT, plus a
 *               `/redirect/...` path variant that answers 301 to the SECOND
 *               origin. The Location never carries credentials, so following
 *               the redirect without re-authentication yields 401 — that is
 *               the redirect-refusal exercise.
 *   secondary — same tree, also Basic-protected; redirect target only.
 *
 * Ready line:
 *   {"fixture":"webdav","origin","redirect_origin","root"}
 *
 * Supported: OPTIONS, HEAD, GET, PROPFIND (Depth 0/1), PUT, DELETE, MKCOL.
 * 401 without credentials or with wrong credentials (never logs them).
 *
 * Environment:
 *   E2E_WEBDAV_ROOT=<dir>       served tree (default: seeded temp directory)
 *   E2E_WEBDAV_USER / E2E_WEBDAV_PASS   default e2e-user / e2e-pass
 *   E2E_WEBDAV_XML_MODE=ok|malformed|hostile
 *       malformed — PROPFIND answers 207 with non-well-formed XML
 *       hostile — PROPFIND answers 207 with an ENTITY/DOCTYPE preamble
 *   E2E_WEBDAV_DELAY_MS=N       latency before every response
 *
 * XML hostility: real DAV clients must refuse entity/external-entity
 * expansion; this fixture only emits those shapes for that client-side test.
 * Request bodies are bounded (PUT 2 MiB, PROPFIND 64 KiB); oversized sockets
 * are destroyed. SIGTERM closes only its own sockets and exits 0.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, readFile, writeFile, readdir, realpath, lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep, resolve, dirname } from "node:path";
import {
  createTrackedServer,
  emitReady,
  installShutdown,
  listenLoopback,
  readBoundedBody,
  secretEqual,
  sendJson,
} from "./lib/http-fixture.mjs";

const user = process.env.E2E_WEBDAV_USER || "e2e-user";
const password = process.env.E2E_WEBDAV_PASS || "e2e-pass";
const xmlMode = ["ok", "malformed", "hostile"].includes(process.env.E2E_WEBDAV_XML_MODE)
  ? process.env.E2E_WEBDAV_XML_MODE
  : "ok";
const delayMs = clampInt(process.env.E2E_WEBDAV_DELAY_MS, 0, 10_000, 0);
const MAX_PUT_BYTES = 2 * 1024 * 1024;
const MAX_PROPFIND_BYTES = 64 * 1024;

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

let rootDir = process.env.E2E_WEBDAV_ROOT ? resolve(process.env.E2E_WEBDAV_ROOT) : null;
let createdTempRoot = null;
if (!rootDir) {
  createdTempRoot = await mkdtemp(join(tmpdir(), "borealis-e2e-webdav-"));
  await mkdir(join(createdTempRoot, "notes"), { recursive: true });
  await writeFile(join(createdTempRoot, "readme.md"), "# WebDAV fixture root\n");
  await writeFile(join(createdTempRoot, "ledger.csv"), "date,amount\n2026-01-05,10.00\n");
  await writeFile(join(createdTempRoot, "notes", "gamma.txt"), "nested gamma\n");
  rootDir = createdTempRoot;
}
const realRoot = await realpath(rootDir);

const CONTENT_TYPES = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
};

function contentTypeFor(name) {
  const dot = name.lastIndexOf(".");
  return CONTENT_TYPES[dot === -1 ? "" : name.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map a URL path to a safe path under the root. Rejects traversal, absolute
 * escapes, and any symlinked path component (fail-closed, content-free).
 */
async function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const segments = decoded.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === ".." || segment.includes("\0"))) return null;
  let candidate = realRoot;
  for (const segment of segments) {
    candidate = join(candidate, segment);
    if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) return null;
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) return null;
    } catch {
      break; // missing tail: PUT/DELETE semantics decide later
    }
  }
  return candidate;
}

function parseAuth(req) {
  const match = /^Basic\s+([A-Za-z0-9+/=]{1,2048})$/.exec(String(req.headers.authorization ?? ""));
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0 || colon > 256 || decoded.length - colon > 4097) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

const AUTH_HEADERS = { "WWW-Authenticate": 'Basic realm="borealis-e2e", charset="UTF-8"' };

function unauthorized(res) {
  res.writeHead(401, { ...AUTH_HEADERS, "Content-Length": "0", "Cache-Control": "no-store" });
  res.end();
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hrefFor(relativePath, isDir) {
  const encoded = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/${encoded}${isDir && !encoded.endsWith("/") ? "/" : ""}`;
}

async function propEntry(absolutePath, relativePath) {
  const info = await stat(absolutePath);
  const isDir = info.isDirectory();
  const name = relativePath.split("/").pop() || "";
  const props = [
    `<d:href>${xmlEscape(hrefFor(relativePath, isDir))}</d:href>`,
    "<d:propstat><d:prop>",
    `<d:displayname>${xmlEscape(name)}</d:displayname>`,
    `<d:getlastmodified>${info.mtime.toUTCString()}</d:getlastmodified>`,
    isDir
      ? "<d:resourcetype><d:collection/></d:resourcetype>"
      : [
          "<d:resourcetype/>",
          `<d:getcontentlength>${info.size}</d:getcontentlength>`,
          `<d:getcontenttype>${xmlEscape(contentTypeFor(name))}</d:getcontenttype>`,
          `<d:getetag>"${createHash("sha256").update(`${info.size}:${info.mtimeMs}`).digest("hex").slice(0, 16)}"</d:getetag>`,
        ].join(""),
    "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>",
  ].join("");
  return `<d:response>${props}</d:response>`;
}

async function propfindXml(absolutePath, relativePath, depth) {
  const parts = [await propEntry(absolutePath, relativePath)];
  const info = await stat(absolutePath);
  if (depth === "1" && info.isDirectory()) {
    const entries = (await readdir(absolutePath)).sort();
    for (const entry of entries) {
      parts.push(await propEntry(join(absolutePath, entry), relativePath ? `${relativePath}/${entry}` : entry));
    }
  }
  const body = parts.join("");
  if (xmlMode === "malformed") {
    // Deliberately unterminated so a real client must refuse the document.
    return { xml: `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${body.slice(0, 64)}` };
  }
  if (xmlMode === "hostile") {
    return {
      xml:
        '<!DOCTYPE d:multistatus [<!ENTITY secret SYSTEM "file:///etc/passwd"><!ENTITY boom "&boom;&boom;">]>\n' +
        `<d:multistatus xmlns:d="DAV:" xmlns:s="http://sched.org/">${body}</d:multistatus>`,
    };
  }
  return { xml: `<d:multistatus xmlns:d="DAV:">${body}</d:multistatus>` };
}

async function handle(req, res, primary) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));

  const creds = parseAuth(req);
  if (!creds || !secretEqual(creds.user, user) || !secretEqual(creds.password, password)) {
    unauthorized(res);
    return;
  }

  if (primary && url.pathname.startsWith("/redirect/")) {
    // 301 to a DIFFERENT origin; credentials are deliberately not continued.
    const rest = url.pathname.slice("/redirect/".length);
    res.writeHead(301, {
      Location: `${secondaryOrigin}/${rest}${url.search}`,
      "Content-Length": "0",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  const method = req.method ?? "GET";
  if (method === "OPTIONS") {
    res.writeHead(204, {
      DAV: "1",
      Allow: "OPTIONS, HEAD, GET, PROPFIND, PUT, DELETE, MKCOL",
      "MS-Author-Via": "DAV",
      "Content-Length": "0",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  const target = await safePath(url.pathname);
  if (target === null) {
    sendJson(res, 400, { error: "unsafe path" });
    return;
  }
  const relative = target === realRoot ? "" : target.slice(realRoot.length + 1);

  if (method === "PROPFIND") {
    const body = await readBoundedBody(req, MAX_PROPFIND_BYTES);
    if (body === null) return;
    const depth = String(req.headers.depth ?? "");
    if (depth !== "0" && depth !== "1") {
      sendJson(res, 400, { error: "Depth must be 0 or 1" });
      return;
    }
    let exists = true;
    try {
      await stat(target);
    } catch {
      exists = false;
    }
    if (!exists) {
      res.writeHead(404, { "Content-Length": "0", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const { xml } = await propfindXml(target, relative, depth);
    const payload = Buffer.from(xml, "utf8");
    res.writeHead(207, {
      "Content-Type": 'application/xml; charset="utf-8"',
      "Content-Length": String(payload.length),
      "Cache-Control": "no-store",
    });
    res.end(payload);
    return;
  }

  if (method === "GET" || method === "HEAD") {
    let info;
    try {
      info = await stat(target);
    } catch {
      res.writeHead(404, { "Content-Length": "0", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if (info.isDirectory()) {
      res.writeHead(405, { "Content-Length": "0", Allow: "OPTIONS, HEAD, GET, PROPFIND, PUT, DELETE, MKCOL" });
      res.end();
      return;
    }
    const payload = method === "HEAD" ? Buffer.alloc(0) : await readFile(target);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(relative),
      "Content-Length": String(info.size),
      ETag: `"${createHash("sha256").update(`${info.size}:${info.mtimeMs}`).digest("hex").slice(0, 16)}"`,
      "Cache-Control": "no-store",
    });
    res.end(payload);
    return;
  }

  if (method === "PUT") {
    const body = await readBoundedBody(req, MAX_PUT_BYTES);
    if (body === null) return;
    let parentExists = false;
    try {
      parentExists = (await stat(dirname(target))).isDirectory();
    } catch {
      parentExists = false;
    }
    if (!parentExists) {
      res.writeHead(409, { "Content-Length": "0", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    let existed = true;
    try {
      await stat(target);
    } catch {
      existed = false;
    }
    await writeFile(target, body, { flag: "w" });
    res.writeHead(existed ? 204 : 201, { "Content-Length": "0", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (method === "MKCOL") {
    try {
      await mkdir(target);
      res.writeHead(201, { "Content-Length": "0", "Cache-Control": "no-store" });
      res.end();
    } catch {
      res.writeHead(405, { "Content-Length": "0", "Cache-Control": "no-store" });
      res.end();
    }
    return;
  }

  if (method === "DELETE") {
    try {
      const info = await stat(target);
      if (info.isDirectory()) {
        res.writeHead(405, { "Content-Length": "0", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      await unlink(target);
      res.writeHead(204, { "Content-Length": "0", "Cache-Control": "no-store" });
      res.end();
    } catch {
      res.writeHead(404, { "Content-Length": "0", "Cache-Control": "no-store" });
      res.end();
    }
    return;
  }

  res.writeHead(405, { "Content-Length": "0", Allow: "OPTIONS, HEAD, GET, PROPFIND, PUT, DELETE, MKCOL" });
  res.end();
}

const primary = createTrackedServer((req, res) => handle(req, res, true).catch(() => res.destroy()));
const secondary = createTrackedServer((req, res) => handle(req, res, false).catch(() => res.destroy()));

const primaryPort = await listenLoopback(primary.server);
const secondaryPort = await listenLoopback(secondary.server);
const secondaryOrigin = `http://127.0.0.1:${secondaryPort}`;

installShutdown(async () => {
  await Promise.all([primary.close(), secondary.close()]);
  if (createdTempRoot) await rm(createdTempRoot, { recursive: true, force: true }).catch(() => {});
});

emitReady({
  fixture: "webdav",
  origin: `http://127.0.0.1:${primaryPort}`,
  redirect_origin: secondaryOrigin,
  root: rootDir,
  xml_mode: xmlMode,
});
