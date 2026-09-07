#!/usr/bin/env node
/** Real process-boundary companion. Uses unchanged prebuilt production output. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createIsolatedWorkspace } from "./harness/workspace.mjs";
import { createEvidenceOutput } from "./harness/evidence.mjs";
import { startServer } from "./harness/server.mjs";
import { launchProvider, launchFixture } from "./harness/providers.mjs";
import {
  assert,
  fetchJson,
  parseArgs,
  pidAlive,
  pollUntil,
} from "./harness/util.mjs";
import { prepareBriefLifecycle } from "./harness/briefLifecycle.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(repoRoot, "server/package.json"));
const Database = require("better-sqlite3");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const args = parseArgs(process.argv.slice(2));
assert(
  args._.length === 0 &&
    Object.keys(args).every((key) =>
      ["_", "case", "evidence-dir", "keep-on-failure"].includes(key),
    ),
  "LIFECYCLE_ARGUMENT_UNKNOWN",
);
const requiredCases = [
  "research",
  "rewrite",
  "mcp",
  "analysis",
  "render",
  "knowledge",
  "brief",
];
assert(
  args.case === undefined || requiredCases.includes(args.case),
  "LIFECYCLE_CASE_UNKNOWN",
);
const evidence = createEvidenceOutput(args["evidence-dir"]);
const summary = {
  entry: "run-product-lifecycle",
  started_at: new Date().toISOString(),
  checks: [],
  passed: false,
  scope: args.case ?? "all",
  required_cases: requiredCases,
  completed_cases: [],
  runtime_files_sha256: Object.fromEntries(
    [
      "server/dist/index.js",
      "server/dist/serverApp.js",
      "server/dist/briefRunner.js",
      "server/dist/knowledgeRefresh.js",
      "server/dist/knowledgeWatch.js",
      "server/dist/routes/knowledge.js",
    ].map((file) => [file, sha(fs.readFileSync(path.join(repoRoot, file)))]),
  ),
};
const workspace = createIsolatedWorkspace({ repoRoot, runId: "lifecycle" });
let server;
let provider;
let token;
function rows(sql, ...values) {
  const db = new Database(
    path.join(workspace.workspaceDir, "borealis.sqlite"),
    { readonly: true, fileMustExist: true },
  );
  try {
    return db.prepare(sql).all(...values);
  } finally {
    db.close();
  }
}
async function api(route, { method = "GET", body, status = 200 } = {}) {
  const result = await fetchJson(`${server.origin}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { requestBody: JSON.stringify(body) }),
    timeoutMs: 60_000,
  });
  assert(
    [].concat(status).includes(result.status),
    `LIFECYCLE_HTTP_${method}_${result.status}_${result.body?.code ?? "UNKNOWN"}`,
  );
  return result.body;
}
async function wait(probe, code, deadlineMs = 45_000) {
  const result = await pollUntil(probe, { deadlineMs, intervalMs: 50 });
  assert(Boolean(result), code);
  return result;
}
async function boot() {
  server = await startServer({
    workspace,
    repoRoot,
    provider,
    models: provider.models,
  });
  const owned = server;
  workspace.onCleanup(() => owned.stop());
  await server.waitBaseline();
}
async function quitActive(kind) {
  process.stdout.write(`lifecycle active quit: ${kind}\n`);
  const pid = server.pid;
  // Intentionally NO quiesce/readiness gate: the product must drain active work.
  const stopped = await server.stop();
  if (stopped.escalated || stopped.exited.code !== 0)
    summary.unclean_stop = {
      kind,
      escalated: stopped.escalated,
      exited: stopped.exited,
    };
  assert(
    stopped.gone &&
      !stopped.escalated &&
      stopped.exited.code === 0 &&
      stopped.exited.signal === null,
    `LIFECYCLE_${kind}_UNCLEAN_QUIT`,
  );
  assert(
    !pidAlive(pid) && workspace.verifyLockReleased().released,
    `LIFECYCLE_${kind}_LOCK_LEAK`,
  );
  summary.checks.push({
    kind,
    signal: "SIGTERM",
    active_before_signal: true,
    clean_exit: true,
    lock_released: true,
  });
}
async function upload(name, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  const response = await fetch(`${server.origin}/api/sources/upload`, {
    method: "POST",
    body: form,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.status === 200, "LIFECYCLE_UPLOAD");
  const source = await response.json();
  await wait(
    async () =>
      (await api("/api/sources")).items.find(
        (s) => s.id === source.id && s.status === "ready",
      ),
    "LIFECYCLE_SOURCE_READY",
  );
  return source.id;
}
const slow = {
  type: "slow",
  delay_ms: 120_000,
  pieces: ["held synthetic output"],
};
const text = (value) => ({
  type: "text",
  pieces: [typeof value === "string" ? value : JSON.stringify(value)],
});
function descendantPids(parent) {
  const pairs = execFileSync("/bin/ps", ["-ax", "-o", "pid=,ppid="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const found = new Set([parent]);
  for (;;) {
    const before = found.size;
    for (const [pid, ppid] of pairs) if (found.has(ppid)) found.add(pid);
    if (before === found.size) break;
  }
  found.delete(parent);
  return [...found];
}

async function researchCrash(sourceId) {
  const columns = ["Price", "Seats"].map((label) => ({
    id: randomUUID(),
    label,
    question: `What is the ${label.toLowerCase()}?`,
    type: "number",
  }));
  const definition = await api("/api/research", {
    method: "POST",
    status: 201,
    body: {
      title: "Process interruption comparison",
      question: "What are the price and seats?",
      output_kind: "comparison",
      source_ids: [sourceId],
      chat_model: provider.models.chatModel,
      columns,
      plan: {
        steps: [
          {
            id: randomUUID(),
            objective: "Find price and seats",
            questions: ["price"],
          },
        ],
      },
    },
  });
  const callsBefore = (await provider.state()).chat_calls;
  await provider.setScript({
    steps: [
      {
        type: "slow",
        delay_ms: 2_000,
        pieces: ["Synthetic source price and seats captured."],
      },
    ],
    onExhausted: "fail",
  });
  const accepted = await api(`/api/research/${definition.id}/runs`, {
    method: "POST",
    status: 201,
    body: {},
  });
  const runId = accepted.id;
  const captured = await wait(async () => {
    const items = (await api(`/api/research-runs/${runId}/evidence`)).items;
    return items.length ? items : false;
  }, "LIFECYCLE_RESEARCH_CAPTURE");
  await wait(
    async () => (await provider.state()).chat_calls > callsBefore,
    "LIFECYCLE_RESEARCH_SUMMARY_DISPATCH",
  );
  const payload = (value) => ({
    cells: [
      {
        source_id: sourceId,
        value,
        status: "supported",
        evidence_ids: [captured[0].id],
      },
    ],
  });
  await provider.setScript({
    steps: [text(payload(12000)), slow],
    onExhausted: "fail",
  });
  await wait(
    () =>
      rows("SELECT column_id FROM research_table_cells WHERE run_id=?", runId)
        .length === 1 &&
      rows("SELECT status FROM research_runs WHERE id=?", runId)[0]?.status ===
        "running",
    "LIFECYCLE_RESEARCH_FIRST_CELL",
  );
  const firstCell = rows(
    "SELECT column_id,row_source_id,row_generation,origin,value,status,evidence_refs FROM research_table_cells WHERE run_id=?",
    runId,
  )[0];
  const beforeEvidence = rows(
    "SELECT * FROM research_evidence WHERE run_id=? ORDER BY id",
    runId,
  );
  const oldPid = server.pid;
  process.kill(oldPid, "SIGKILL"); // Exact owned synthetic server only; intentional crash, not cleanup escalation.
  await wait(() => !pidAlive(oldPid), "LIFECYCLE_CRASH_PROCESS_EXIT");
  assert(
    rows("SELECT status FROM research_runs WHERE id=?", runId)[0]?.status ===
      "running",
    "LIFECYCLE_CRASH_DURABLE_RUNNING",
  );
  await provider.setScript({
    steps: [text(payload(12000)), text(payload(24))],
    onExhausted: "fail",
  });
  await boot();
  const terminal = await wait(async () => {
    const run = await api(`/api/research-runs/${runId}`);
    return ["completed", "needs_review", "failed"].includes(run.status)
      ? run
      : false;
  }, "LIFECYCLE_RESEARCH_RECOVERY");
  assert(
    ["completed", "needs_review"].includes(terminal.status),
    "LIFECYCLE_RESEARCH_RECOVERY_FAILED",
  );
  const cells = rows(
    "SELECT column_id,value,status,evidence_refs FROM research_table_cells WHERE run_id=? ORDER BY column_id",
    runId,
  );
  assert(
    cells.length === 2 &&
      new Set(cells.map((cell) => cell.column_id)).size === 2,
    "LIFECYCLE_RESEARCH_DUPLICATE_CELLS",
  );
  assert(
    cells.every((cell) => cell.status === "supported") &&
      cells
        .map((c) => JSON.parse(c.value))
        .sort((a, b) => a - b)
        .join() === "24,12000",
    "LIFECYCLE_RESEARCH_VALUES",
  );
  assert(
    cells.find((c) => c.column_id === columns[0].id)?.value === "12000" &&
      cells.find((c) => c.column_id === columns[1].id)?.value === "24",
    "LIFECYCLE_RESEARCH_COLUMN_BINDING",
  );
  // An in-progress synthesis legitimately retries its machine-cell key; the
  // store replaces its attempt timestamps. Value/scope/evidence and cardinality
  // are the contract here, while captured evidence rows stay byte-identical.
  assert(
    JSON.stringify(
      rows(
        "SELECT column_id,row_source_id,row_generation,origin,value,status,evidence_refs FROM research_table_cells WHERE run_id=? AND column_id=?",
        runId,
        firstCell.column_id,
      )[0],
    ) === JSON.stringify(firstCell),
    "LIFECYCLE_RESEARCH_COMMITTED_CELL_CHANGED",
  );
  assert(
    JSON.stringify(
      rows("SELECT * FROM research_evidence WHERE run_id=? ORDER BY id", runId),
    ) === JSON.stringify(beforeEvidence),
    "LIFECYCLE_RESEARCH_EVIDENCE_CHANGED",
  );
  assert(
    rows("SELECT id FROM documents").length === 0,
    "LIFECYCLE_RESEARCH_AUTOPUBLISHED_ARTIFACT",
  );
  await api(`/api/research-runs/${runId}/artifacts`, {
    method: "POST",
    status: 201,
    body: {},
  });
  assert(
    rows("SELECT id FROM documents").length === 1,
    "LIFECYCLE_RESEARCH_DOCUMENT_COUNT",
  );
  summary.checks.push({
    kind: "research-crash",
    signal: "SIGKILL",
    real_process_reopened: true,
    previously_committed_cells: 1,
    final_cells: 2,
    evidence_preserved: true,
    no_automatic_artifacts: true,
    explicit_draft_count: 1,
  });
}

async function activeRewriteAndResearch(sourceId) {
  const section = randomUUID();
  const markdown = "Synthetic revenue grew twelve percent.";
  const document = await api("/api/documents", {
    method: "POST",
    status: 201,
    body: {
      title: "Interrupted rewrite",
      tree: {
        title: "Interrupted rewrite",
        sections: [{ id: section, heading: "Results", markdown }],
        evidence: [],
      },
    },
  });
  const snapshotDraft = () =>
    JSON.stringify({
      document: rows(
        "SELECT * FROM documents WHERE id=?",
        document.document.id,
      ),
      revisions: rows(
        "SELECT * FROM document_revisions WHERE document_id=? ORDER BY revision",
        document.document.id,
      ),
    });
  const originalDraft = snapshotDraft();
  const initialCalls = (await provider.state()).chat_calls;
  await provider.setScript({ steps: [slow], onExhausted: "repeat-last" });
  const rewrite = await api(`/api/documents/${document.document.id}/rewrites`, {
    method: "POST",
    status: 202,
    body: {
      base_revision_id: document.revision.id,
      section_id: section,
      selection_sha256: sha(markdown),
      instruction: "Make this concise.",
    },
  });
  await wait(
    () =>
      rows("SELECT status FROM document_rewrites WHERE id=?", rewrite.id)[0]
        ?.status === "running",
    "LIFECYCLE_REWRITE_ACTIVE",
  );
  await wait(
    async () => (await provider.state()).chat_calls === initialCalls + 1,
    "LIFECYCLE_REWRITE_MODEL_DISPATCH",
  );
  const definition = await api("/api/research", {
    method: "POST",
    status: 201,
    body: {
      title: "Orderly research interruption",
      question: "What is the price?",
      output_kind: "memo",
      source_ids: [sourceId],
      chat_model: provider.models.chatModel,
      plan: {
        steps: [
          { id: randomUUID(), objective: "Find price", questions: ["price"] },
        ],
      },
    },
  });
  const research = await api(`/api/research/${definition.id}/runs`, {
    method: "POST",
    status: 201,
    body: {},
  });
  await wait(
    () =>
      rows(
        "SELECT ordinal FROM research_steps WHERE run_id=? AND status='running'",
        research.id,
      ).length === 1 &&
      rows("SELECT id FROM research_evidence WHERE run_id=?", research.id)
        .length > 0,
    "LIFECYCLE_RESEARCH_ACTIVE",
  );
  await wait(
    async () => (await provider.state()).chat_calls === initialCalls + 2,
    "LIFECYCLE_RESEARCH_MODEL_DISPATCH",
  );
  await quitActive("rewrite-and-research");
  assert(
    rows("SELECT status FROM document_rewrites WHERE id=?", rewrite.id)[0]
      ?.status === "failed",
    "LIFECYCLE_REWRITE_NOT_FAILED",
  );
  assert(
    snapshotDraft() === originalDraft,
    "LIFECYCLE_REWRITE_MUTATED_DRAFT_DURING_SHUTDOWN",
  );
  const beforeCalls = (await provider.state()).chat_calls;
  await provider.setScript({
    steps: [
      text("Source price captured."),
      text({ claims: [], gaps: ["Synthetic gap; no unsupported assertion."] }),
    ],
    onExhausted: "fail",
  });
  await boot();
  await wait(
    async () =>
      ["completed", "needs_review"].includes(
        (await api(`/api/research-runs/${research.id}`)).status,
      ),
    "LIFECYCLE_ORDERLY_RESEARCH_RESUME",
  );
  assert(
    (await provider.state()).chat_calls - beforeCalls === 2,
    "LIFECYCLE_REWRITE_AUTOREPLAYED",
  );
  assert(snapshotDraft() === originalDraft, "LIFECYCLE_REWRITE_MUTATED_DRAFT");
  summary.checks.push({
    kind: "rewrite-and-research-reopen",
    rewrite_failed_without_replay: true,
    original_revision_preserved: true,
    research_resumed: true,
  });
}

async function activeChatMcp() {
  const receipt = path.join(workspace.root, "mcp-dispatch.jsonl");
  const connection = await api("/api/connections", {
    method: "POST",
    status: 201,
    body: {
      name: "Lifecycle stdio",
      kind: "mcp_stdio",
      config: {
        command: process.execPath,
        args: [path.join(repoRoot, "scripts/e2e/fixtures/lifecycle-mcp.mjs")],
        cwd: null,
      },
      credentials: { env: { E2E_LIFECYCLE_RECEIPT: receipt } },
    },
  });
  const discovered = await api(`/api/connections/${connection.id}/discover`, {
    method: "POST",
    body: {},
  });
  const tool = discovered.tools.find((item) => item.name === "read_slow");
  assert(tool, "LIFECYCLE_MCP_DISCOVERY");
  const agent = await api("/api/agents", {
    method: "POST",
    status: 201,
    body: {
      name: "Lifecycle agent",
      instructions: "Use the selected synthetic read tool.",
      mcp_tools: [
        {
          connection_id: connection.id,
          tool_id: tool.tool_id,
          discovery_revision: discovered.discovery_revision,
          allow_write: false,
        },
      ],
    },
  });
  const chat = await api("/api/chats", {
    method: "POST",
    status: [200, 201],
    body: {
      title: "Lifecycle chat",
      model: provider.models.chatModel,
      source_mode: "selected",
      source_ids: [],
      agent_id: agent.id,
    },
  });
  const alias = `mcp_${sha(`borealis-mcp-alias:v1|${connection.id}|${tool.tool_id}`).slice(0, 32)}`;
  await provider.setScript({
    steps: [
      {
        type: "tool_call",
        id: "lifecycle-read",
        name_pieces: [alias],
        argument_pieces: ["{}"],
      },
    ],
    onExhausted: "fail",
  });
  // Consume SSE without cancelling it; shutdown, not an HTTP-client abort, owns cancellation.
  const request = fetch(`${server.origin}/api/chats/${chat.id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ content: "Read the synthetic lifecycle fixture." }),
    signal: AbortSignal.timeout(60_000),
  })
    .then(async (response) => ({
      status: response.status,
      body: await response.text(),
    }))
    .catch(() => ({ status: 0 }));
  const dispatch = await wait(
    () =>
      fs.existsSync(receipt) &&
      JSON.parse(fs.readFileSync(receipt, "utf8").trim()),
    "LIFECYCLE_MCP_DISPATCH",
  );
  assert(
    Number.isSafeInteger(dispatch.pid) && pidAlive(dispatch.pid),
    "LIFECYCLE_MCP_CHILD_NOT_ACTIVE",
  );
  workspace.trackPid(dispatch.pid, "product-owned-mcp-child");
  const activeRuns = rows(
    "SELECT id,status FROM chat_runs WHERE chat_id=?",
    chat.id,
  );
  assert(
    activeRuns.length === 1 && activeRuns[0].status === "running",
    "LIFECYCLE_CHAT_NOT_ACTIVE",
  );
  const userMessages = rows(
    "SELECT * FROM messages WHERE chat_id=? AND role='user' ORDER BY created_at,id",
    chat.id,
  );
  assert(userMessages.length === 1, "LIFECYCLE_CHAT_USER_MESSAGE_MISSING");
  await quitActive("chat-mcp-child");
  await request;
  assert(!pidAlive(dispatch.pid), "LIFECYCLE_MCP_CHILD_LEAK");
  const before = fs.readFileSync(receipt, "utf8");
  await boot();
  const restoredRuns = rows(
    "SELECT id,status FROM chat_runs WHERE chat_id=?",
    chat.id,
  );
  assert(
    restoredRuns.length === 1 &&
      restoredRuns[0].id === activeRuns[0].id &&
      !["running", "queued"].includes(restoredRuns[0].status),
    "LIFECYCLE_CHAT_REPLAYED",
  );
  assert(
    JSON.stringify(
      rows(
        "SELECT * FROM messages WHERE chat_id=? AND role='user' ORDER BY created_at,id",
        chat.id,
      ),
    ) === JSON.stringify(userMessages),
    "LIFECYCLE_CHAT_USER_MESSAGE_CHANGED",
  );
  assert(
    fs.readFileSync(receipt, "utf8") === before,
    "LIFECYCLE_EXTERNAL_CALL_REPLAYED",
  );
  summary.checks.push({
    kind: "chat-mcp-reopen",
    child_exit_proven: true,
    external_dispatch_count: 1,
    automatic_replay: false,
  });
}

async function activeAnalysis() {
  const analysis = await api("/api/analyses", {
    method: "POST",
    status: 201,
    body: {
      title: "Lifecycle expensive bounded query",
      sql: "SELECT sum(sqrt(i::DOUBLE)) AS total FROM range(1000000000) t(i)",
      source_ids: [],
    },
  });
  const accepted = await api(`/api/analyses/${analysis.id}/runs`, {
    method: "POST",
    status: 202,
    body: { operation_id: randomUUID() },
  });
  await wait(
    () =>
      rows("SELECT status FROM analysis_runs WHERE id=?", accepted.run.id)[0]
        ?.status === "running",
    "LIFECYCLE_ANALYSIS_ACTIVE",
  );
  await quitActive("analysis-query");
  const ended = rows(
    "SELECT status FROM analysis_runs WHERE id=?",
    accepted.run.id,
  )[0];
  assert(
    ["failed", "cancelled"].includes(ended?.status),
    "LIFECYCLE_ANALYSIS_DRAIN_STATUS",
  );
  assert(
    rows("SELECT id FROM analysis_results WHERE run_id=?", accepted.run.id)
      .length === 0,
    "LIFECYCLE_ANALYSIS_PARTIAL_RESULT",
  );
  await boot();
  assert(
    rows("SELECT status FROM analysis_runs WHERE id=?", accepted.run.id)[0]
      ?.status === ended.status,
    "LIFECYCLE_ANALYSIS_REPLAYED",
  );
}

async function activeRendering() {
  const document = await api("/api/documents", {
    method: "POST",
    status: 201,
    body: {
      title: "Lifecycle publication",
      tree: {
        title: "Lifecycle publication",
        sections: Array.from({ length: 20 }, (_, i) => ({
          id: randomUUID(),
          heading: `Section ${i + 1}`,
          markdown: "Synthetic publication layout and drain proof. ".repeat(80),
        })),
        evidence: [],
      },
    },
  });
  const operation = randomUUID();
  const request = api(
    `/api/documents/${document.document.id}/revisions/${document.revision.id}/publish`,
    {
      method: "POST",
      status: [200, 201, 502],
      body: { operation_id: operation },
    },
  ).catch(() => null);
  const renderChildren = await wait(() => {
    const children = descendantPids(server.pid);
    return children.length > 0 &&
      rows(
        "SELECT status FROM document_publication_intents WHERE operation_id=?",
        operation,
      )[0]?.status === "rendering"
      ? children
      : false;
  }, "LIFECYCLE_RENDER_ACTIVE");
  for (const pid of renderChildren)
    workspace.trackPid(pid, "product-owned-renderer-child");
  await quitActive("document-rendering");
  const result = await request;
  assert(
    renderChildren.every((pid) => !pidAlive(pid)),
    "LIFECYCLE_RENDER_CHILD_LEAK",
  );
  const intent = rows(
    "SELECT * FROM document_publication_intents WHERE operation_id=?",
    operation,
  )[0];
  assert(
    result && ["completed", "failed"].includes(intent?.status),
    "LIFECYCLE_RENDER_DID_NOT_DRAIN",
  );
  if (intent.status === "failed") {
    // Playwright installs a SIGTERM handler once Chromium is launched. An
    // actual mid-render quit can therefore cancel PDF output. Require an
    // honest durable error and clean artifact removal, then explicit retry.
    assert(
      intent.error_code === "PUBLICATION_PDF_FAILED" &&
        rows(
          "SELECT id FROM document_publications WHERE document_id=?",
          document.document.id,
        ).length === 0,
      "LIFECYCLE_RENDER_PARTIAL_PUBLICATION",
    );
    workspace.assertOwnedPath(intent.artifact_directory);
    assert(
      !fs.existsSync(intent.artifact_directory),
      "LIFECYCLE_RENDER_PARTIAL_FILES",
    );
    await boot();
    assert(
      rows(
        "SELECT id FROM document_publications WHERE document_id=?",
        document.document.id,
      ).length === 0,
      "LIFECYCLE_RENDER_AUTORETRIED",
    );
    const retried = await api(
      `/api/documents/${document.document.id}/revisions/${document.revision.id}/publish`,
      { method: "POST", status: 201, body: { operation_id: operation } },
    );
    assert(
      retried.status === "published" &&
        rows(
          "SELECT attempts FROM document_publication_intents WHERE operation_id=?",
          operation,
        )[0]?.attempts ===
          intent.attempts + 1,
      "LIFECYCLE_RENDER_RETRY",
    );
    const retryStop = await server.stop();
    assert(
      retryStop.gone &&
        !retryStop.escalated &&
        retryStop.exited.code === 0 &&
        retryStop.exited.signal === null &&
        workspace.verifyLockReleased().released,
      "LIFECYCLE_RENDER_RETRY_STOP",
    );
  }
  const publications = rows(
    "SELECT * FROM document_publications WHERE document_id=?",
    document.document.id,
  );
  assert(publications.length === 1, "LIFECYCLE_RENDER_PUBLICATION_COUNT");
  assert(
    fs.readFileSync(publications[0].pdf_path).subarray(0, 5).toString() ===
      "%PDF-",
    "LIFECYCLE_RENDER_PDF_MAGIC",
  );
  const hash = sha(fs.readFileSync(publications[0].pdf_path));
  await boot();
  assert(
    rows(
      "SELECT id FROM document_publications WHERE document_id=?",
      document.document.id,
    ).length === 1 && sha(fs.readFileSync(publications[0].pdf_path)) === hash,
    "LIFECYCLE_RENDER_REPLAYED",
  );
  summary.checks.push({
    kind: "render-reopen",
    interrupted_outcome: intent.status,
    explicit_retry_after_failure: intent.status === "failed",
    exactly_one_publication: true,
    renderer_children_gone: true,
    pdf_preserved: true,
  });
}

async function activeKnowledge() {
  const root = path.join(workspace.root, "webdav-root");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(
    path.join(root, "managed.md"),
    "# Synthetic managed knowledge\nAnnual price: 12000 USD.\n",
  );
  const dav = await launchFixture({
    workspace,
    name: "webdav",
    env: { E2E_WEBDAV_ROOT: root },
  });
  workspace.onCleanup(() => dav.stop());
  let held = false;
  let activeRequests = 0;
  let dispatched = 0;
  // Fixed-origin local proxy only. The hold observes a real transport request;
  // it never changes product state and aborting the request is product-owned.
  const proxy = createServer(async (req, res) => {
    if (held) {
      dispatched++;
      activeRequests++;
      res.once("close", () => {
        activeRequests--;
      });
      req.resume();
      return;
    }
    try {
      const chunks = [];
      for await (const piece of req) chunks.push(piece);
      const body = Buffer.concat(chunks);
      assert(body.length <= 64 * 1024, "LIFECYCLE_DAV_BODY_BOUND");
      const upstream = await fetch(`${dav.ready.origin}${req.url}`, {
        method: req.method,
        headers: {
          authorization: req.headers.authorization ?? "",
          depth: req.headers.depth ?? "1",
          "content-type": req.headers["content-type"] ?? "application/xml",
        },
        ...(body.length ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      assert(bytes.length <= 64 * 1024, "LIFECYCLE_DAV_RESPONSE_BOUND");
      res.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
        "content-length": String(bytes.length),
      });
      res.end(bytes);
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  workspace.onCleanup(
    () =>
      new Promise((resolve) => {
        proxy.closeAllConnections();
        proxy.close(resolve);
      }),
  );
  const library = await api("/api/libraries", {
    method: "POST",
    status: 201,
    body: { name: "Lifecycle knowledge" },
  });
  const connection = await api("/api/knowledge-connections", {
    method: "POST",
    status: 201,
    body: {
      name: "Lifecycle WebDAV",
      kind: "webdav",
      library_id: library.id,
      config: {
        url: `http://127.0.0.1:${proxy.address().port}`,
        username: "e2e-user",
        password: "e2e-pass",
      },
    },
  });
  const started = await api(
    `/api/knowledge-connections/${connection.id}/previews`,
    { method: "POST", status: 202 },
  );
  const preview = await wait(async () => {
    const result = await api(`/api/knowledge-previews/${started.preview.id}`);
    return result.preview.status === "complete" ? result : false;
  }, "LIFECYCLE_KNOWLEDGE_PREVIEW");
  const selections = preview.entries
    .filter((entry) => entry.classification === "new")
    .map((entry) => ({
      entry_id: entry.entry_id,
      selection_token: entry.selection_token,
    }));
  assert(selections.length === 1, "LIFECYCLE_KNOWLEDGE_FIXTURE_COUNT");
  const applied = await api(
    `/api/knowledge-previews/${preview.preview.id}/apply`,
    {
      method: "POST",
      body: { expected_revision: preview.preview.revision, selections },
    },
  );
  await wait(
    async () =>
      (await api(`/api/knowledge-refreshes/${applied.refresh_id}`)).refresh
        .status === "completed",
    "LIFECYCLE_KNOWLEDGE_IMPORTED",
  );
  const sourceId = applied.items[0].source_id;
  const before = rows("SELECT * FROM sources WHERE id=?", sourceId);
  held = true;
  const refresh = await api(
    `/api/knowledge-connections/${connection.id}/refreshes`,
    { method: "POST", status: 202, body: {} },
  );
  await wait(
    () =>
      activeRequests > 0 &&
      rows(
        "SELECT status FROM knowledge_refreshes WHERE id=?",
        refresh.refresh.id,
      )[0]?.status === "active",
    "LIFECYCLE_KNOWLEDGE_REFRESH_ACTIVE",
  );
  await quitActive("knowledge-webdav-refresh");
  await wait(() => activeRequests === 0, "LIFECYCLE_KNOWLEDGE_SOCKET_LEAK");
  assert(dispatched === 1, "LIFECYCLE_KNOWLEDGE_UNEXPECTED_DISPATCH");
  assert(
    JSON.stringify(rows("SELECT * FROM sources WHERE id=?", sourceId)) ===
      JSON.stringify(before),
    "LIFECYCLE_KNOWLEDGE_READY_CONTENT_CHANGED",
  );
  assert(
    rows(
      "SELECT status FROM knowledge_refreshes WHERE id=?",
      refresh.refresh.id,
    )[0]?.status === "cancelled",
    "LIFECYCLE_KNOWLEDGE_NOT_CANCELLED",
  );
  held = false;
  await boot();
  assert(
    rows(
      "SELECT status FROM knowledge_refreshes WHERE id=?",
      refresh.refresh.id,
    )[0]?.status === "cancelled",
    "LIFECYCLE_KNOWLEDGE_REPLAYED",
  );
  summary.checks.push({
    kind: "knowledge-reopen",
    aborted_transport_closed: true,
    prior_ready_source_preserved: true,
    no_automatic_replay: true,
  });
}

async function activeBrief() {
  const brief = await prepareBriefLifecycle({
    api,
    provider,
    upload,
    rows,
    wait,
  });
  await quitActive("brief-narrative");
  await brief.prepareRestart();
  await boot();
  const checks = await brief.verifyAfterRestart({ api, provider, rows, wait });
  // An additional real process reopen must not replay the completed draft.
  const stopped = await server.stop();
  assert(
    stopped.gone &&
      !stopped.escalated &&
      stopped.exited.code === 0 &&
      stopped.exited.signal === null &&
      workspace.verifyLockReleased().released,
    "LIFECYCLE_BRIEF_SECOND_REOPEN_STOP",
  );
  await boot();
  await brief.verifyAfterRestart({ api, provider, rows, wait });
  summary.checks.push({
    kind: "brief-reopen",
    ...checks,
    second_process_reopen_deduplicated: true,
  });
  // Real wall time: the process is absent when the next local/UTC occurrence
  // becomes due. No ledger timestamp or clock seam is modified for this proof.
  if (60_000 - (Date.now() % 60_000) < 2_000) {
    const nextMinute = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
    await wait(
      () => Date.now() > nextMinute,
      "LIFECYCLE_SCHEDULE_SETUP_WINDOW",
      3_000,
    );
  }
  const nextMinute = new Date(
    Math.floor(Date.now() / 60_000) * 60_000 + 60_000,
  );
  const scheduled = await api("/api/briefs", {
    method: "POST",
    status: 201,
    body: {
      name: "Closed across due time",
      analysis_id: brief.analysisId,
      report_title: "Scheduled catch-up",
      report_instruction: "Summarize the verified total.",
      source_ids: [brief.sourceId],
      schedule: {
        kind: "daily",
        hour: nextMinute.getUTCHours(),
        minute: nextMinute.getUTCMinutes(),
        time_zone: "UTC",
      },
    },
  });
  const expectedDue = Date.parse(
    rows("SELECT next_run_at FROM brief_recipes WHERE id=?", scheduled.id)[0]
      .next_run_at,
  );
  assert(
    expectedDue === nextMinute.getTime() &&
      rows("SELECT id FROM brief_runs WHERE recipe_id=?", scheduled.id)
        .length === 0,
    "LIFECYCLE_NOT_YET_DUE",
  );
  const absentPid = server.pid;
  const closed = await server.stop();
  assert(
    closed.gone &&
      !closed.escalated &&
      closed.exited.code === 0 &&
      closed.exited.signal === null &&
      Date.now() < expectedDue &&
      workspace.verifyLockReleased().released,
    "LIFECYCLE_CLOSED_BEFORE_DUE",
  );
  process.stdout.write(
    "lifecycle waiting for occurrence while product is stopped\n",
  );
  await wait(
    () => Date.now() > expectedDue + 100,
    "LIFECYCLE_REAL_DUE_TIME",
    61_000,
  );
  assert(
    !pidAlive(absentPid) &&
      rows("SELECT id FROM brief_runs WHERE recipe_id=?", scheduled.id)
        .length === 0,
    "LIFECYCLE_EXECUTED_WHILE_CLOSED",
  );
  await provider.setScript({
    steps: [
      text("The verified total is 100; one scheduled catch-up awaits review."),
    ],
    onExhausted: "fail",
  });
  await boot();
  const caught = await wait(() => {
    const runs = rows(
      "SELECT * FROM brief_runs WHERE recipe_id=?",
      scheduled.id,
    );
    return runs.length === 1 && runs[0].stage === "awaiting_review"
      ? runs[0]
      : false;
  }, "LIFECYCLE_SCHEDULE_CATCH_UP");
  assert(
    caught.trigger === "scheduled" &&
      caught.coalesced_count === 1 &&
      Date.parse(
        rows(
          "SELECT next_run_at FROM brief_recipes WHERE id=?",
          scheduled.id,
        )[0].next_run_at,
      ) > Date.now(),
    "LIFECYCLE_SCHEDULE_CURSOR",
  );
  const finalStop = await server.stop();
  assert(
    finalStop.gone &&
      !finalStop.escalated &&
      finalStop.exited.code === 0 &&
      finalStop.exited.signal === null &&
      workspace.verifyLockReleased().released,
    "LIFECYCLE_SCHEDULE_REOPEN_STOP",
  );
  await boot();
  assert(
    rows("SELECT id FROM brief_runs WHERE recipe_id=?", scheduled.id).length ===
      1 &&
      rows("SELECT id FROM brief_notifications WHERE run_id=?", caught.id)
        .length === 1,
    "LIFECYCLE_SCHEDULE_DUPLICATED",
  );
  summary.checks.push({
    kind: "closed-across-due-time",
    real_wall_clock: true,
    process_absent_when_due: true,
    exactly_one_scheduled_catch_up: true,
    next_cursor_advanced: true,
    second_reopen_deduplicated: true,
  });
}

try {
  provider = await launchProvider({ workspace });
  workspace.onCleanup(() => provider.stop());
  await boot();
  const registration = await api("/api/register", {
    method: "POST",
    status: [200, 201],
    body: {
      email: "lifecycle@borealis.test",
      password: "synthetic-lifecycle-test-password",
    },
  });
  token = registration.token;
  assert(typeof token === "string", "LIFECYCLE_TOKEN");
  const sourceId = await upload(
    "process-source.md",
    "# Contract\nThe annual price is 12000 USD. Seats included: 24.\n",
  );
  const cases = {
    research: () => researchCrash(sourceId),
    rewrite: () => activeRewriteAndResearch(sourceId),
    mcp: activeChatMcp,
    analysis: activeAnalysis,
    render: activeRendering,
    knowledge: activeKnowledge,
    brief: activeBrief,
  };
  for (const [name, run] of Object.entries(cases)) {
    if (args.case !== undefined && args.case !== name) continue;
    await run();
    summary.completed_cases.push(name);
  }
  assert(
    summary.completed_cases.length ===
      (args.case === undefined ? requiredCases.length : 1),
    "LIFECYCLE_REQUIRED_CASE_MISSING",
  );
  summary.passed = true;
} catch (error) {
  summary.failure = error?.code ?? "LIFECYCLE_ERROR";
  // Only the private disposable tree retains diagnostics; stdout stays content-free.
  fs.writeFileSync(
    path.join(workspace.logsDir, "failure.txt"),
    String(error?.stack ?? error),
    { mode: 0o600 },
  );
} finally {
  const cleanup = await workspace.cleanup({
    keep: args["keep-on-failure"] === true && !summary.passed,
  });
  summary.cleanup = cleanup;
  summary.passed = summary.passed && cleanup.problems.length === 0;
  summary.finished_at = new Date().toISOString();
  evidence?.finish(summary);
  process.stdout.write(`LIFECYCLE_SUMMARY ${JSON.stringify(summary)}\n`);
  if (cleanup.kept)
    process.stderr.write(`Synthetic diagnostic workspace: ${workspace.root}\n`);
  if (!summary.passed) process.exitCode = 1;
}
