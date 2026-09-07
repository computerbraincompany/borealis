#!/usr/bin/env node
/**
 * M15 milestone end-to-end proof: durable local research over the real product.
 *
 * This is the milestone's own standalone integration-grade script (distinct
 * from the browser-driven `scripts/e2e/` product journeys): it never touches
 * that harness. It boots the real built Fastify backend in an isolated
 * disposable workspace, serves a deterministic scripted OpenAI-compatible
 * provider on loopback (chat, model catalog, and embeddings — no live model),
 * imports the three-supplier synthetic corpus through the real HTTP upload
 * API with real ingestion/embedding/retrieval, and then executes the
 * milestone contract through real HTTP routes only:
 *
 * 1. plan proposal generation + editable CAS save, memo run: real keyword
 *    search + real LanceDB semantic KNN, the shared-onboarding-fee
 *    contradiction shown with both captured excerpts, the termination notice
 *    period recorded as an honest not-found gap, exact fixture numbers;
 * 2. comparison run: typed cells (number/date/boolean/enum/text), an invalid
 *    verbatim machine value, a conflicting cell over two real excerpts, the
 *    absent-fact null cell, a user correction overlay, byte-checked CSV
 *    export (BOM + formula guard) and JSON manifest (locators/provenance),
 *    a scoped rerun carrying the override visibly plus the against-diff;
 * 3. the M13 reviewed artifact: draft created from the real research run and
 *    published through the documents API, verified by %PDF magic bytes and
 *    self-contained HTML;
 * 4. workspace proofs: a second backend boot against the same locked
 *    workspace must fail closed while the primary pid stays healthy, and the
 *    disposable workspace must be gone at the end.
 *
 * All fixture bytes, corpus facts, scripted invalid/override values, plan
 * steps, and export fragments are asserted against the committed
 * `data/e2e/supplier-research-expected.mjs` module — the anti-tautology
 * guard: the script verifies the module's own internal consistency
 * (`verifyCommittedExpected`) before it runs, then asserts every runtime
 * outcome against those committed expectations.
 *
 * Output contract: exactly one content-free JSON summary line on stdout.
 * Exit `0` only when every assertion held; `1` otherwise (never a silent
 * pass; a red run cleans up and reports the failing stage code).
 *
 * Prerequisites: `pnpm --filter borealis-server build` and Playwright
 * Chromium installed (used by the real document publication renderer).
 *
 * Usage: node scripts/e2e-local-research.mjs [--keep-on-failure]
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMITTED_EXPECTED,
  SUPPLIER_DOCS,
  verifyCommittedExpected,
} from "../data/e2e/supplier-research-expected.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "dist", "index.js");

const CHAT_MODEL = "milestone-research-chat";
const EMBED_MODEL = "milestone-research-embed";
const EMBED_DIM = 4;
const RUN_TIMEOUT_MS = 20 * 60_000;

const keepOnFailure = process.argv.includes("--keep-on-failure");
if (process.argv.slice(2).some((flag) => !["--keep-on-failure"].includes(flag))) {
  process.stderr.write("usage: node scripts/e2e-local-research.mjs [--keep-on-failure]\n");
  process.exitCode = 1;
  process.exit(1);
}

// -- The milestone's synthetic three-supplier corpus ---------------------------
// The committed fixture bytes and every expected corpus fact (differing
// dates/amounts/terms, the shared-onboarding-fee contradiction, the
// never-stated termination notice period, the scripted invalid verbatims,
// the correction/rerun values, plan steps, and export fragments) come from
// `data/e2e/supplier-research-expected.mjs`. Everything below derives its
// deterministic expectations from that module — no fact is restated inline.
const EXPECTED = COMMITTED_EXPECTED;
const ACME = EXPECTED.suppliers["Acme Logistics"];
const BLURIVER = EXPECTED.suppliers["BlueRiver Analytics"];
const CEDAR = EXPECTED.suppliers["CedarCloud Hosting"];
const SUPPLIER_BY_NAME = { "Acme Logistics": ACME, "BlueRiver Analytics": BLURIVER, "CedarCloud Hosting": CEDAR };
const [ACME_NAME, BLURIVER_NAME, CEDAR_NAME] = Object.keys(SUPPLIER_BY_NAME);
// The committed excerpt fragment already carries the currency token.
const feeExcerpt = (fee) => `${fee} ${EXPECTED.conflict.excerpt_fragment}`;
const priceExcerpt = (supplier) => `${supplier.price} ${supplier.currency}`;
const MEMO_PLAN = {
  steps: EXPECTED.memo_plan_steps.map((step) => ({ objective: step.objective, questions: [...step.questions] })),
};
const COMPARISON_PLAN = {
  steps: EXPECTED.comparison_plan_steps.map((step) => ({ objective: step.objective, questions: [...step.questions] })),
};

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// -- Failure plumbing -----------------------------------------------------------
class StageFailure extends Error {
  constructor(stage, detail) {
    super(`${stage}${detail ? `: ${detail}` : ""}`);
    this.stage = stage;
  }
}
function assert(condition, stage, detail) {
  if (!condition) throw new StageFailure(stage, detail ?? "assertion failed");
}
async function pollUntil(stage, ms, check) {
  const until = Date.now() + ms;
  for (;;) {
    const outcome = await check();
    if (outcome !== undefined && outcome !== false) return outcome;
    if (Date.now() > until) throw new StageFailure(stage, "deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// -- Scripted provider (loopback OpenAI-compatible fixture) --------------------
function embedVector(text) {
  // Deterministic unit vectors through the same float contract as production.
  return text.includes("onboarding") ? [1, 0, 0, 0] : [0, 1, 0, 0];
}

function chatFrames(model, content) {
  return [
    {
      id: "chatcmpl-milestone-research",
      object: "chat.completion.chunk",
      created: 1754400000,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      id: "chatcmpl-milestone-research",
      object: "chat.completion.chunk",
      created: 1754400000,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

function lastUserContent(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return String(messages[index]?.content ?? "");
  }
  return "";
}
function firstSystemContent(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.find((message) => message?.role === "system");
  return String(system?.content ?? "");
}

/** Parse `[evidence-id] excerpt` prompt lines into id/excerpt pairs. */
function evidencePairs(userContent) {
  const pairs = [];
  const lines = userContent.split("\n");
  for (const line of lines) {
    const match = /^\[([0-9a-fA-F-]{36})\]\s*(.*)$/.exec(line);
    if (match) pairs.push({ id: match[1], excerpt: match[2] ?? "" });
  }
  return pairs;
}

function memoSynthesisAnswer(userContent) {
  const pairs = evidencePairs(userContent);
  const pick = (token) => pairs.find((pair) => pair.excerpt.includes(token))?.id ?? null;
  const [feeLow, feeHigh] = EXPECTED.conflict.values;
  const feeLowId = pick(feeExcerpt(feeLow));
  const feeHighId = pick(feeExcerpt(feeHigh));
  const priceId = pick(priceExcerpt(ACME));
  if (!feeLowId || !feeHighId || !priceId) {
    // Honest degenerate transcript: gaps only, never a fabricated citation.
    return JSON.stringify({
      claims: [],
      gaps: ["The scripted transcript did not receive the expected captured evidence."],
    });
  }
  return JSON.stringify({
    claims: [
      {
        text: `The suppliers state different one-time ${EXPECTED.conflict.fact}s.`,
        classification: "conflicting",
        // The trailing foreign id must be dropped by the server, never
        // resolved to another run's evidence.
        evidence_ids: [feeLowId, feeHighId, crypto.randomUUID()],
      },
      {
        text: `${ACME_NAME} lists ${priceExcerpt(ACME)} as the annual price.`,
        classification: "supported",
        evidence_ids: [priceId, crypto.randomUUID()],
      },
    ],
    gaps: [`The ${EXPECTED.missing_fact.name} is ${EXPECTED.missing_fact.gap_phrase}.`],
  });
}

/** Parse the per-column extraction prompt into rows with their evidence. */
function extractionRows(userContent) {
  const rows = [];
  let current = null;
  for (const line of userContent.split("\n")) {
    const rowMatch = /^row source_id=([0-9a-fA-F-]{36})\s*$/.exec(line);
    if (rowMatch) {
      current = { sourceId: rowMatch[1], pairs: [] };
      rows.push(current);
      continue;
    }
    const pair = /^\[([0-9a-fA-F-]{36})\]\s*(.*)$/.exec(line);
    if (pair && current) current.pairs.push({ id: pair[1], excerpt: pair[2] ?? "" });
  }
  return rows;
}

function comparisonColumnAnswer(userContent) {
  const column = /Column "([^"]+)"/.exec(userContent)?.[1] ?? "";
  const rows = extractionRows(userContent);
  const rowSupplier = (row) => {
    const text = row.pairs.map((pair) => pair.excerpt).join(" ");
    for (const name of Object.keys(SUPPLIER_BY_NAME)) if (text.includes(name)) return name;
    return null;
  };
  const cells = [];
  const [priceColumn, effectiveColumn, renewalColumn, tierColumn, exceptionsColumn] = EXPECTED.columns.map(
    (column) => column.label
  );
  const singleRowPriceRerun = column === priceColumn && rows.length === 1;
  for (const row of rows) {
    const supplierName = rowSupplier(row);
    const supplier = supplierName === null ? null : SUPPLIER_BY_NAME[supplierName];
    const idFor = (token) => row.pairs.find((pair) => pair.excerpt.includes(token))?.id ?? null;
    const ref = (id, extra = {}) => ({
      source_id: row.sourceId,
      ...(id ? { evidence_ids: [id] } : {}),
      explanation: `Extracted from the ${supplierName ?? "unknown"} proposal.`,
      ...extra,
    });
    if (column === priceColumn) {
      if (singleRowPriceRerun) {
        cells.push({
          ...ref(idFor(String(BLURIVER.price)), { value: EXPECTED.review.rerun_blue_price }),
          explanation: EXPECTED.review.rerun_explanation,
        });
        continue;
      }
      if (supplierName === ACME_NAME)
        cells.push(ref(idFor(priceExcerpt(ACME)), { value: EXPECTED.comparison.invalid_number_verbatim })); // invalid verbatim
      else if (supplier) cells.push(ref(idFor(priceExcerpt(supplier)), { value: supplier.price }));
    } else if (column === effectiveColumn) {
      cells.push(ref(idFor("Effective: "), { value: supplier?.effective_date ?? null }));
    } else if (column === renewalColumn) {
      if (supplier?.renewal === true) {
        cells.push(ref(idFor(supplier.renewal_statement), { value: true }));
      } else if (supplier?.renewal === "conflict") {
        const manual = idFor(supplier.renewal_statement);
        const automatic = idFor("automatic renewal");
        if (manual && automatic && manual !== automatic) {
          cells.push({
            source_id: row.sourceId,
            value: false,
            status: "conflicting",
            evidence_ids: [manual, automatic],
            explanation: "The proposal body and the renewal addendum disagree.",
          });
        } else {
          cells.push(ref(null, { value: false, explanation: "The proposal states manual renewal." }));
        }
      } else if (supplier?.renewal === false) {
        cells.push(ref(idFor(supplier.renewal_statement), { value: false }));
      } else if (supplier?.renewal === null) {
        cells.push({ source_id: row.sourceId, value: null, explanation: "The proposal does not state renewal." });
      }
    } else if (column === tierColumn) {
      cells.push(ref(idFor("Tier: "), { value: supplier?.tier ?? null }));
    } else if (column === exceptionsColumn) {
      if (supplierName === BLURIVER_NAME) {
        cells.push(ref(idFor("Exceptions: "), { value: EXPECTED.comparison.invalid_text_verbatim })); // invalid verbatim
      } else if (supplier) {
        cells.push(ref(idFor(supplier.exceptions), { value: supplier.exceptions }));
      }
    }
  }
  return JSON.stringify({ cells });
}

function scriptedChatAnswer(body) {
  const system = firstSystemContent(body);
  const user = lastUserContent(body);
  if (system.includes("research planner")) {
    const plan = user.includes("Output kind: comparison") ? COMPARISON_PLAN : MEMO_PLAN;
    return JSON.stringify({
      steps: plan.steps.map((step) => ({ objective: step.objective, questions: step.questions })),
    });
  }
  if (system.includes("summarize captured research evidence")) {
    return "Step evidence summarized for review.";
  }
  if (system.includes('"claims"')) return memoSynthesisAnswer(user);
  if (system.includes("extract one typed value")) return comparisonColumnAnswer(user);
  return "The scripted provider has no answer for this request.";
}

async function startScriptedProvider() {
  const sockets = new Set();
  const chatCalls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (piece) => {
      bytes += piece.length;
      if (bytes > 8 * 1024 * 1024) {
        res.destroy();
        return;
      }
      chunks.push(piece);
    });
    req.on("end", () => {
      void (async () => {
        if (req.method === "GET" && req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              object: "list",
              data: [{ id: CHAT_MODEL, object: "model", owned_by: "milestone-scripted" }],
            })
          );
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400).end();
          return;
        }
        if (req.method === "POST" && req.url === "/v1/embeddings") {
          const inputs = Array.isArray(parsed?.input) ? parsed.input : [parsed?.input].filter(Boolean);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              object: "list",
              model: parsed?.model ?? EMBED_MODEL,
              data: inputs.map((text, index) => ({
                object: "embedding",
                index,
                embedding: embedVector(String(text)),
              })),
              usage: { prompt_tokens: 0, total_tokens: 0 },
            })
          );
          return;
        }
        if (req.method !== "POST" || req.url !== "/v1/chat/completions" || parsed?.stream !== true) {
          res.writeHead(400).end();
          return;
        }
        chatCalls.push(parsed);
        const frames = chatFrames(CHAT_MODEL, scriptedChatAnswer(parsed));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      })().catch(() => res.destroy());
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    chatCallCount: () => chatCalls.length,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// -- Real built server ----------------------------------------------------------
function startServer(dataDir, providerOrigin) {
  assert(fs.existsSync(SERVER_ENTRY), "PREBUILT_MISSING", "run pnpm --filter borealis-server build first");
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? os.homedir(),
      NODE_ENV: "production",
      BOREALIS_DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: "0",
      JWT_SECRET: crypto.randomBytes(48).toString("hex"),
      LLM_BASE_URL: providerOrigin,
      LLM_CHAT_MODEL: CHAT_MODEL,
      LLM_EMBED_MODEL: EMBED_MODEL,
      LLM_API_KEY: "milestone-local-script-token",
      EMBEDDING_DIM: String(EMBED_DIM),
    },
  });
  const lines = { stdout: "", stderr: "" };
  const waitListening = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new StageFailure("SERVER_LISTEN_TIMEOUT")), 120_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (piece) => {
      lines.stdout = (lines.stdout + piece).slice(-4000);
      buffer += piece;
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          if (record.msg === "Borealis server listening" && Number.isSafeInteger(record.port)) {
            clearTimeout(timer);
            resolve(record.port);
          }
        } catch {
          // Non-JSON stdout lines are ignored; only the listen record matters.
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new StageFailure("SERVER_START_FAILED", `exit ${code}`));
    });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (piece) => {
    lines.stderr = (lines.stderr + piece).slice(-4000);
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return {
    child,
    waitListening,
    exited,
    get stdoutTail() {
      return lines.stdout;
    },
    get stderrTail() {
      return lines.stderr;
    },
  };
}

// -- HTTP surface ---------------------------------------------------------------
function api(baseUrl, token) {
  const request = async (method, url, { body, form, raw } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal: AbortSignal.timeout(180_000),
    });
    if (raw) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return { status: response.status, buffer };
    }
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = { raw: "non-json" };
    }
    return { status: response.status, json, text };
  };
  const ok = async (stage, method, url, options = {}) => {
    const response = await request(method, url, options);
    assert(response.status === 200 || response.status === 201, stage, `HTTP ${response.status} ${response.text?.slice(0, 160) ?? ""}`);
    return response;
  };
  return { request, ok };
}

// -- Main ------------------------------------------------------------------------
const startedAt = Date.now();
let stage = "BOOT";
let provider = null;
let server = null;
let workspace = null;
let summary = null;

function reportFailure(error) {
  const detail = error instanceof StageFailure ? error.message : `${error?.message ?? String(error)}`;
  const failing = error instanceof StageFailure ? error : new StageFailure(stage, detail);
  process.stderr.write(`e2e-local-research FAILED at ${failing.stage}: ${failing.message}\n`);
  if (server) {
    for (const line of String(server.stderrTail ?? "").split("\n").slice(-6)) {
      if (line.trim()) process.stderr.write(`server-stderr: ${line.trim().slice(0, 200)}\n`);
    }
    for (const line of String(server.stdoutTail ?? "").split("\n").slice(-10)) {
      if (line.trim()) process.stderr.write(`server-stdout: ${line.trim().slice(0, 200)}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: false, script: "e2e-local-research", failed_stage: failing.stage })}\n`);
  process.exitCode = 1;
}

async function main() {
  stage = "WORKSPACE";
  workspace = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), "borealis-m15-e2e-local-research-"))
  );
  const dataDir = path.join(workspace, "data");
  await fs.promises.mkdir(dataDir, { recursive: true });

  // Anti-tautology gate: the committed module must be internally consistent
  // (fixture bytes hash to the pinned digests, regex-recovered facts match
  // the committed table, the missing fact is nowhere) before anything runs.
  stage = "FIXTURES";
  const docHashes = {};
  for (const doc of SUPPLIER_DOCS) docHashes[doc.name] = sha256(Buffer.from(doc.body, "utf8"));
  const fixtureMismatches = verifyCommittedExpected(docHashes);
  assert(fixtureMismatches.length === 0, "FIXTURES", fixtureMismatches.join("; "));

  stage = "PROVIDER";
  provider = await startScriptedProvider();

  stage = "SERVER";
  server = startServer(dataDir, provider.origin);
  const port = await server.waitListening;
  const baseUrl = `http://127.0.0.1:${port}`;
  await pollUntil("SERVER_HEALTH", 60_000, async () => {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return response.status === 200;
    } catch {
      return false;
    }
  });

  stage = "REGISTER";
  const account = `m15-e2e-${crypto.randomUUID().slice(0, 8)}@milestone.test`;
  const registered = await api(baseUrl).ok("REGISTER", "POST", "/api/register", {
    body: { email: account, password: "milestone-local-password" },
  });
  const token = registered.json.token;
  assert(typeof token === "string" && token.length > 20, "REGISTER", "missing token");
  const session = api(baseUrl, token);

  stage = "UPLOAD";
  const sourceIds = [];
  for (const doc of SUPPLIER_DOCS) {
    const form = new FormData();
    form.append("file", new Blob([doc.body], { type: "text/markdown" }), doc.name);
    const uploaded = await session.ok("UPLOAD", "POST", "/api/sources/upload", { form });
    sourceIds.push(uploaded.json.id);
  }
  assert(sourceIds.length === 3, "UPLOAD", "expected three sources");
  stage = "INGEST";
  await pollUntil("INGEST", 180_000, async () => {
    const catalog = await session.ok("INGEST", "GET", "/api/sources");
    const items = catalog.json.items.filter((item) => sourceIds.includes(item.id));
    const failed = items.find((item) => item.status === "error");
    if (failed) {
      const meta = typeof failed.meta === "object" && failed.meta ? failed.meta : {};
      throw new StageFailure("INGEST", `source ingestion failed: ${meta.error?.code ?? meta.error ?? "unknown"}`);
    }
    return items.length === 3 && items.every((item) => item.status === "ready");
  });
  const [acmeId, blueId, cedarId] = sourceIds;

  stage = "MEMO_RUN";
  const memoDefinition = await session.ok("MEMO_CREATE", "POST", "/api/research", {
    body: {
      title: "Supplier renewal diligence",
      question: "Which renewal terms and onboarding fees do the suppliers state?",
      output_kind: "memo",
      source_ids: sourceIds,
      chat_model: CHAT_MODEL,
    },
  });
  const memoDefinitionId = memoDefinition.json.id;
  const memoPlan = await session.ok("MEMO_PLAN", "POST", `/api/research/${memoDefinitionId}/plan`, { body: {} });
  assert(memoPlan.json.model_used === true && memoPlan.json.fallback === false, "MEMO_PLAN", "proposal not model-produced");
  const memoSaved = await session.ok("MEMO_PLAN_SAVE", "PATCH", `/api/research/${memoDefinitionId}`, {
    body: { expected_revision: memoPlan.json.base_revision, plan: memoPlan.json.plan },
  });
  const memoRun = await session.ok("MEMO_START", "POST", `/api/research/${memoDefinitionId}/runs`, { body: {} });
  const memoRunId = memoRun.json.id;
  const finishedMemo = await pollUntil("MEMO_RUN", 180_000, async () => {
    const run = await session.ok("MEMO_RUN", "GET", `/api/research-runs/${memoRunId}`);
    return ["completed", "needs_review", "failed", "cancelled"].includes(run.json.status) ? run.json : false;
  });
  assert(finishedMemo.status === "completed", "MEMO_RUN", `status ${finishedMemo.status}`);

  stage = "MEMO_ASSERTIONS";
  const memoEvidence = await pollUntil("MEMO_EVIDENCE", 20_000, async () => {
    const page = await session.ok("MEMO_EVIDENCE", "GET", `/api/research-runs/${memoRunId}/evidence?limit=50`);
    return page.json.items.length > 0 ? page.json.items : false;
  });
  const evidenceById = new Map(memoEvidence.map((item) => [item.id, item]));
  for (const item of memoEvidence) {
    assert(
      item.content_hash === crypto.createHash("sha256").update(item.excerpt, "utf8").digest("hex"),
      "MEMO_EVIDENCE",
      "content hash does not match the captured excerpt"
    );
    assert(
      item.locators.length > 0 && item.locators.every((locator) => locator.kind === "text_span"),
      "MEMO_EVIDENCE",
      "typed locators missing"
    );
  }
  const conflicting = finishedMemo.claims.find((claim) => claim.kind === "claim" && claim.classification === "conflicting");
  assert(conflicting, "MEMO_CONFLICT", "no conflicting claim persisted");
  assert(conflicting.evidence_refs.length >= 2, "MEMO_CONFLICT", "conflict requires at least two excerpts");
  assert(
    conflicting.evidence_refs.every((id) => evidenceById.has(id)),
    "MEMO_CONFLICT",
    "conflicting claim cites evidence this run never captured"
  );
  const [feeLow, feeHigh] = EXPECTED.conflict.values;
  const conflictExcerpts = conflicting.evidence_refs.map((id) => evidenceById.get(id).excerpt);
  assert(
    conflictExcerpts.some((text) => text.includes(feeExcerpt(feeLow))) &&
      conflictExcerpts.some((text) => text.includes(feeExcerpt(feeHigh))) &&
      new Set(conflictExcerpts).size === conflictExcerpts.length,
    "MEMO_CONFLICT",
    "the two differing fee excerpts are not both shown"
  );
  const supportedMemo = finishedMemo.claims.find((claim) => claim.kind === "claim" && claim.classification === "supported");
  assert(supportedMemo?.evidence_refs.length === 1, "MEMO_CITATION", "foreign citation ids were not dropped");
  const memoGaps = finishedMemo.claims.filter((claim) => claim.kind === "gap");
  assert(
    memoGaps.some(
      (gap) =>
        gap.text.includes(EXPECTED.missing_fact.name) &&
        gap.text.includes(EXPECTED.missing_fact.gap_phrase.split(" ").slice(0, 2).join(" "))
    ),
    "MEMO_GAP",
    "missing fact not recorded as an honest gap"
  );

  stage = "MEMO_ARTIFACT";
  const memoArtifact = await session.ok("MEMO_ARTIFACT", "POST", `/api/research-runs/${memoRunId}/artifacts`, { body: {} });
  const artifactDocId = memoArtifact.json.document_id;
  const artifactRevisionId = memoArtifact.json.document_revision_id;
  const draftRevision = await session.ok(
    "MEMO_ARTIFACT_READ",
    "GET",
    `/api/documents/${artifactDocId}/revisions/${artifactRevisionId}`
  );
  const draftPayload = JSON.stringify(draftRevision.json.payload);
  assert(draftPayload.includes("Conflicting claims"), "MEMO_ARTIFACT", "conflict disclosure section missing");
  assert(draftPayload.includes("Gaps and not-found"), "MEMO_ARTIFACT", "gap disclosure section missing");
  assert(draftPayload.includes(EXPECTED.missing_fact.name), "MEMO_ARTIFACT", "gap text missing from draft");

  stage = "PUBLISH";
  const published = await session.request("POST", `/api/documents/${artifactDocId}/revisions/${artifactRevisionId}/publish`, {
    body: { operation_id: crypto.randomUUID(), expected_revision_id: artifactRevisionId },
  });
  assert([200, 201, 202].includes(published.status), "PUBLISH", `HTTP ${published.status}`);
  const publication = await pollUntil("PUBLISH", 180_000, async () => {
    const list = await session.ok("PUBLISH", "GET", `/api/documents/${artifactDocId}/publications`);
    return list.json.items.find((item) => item.revision_id === artifactRevisionId) ?? false;
  });
  assert(publication.version === 1, "PUBLISH", "first publication must be version 1");
  stage = "PDF_MAGIC";
  const pdf = await session.ok("PDF_MAGIC", "GET", `/api/documents/${artifactDocId}/publications/${publication.id}/export?format=pdf`, { raw: true });
  assert(pdf.buffer.subarray(0, 5).toString("latin1") === "%PDF-", "PDF_MAGIC", "exported PDF lacks the %PDF magic");
  const html = await session.ok("HTML_EXPORT", "GET", `/api/documents/${artifactDocId}/publications/${publication.id}/export?format=html`);
  assert(
    html.text.includes(String(ACME.price)) && html.text.includes(String(feeLow)),
    "HTML_EXPORT",
    "fixture numbers missing"
  );
  assert(!/<(script|img|link|iframe)[^>]*(src|href)="https?:/i.test(html.text), "HTML_EXPORT", "exported HTML is not self-contained");

  stage = "COMPARISON_RUN";
  // The five typed columns come straight from the committed contract.
  const columns = EXPECTED.columns.map((column) => ({ id: crypto.randomUUID(), ...column }));
  const [colPrice, , colRenewal] = columns.map((column) => column.id);
  const comparisonDefinition = await session.ok("COMPARISON_CREATE", "POST", "/api/research", {
    body: {
      title: "Supplier comparison",
      question: "Compare the supplier proposals across price, effective date, renewal, tier, and exceptions.",
      output_kind: "comparison",
      source_ids: sourceIds,
      chat_model: CHAT_MODEL,
      columns,
    },
  });
  const comparisonDefinitionId = comparisonDefinition.json.id;
  const comparisonPlan = await session.ok("COMPARISON_PLAN", "POST", `/api/research/${comparisonDefinitionId}/plan`, { body: {} });
  await session.ok("COMPARISON_PLAN_SAVE", "PATCH", `/api/research/${comparisonDefinitionId}`, {
    body: { expected_revision: comparisonPlan.json.base_revision, plan: comparisonPlan.json.plan },
  });
  const comparisonRun = await session.ok("COMPARISON_START", "POST", `/api/research/${comparisonDefinitionId}/runs`, { body: {} });
  const comparisonRunId = comparisonRun.json.id;
  const finishedComparison = await pollUntil("COMPARISON_RUN", 240_000, async () => {
    const run = await session.ok("COMPARISON_RUN", "GET", `/api/research-runs/${comparisonRunId}`);
    return ["completed", "needs_review", "failed", "cancelled"].includes(run.json.status) ? run.json : false;
  });
  assert(finishedComparison.status === "completed", "COMPARISON_RUN", `status ${finishedComparison.status}`);
  assert(
    finishedComparison.counts.machine_cell_count === EXPECTED.comparison.machine_cells,
    "COMPARISON_CELLS",
    `expected ${EXPECTED.comparison.machine_cells} machine cells`
  );

  stage = "COMPARISON_ASSERTIONS";
  const comparisonTable = await pollUntil("COMPARISON_TABLE", 20_000, async () => {
    const table = await session.ok("COMPARISON_TABLE", "GET", `/api/research-runs/${comparisonRunId}/table?limit=100`);
    return table.json.items.length === 3 ? table.json : false;
  });
  const cellFor = (table, columnId, rowSourceId, origin) => {
    const row = table.items.find((item) => item.row_source_id === rowSourceId);
    if (!row) return null;
    return row.cells.find((cell) => cell.column_id === columnId && cell.origin === origin) ?? null;
  };
  const priceAcme = cellFor(comparisonTable, colPrice, acmeId, "machine");
  assert(
    priceAcme?.status === "invalid" && priceAcme.value === EXPECTED.comparison.invalid_number_verbatim,
    "COMPARISON_TYPES",
    "invalid number not preserved verbatim"
  );
  assert(
    cellFor(comparisonTable, colPrice, blueId, "machine")?.value === BLURIVER.price,
    "COMPARISON_TYPES",
    `exact ${BLURIVER.price} missing`
  );
  assert(
    cellFor(comparisonTable, colPrice, cedarId, "machine")?.value === CEDAR.price,
    "COMPARISON_TYPES",
    `exact ${CEDAR.price} missing`
  );
  assert(
    cellFor(comparisonTable, columns[1].id, cedarId, "machine")?.value === CEDAR.effective_date,
    "COMPARISON_TYPES",
    "exact ISO date missing"
  );
  assert(
    cellFor(comparisonTable, columns[3].id, blueId, "machine")?.value === BLURIVER.tier,
    "COMPARISON_TYPES",
    "enum value missing"
  );
  const renewalBlue = cellFor(comparisonTable, colRenewal, blueId, "machine");
  assert(renewalBlue?.status === "conflicting" && renewalBlue.evidence_refs.length >= 2, "COMPARISON_CONFLICT", "cell-level conflict missing");
  const renewalCedar = cellFor(comparisonTable, colRenewal, cedarId, "machine");
  assert(renewalCedar?.status === "not_found" && renewalCedar.value === null, "COMPARISON_GAP", "absent fact cell is not not_found/null");
  // The second scripted invalid verbatim (a number in the text column).
  const exceptionsBlue = cellFor(comparisonTable, columns[4].id, blueId, "machine");
  assert(
    exceptionsBlue?.status === "invalid" && exceptionsBlue.value === EXPECTED.comparison.invalid_text_verbatim,
    "COMPARISON_TYPES",
    "invalid text verbatim not preserved"
  );
  assert(
    cellFor(comparisonTable, columns[4].id, acmeId, "machine")?.value === ACME.exceptions,
    "COMPARISON_TYPES",
    "formula-leading exception text altered"
  );
  assert(
    cellFor(comparisonTable, columns[4].id, cedarId, "machine")?.value === CEDAR.exceptions,
    "COMPARISON_TYPES",
    "exception text missing"
  );

  stage = "CORRECTION";
  const correction = await session.ok("CORRECTION", "PATCH", `/api/research-runs/${comparisonRunId}/review`, {
    body: {
      expected_revision: 1,
      ops: [
        {
          op: "correct_cell",
          column_id: colPrice,
          row_source_id: acmeId,
          value: EXPECTED.review.correction_acme_price,
          status: "supported",
          explanation: EXPECTED.review.correction_explanation,
        },
      ],
    },
  });
  assert(correction.json.review_revision === 2, "CORRECTION", "review CAS did not advance");
  const correctedTableResponse = await session.ok("CORRECTION", "GET", `/api/research-runs/${comparisonRunId}/table?limit=100`);
  const correctedTable = correctedTableResponse.json;
  const acmeCorrection = cellFor(correctedTable, colPrice, acmeId, "correction");
  assert(
    acmeCorrection?.value === EXPECTED.review.correction_acme_price && acmeCorrection?.status === "supported",
    "CORRECTION",
    "overlay missing"
  );
  assert(acmeCorrection.corrected_at, "CORRECTION", "correction provenance missing");
  assert(
    cellFor(correctedTable, colPrice, acmeId, "machine")?.value === EXPECTED.comparison.invalid_number_verbatim,
    "CORRECTION",
    "machine original was mutated"
  );

  stage = "EXPORT";
  // Raw bytes: `Response.text()` strips a leading BOM per the fetch spec, so
  // the byte-level BOM proof must come from the unconverted buffer.
  const csvResponse = await session.ok("EXPORT_CSV", "GET", `/api/research-runs/${comparisonRunId}/export?format=csv`, {
    raw: true,
  });
  const csvBuffer = csvResponse.buffer;
  const [bom0, bom1, bom2] = EXPECTED.export.csv_bom;
  assert(
    csvBuffer[0] === bom0 && csvBuffer[1] === bom1 && csvBuffer[2] === bom2,
    "EXPORT_CSV",
    "missing UTF-8 BOM bytes"
  );
  const csvText = csvBuffer.toString("utf8");
  assert(csvText.includes(EXPECTED.export.formula_guarded), "EXPORT_CSV", "formula guard missing");
  assert(csvText.includes(EXPECTED.export.invalid_verbatim_row), "EXPORT_CSV", "invalid verbatim not exported");
  assert(csvText.includes(EXPECTED.export.correction_row), "EXPORT_CSV", "correction overlay not exported");
  const manifestResponse = await session.ok("EXPORT_MANIFEST", "GET", `/api/research-runs/${comparisonRunId}/export?format=manifest`);
  const manifest = manifestResponse.json;
  assert(manifest.artifact === EXPECTED.export.manifest_artifact, "EXPORT_MANIFEST", "wrong artifact kind");
  const manifestCorrection = manifest.cells.find(
    (cell) => cell.origin === "correction" && cell.row_source_id === acmeId && cell.column_id === colPrice
  );
  assert(manifestCorrection?.corrected_at, "EXPORT_MANIFEST", "correction provenance missing from manifest");
  assert(
    manifest.evidence.length > 0 && manifest.evidence.every((entry) => Array.isArray(entry.locators) && entry.locators.length > 0),
    "EXPORT_MANIFEST",
    "manifest evidence lacks typed locators"
  );

  stage = "COMPARISON_ARTIFACT";
  const comparisonArtifact = await session.ok("COMPARISON_ARTIFACT", "POST", `/api/research-runs/${comparisonRunId}/artifacts`, {
    body: {},
  });
  const comparisonDraftPayload = JSON.stringify(
    (
      await session.ok(
        "COMPARISON_ARTIFACT",
        "GET",
        `/api/documents/${comparisonArtifact.json.document_id}/revisions/${comparisonArtifact.json.document_revision_id}`
      )
    ).json.payload
  );
  assert(comparisonDraftPayload.includes("(corrected)"), "COMPARISON_ARTIFACT", "correction label missing");
  assert(comparisonDraftPayload.includes("not found"), "COMPARISON_ARTIFACT", "not-found label missing");
  assert(comparisonDraftPayload.includes("(invalid machine output)"), "COMPARISON_ARTIFACT", "invalid label missing");

  stage = "RERUN";
  const rerun = await session.ok("RERUN_START", "POST", `/api/research/${comparisonDefinitionId}/runs`, {
    body: { rerun_of: comparisonRunId, rerun_selection: { row_source_ids: [blueId], column_ids: [colPrice] } },
  });
  const rerunId = rerun.json.id;
  assert(rerun.json.rerun_of === comparisonRunId, "RERUN", "rerun lineage missing");
  const finishedRerun = await pollUntil("RERUN", 240_000, async () => {
    const run = await session.ok("RERUN", "GET", `/api/research-runs/${rerunId}`);
    return ["completed", "needs_review", "failed", "cancelled"].includes(run.json.status) ? run.json : false;
  });
  assert(finishedRerun.status === "completed", "RERUN", `status ${finishedRerun.status}`);
  const rerunTable = await pollUntil("RERUN_TABLE", 20_000, async () => {
    const table = await session.ok("RERUN_TABLE", "GET", `/api/research-runs/${rerunId}/table?limit=100&against=${comparisonRunId}`);
    return table.json.comparison ? table.json : false;
  });
  const carriedCorrection = cellFor(rerunTable, colPrice, acmeId, "correction");
  assert(
    carriedCorrection?.value === EXPECTED.review.correction_acme_price &&
      carriedCorrection?.corrected_from_run_id === comparisonRunId,
    "RERUN_CARRY",
    "user override was not carried visibly into the rerun"
  );
  assert(
    cellFor(rerunTable, colPrice, blueId, "machine")?.value === EXPECTED.review.rerun_blue_price,
    "RERUN",
    "rerun machine value missing"
  );
  const changedPrice = rerunTable.comparison.changed_cells.find(
    (entry) => entry.row_source_id === blueId && entry.column_id === colPrice
  );
  assert(
    changedPrice?.machine_changed === true &&
      changedPrice.before.machine.value === BLURIVER.price &&
      changedPrice.after.machine.value === EXPECTED.review.rerun_blue_price,
    "RERUN_DIFF",
    "against-diff does not show the changed cell"
  );
  assert(
    rerunTable.comparison.carried_overrides.some(
      (entry) => entry.column_id === colPrice && entry.row_source_id === acmeId
    ),
    "RERUN_DIFF",
    "carried overrides not disclosed in the diff"
  );

  stage = "LOCK_PROOF";
  const duplicate = startServer(dataDir, provider.origin);
  duplicate.waitListening.catch(() => undefined); // expected rejection: the duplicate must not start
  const duplicateFailure = await Promise.race([
    duplicate.exited.then((status) => status ?? { code: -1 }),
    new Promise((resolve) => setTimeout(() => resolve(null), 45_000)),
  ]);
  if (duplicate.child.exitCode === null && !duplicate.child.killed) duplicate.child.kill("SIGKILL");
  assert(duplicateFailure !== null && duplicateFailure.code !== 0, "LOCK_PROOF", "a second backend boot was not refused");
  const healthAfterRefusal = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  assert(healthAfterRefusal.status === 200, "LOCK_PROOF", "primary server unhealthy after refused duplicate");
  process.kill(server.child.pid, 0); // throws when the primary pid is gone

  // Graceful shutdown before assembling the summary.
  stage = "SHUTDOWN";
  server.child.kill("SIGTERM");
  const shutdown = await Promise.race([
    server.exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 90_000)),
  ]);
  if (shutdown === null) {
    server.child.kill("SIGKILL");
    throw new StageFailure("SHUTDOWN", "backend did not stop within 90s");
  }
  assert(shutdown.code === 0, "SHUTDOWN", `exit ${shutdown.code}${shutdown.signal ? `/${shutdown.signal}` : ""}`);

  summary = {
    ok: true,
    script: "e2e-local-research",
    duration_ms: Date.now() - startedAt,
    chat_calls: provider.chatCallCount(),
    sources_ingested: SUPPLIER_DOCS.length,
    memo: {
      status: finishedMemo.status,
      evidence: memoEvidence.length,
      conflicting_cited_excerpts: conflicting.evidence_refs.length,
      gaps: memoGaps.length,
    },
    comparison: {
      status: finishedComparison.status,
      machine_cells: finishedComparison.counts.machine_cell_count,
      invalid_verbatim_cells: EXPECTED.comparison.invalid_cells,
      conflicting_cells: EXPECTED.comparison.conflicting_cells,
      not_found_cells: EXPECTED.comparison.not_found_cells,
      correction_overlay: true,
      rerun_status: finishedRerun.status,
      rerun_changed_cells: rerunTable.comparison.changed_total,
      rerun_carried_overrides: rerunTable.comparison.carried_overrides.length,
    },
    exports: {
      csv_bytes: csvBuffer.length,
      csv_formula_guard: true,
      manifest_evidence: manifest.evidence.length,
      manifest_correction_provenance: true,
    },
    artifact: {
      memo_document_published: publication.version,
      pdf_magic: true,
      html_self_contained: true,
      comparison_draft: true,
    },
    proofs: { duplicate_boot_refused: true, pid_alive_after_refusal: true, clean_shutdown: true },
    // Only emitted after the finally block proves the workspace is gone.
    workspace_removed: true,
  };
}

try {
  await main();
} catch (error) {
  reportFailure(error);
} finally {
  if (server && server.child.exitCode === null) server.child.kill("SIGKILL");
  if (provider) await provider.close().catch(() => undefined);
  if (workspace) {
    if (process.exitCode === 1 && keepOnFailure) {
      process.stderr.write(`run tree kept at ${workspace}\n`);
    } else {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 4 });
      if (process.exitCode !== 1 && fs.existsSync(workspace)) {
        process.stderr.write(`e2e-local-research FAILED at CLEANUP: workspace still present at ${workspace}\n`);
        process.stdout.write(`${JSON.stringify({ ok: false, script: "e2e-local-research", failed_stage: "CLEANUP" })}\n`);
        process.exitCode = 1;
      }
    }
  }
  if (process.exitCode !== 1) {
    assert(summary !== null, "SUMMARY", "no summary assembled");
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = 0;
  }
}
