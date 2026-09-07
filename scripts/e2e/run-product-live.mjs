#!/usr/bin/env node
/**
 * Live-model product acceptance (`pnpm test:e2e:product:live`).
 *
 * Runs the scoped finance + research acceptance against a CONFIGURED, compatible
 * local model pair (tool-capable chat model + embedding model) served by an
 * OpenAI-compatible endpoint (default LM Studio on loopback). Unlike the
 * scripted harness this exercises real model behavior; deterministic numeric
 * assertions still come from the product's own DuckDB/FTS paths compared
 * against independently computed fixture values, never from model prose.
 *
 * Availability semantics (END_TO_END_ACCEPTANCE): an unreachable provider or a
 * missing configured model is an EXPLICIT block/failure (nonzero exit with a
 * reason) — never an automatic pass. A chat model that cannot complete a real
 * tool-calling turn fails the run (the pair would be incompatible).
 *
 * Flags:
 *   --provider=URL          default http://127.0.0.1:1234
 *   --chat-model=ID         default qwen/qwen3.6-35b-a3b
 *   --embed-model=ID        default text-embedding-nomic-embed-text-v1.5
 *   --embed-dim=N           default 768
 *   --skip-build            reuse existing dist outputs
 *   --keep-on-failure       keep the isolated workspace and print its path
 *
 * Output contract: one content-free `E2E_LIVE_SUMMARY {json}` line (check
 * names, pass/fail, durations, model ids; NO prompts, NO document text, NO
 * provider payloads) plus summary.json in the run directory. Exit 0 only when
 * every check passed; 1 on any failed check; 2 on usage/build errors; 3 when
 * the model pair is unavailable (explicit block).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ENTRY_DIR, "..", "..");

const harnessUtil = await import(
  pathToFileURL(path.join(ENTRY_DIR, "harness/util.mjs")).href
);
const workspaceMod = await import(
  pathToFileURL(path.join(ENTRY_DIR, "harness/workspace.mjs")).href
);
const serverMod = await import(
  pathToFileURL(path.join(ENTRY_DIR, "harness/server.mjs")).href
);
const browserMod = await import(
  pathToFileURL(path.join(ENTRY_DIR, "harness/browser.mjs")).href
);
const financeExpected = await import(
  pathToFileURL(path.join(ENTRY_DIR, "fixtures", "lib", "finance-expected.mjs"))
    .href
);

const { HarnessError, assert, parseArgs, writeText } = harnessUtil;

function parseArgsLocal(argv) {
  const args = parseArgs(argv);
  return {
    provider: String(args.provider ?? "http://127.0.0.1:1234").replace(
      /\/+$/,
      "",
    ),
    chatModel: String(args["chat-model"] ?? "qwen/qwen3.6-35b-a3b"),
    embedModel: String(
      args["embed-model"] ?? "text-embedding-nomic-embed-text-v1.5",
    ),
    embedDim: Number.parseInt(String(args["embed-dim"] ?? "768"), 10),
    skipBuild: args["skip-build"] === true,
    keepOnFailure: args["keep-on-failure"] === true,
  };
}

function emit(summary) {
  process.stdout.write(`E2E_LIVE_SUMMARY ${JSON.stringify(summary)}\n`);
}

async function fetchJson(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function pollUntil(fn, { deadlineMs, intervalMs, label }) {
  const started = performance.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() - started > deadlineMs)
      throw new HarnessError("LIVE_POLL_TIMEOUT", label);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Authenticated multipart upload through the page context (apiFetch is JSON-only). */
async function uploadFile(session, filePath, name) {
  const token = await session.token();
  return session.page.evaluate(
    async ({ route, token, text, name }) => {
      const form = new FormData();
      form.append("file", new File([text], name, { type: "text/markdown" }));
      const res = await fetch(route, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const json = res.headers.get("content-type")?.includes("json")
        ? await res.json().catch(() => null)
        : null;
      return { status: res.status, body: json };
    },
    {
      route: "/api/sources/upload",
      token,
      text: fs.readFileSync(filePath, "utf8"),
      name,
    },
  );
}

async function main() {
  const cfg = parseArgsLocal(process.argv.slice(2));
  const checks = [];
  const startedAt = new Date().toISOString();
  const workspace = workspaceMod.createIsolatedWorkspace("borealis-e2e-live");
  let failure = null;
  let blocked = null;

  const check = async (name, fn) => {
    const start = performance.now();
    try {
      const detail = (await fn()) ?? {};
      checks.push({
        check: name,
        status: "pass",
        duration_ms: Math.round(performance.now() - start),
        ...detail,
      });
      return detail;
    } catch (error) {
      checks.push({
        check: name,
        status: "fail",
        duration_ms: Math.round(performance.now() - start),
        reason: String(error && error.code ? error.code : error).slice(0, 120),
      });
      throw error;
    }
  };

  try {
    /* -- preflight: the model pair must be configured and tool-capable ----- */
        await check("provider-reachable", async () => {
      let list;
      try {
        list = await fetchJson(`${cfg.provider}/v1/models`);
      } catch {
        blocked = `provider unreachable at ${cfg.provider}`;
        throw new HarnessError("PROVIDER_UNREACHABLE");
      }
      assert(
        list.status === 200 && Array.isArray(list.body?.data),
        "PROVIDER_MODELS_SHAPE",
      );
      const ids = new Set(list.body.data.map((entry) => entry.id));
      assert(
        ids.has(cfg.chatModel),
        "CHAT_MODEL_MISSING",
        `${cfg.chatModel} not served`,
      );
      assert(
        ids.has(cfg.embedModel),
        "EMBED_MODEL_MISSING",
        `${cfg.embedModel} not served`,
      );
      return { chat_model: cfg.chatModel, embed_model: cfg.embedModel };
    });

    await check("chat-model-tool-capable", async () => {
      const smoke = await fetchJson(
        `${cfg.provider}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: cfg.chatModel,
            stream: false,
            messages: [
              {
                role: "system",
                content:
                  "You must call the provided tool exactly once; never answer in prose.",
              },
              {
                role: "user",
                content: "Add the numbers 7 and 35 using the tool.",
              },
            ],
            tools: [
              {
                type: "function",
                function: {
                  name: "add",
                  description: "Add two numbers",
                  parameters: {
                    type: "object",
                    properties: {
                      a: { type: "number" },
                      b: { type: "number" },
                    },
                    required: ["a", "b"],
                  },
                },
              },
            ],
            tool_choice: "required",
            max_tokens: 300,
          }),
        },
        180_000,
      );
      assert(smoke.status === 200, "TOOL_SMOKE_HTTP", String(smoke.status));
      const message = smoke.body?.choices?.[0]?.message;
      const call = message?.tool_calls?.[0];
      assert(call?.function?.name === "add", "TOOL_SMOKE_NO_TOOL_CALL");
      const args = JSON.parse(call.function.arguments || "{}");
      assert(
        Number(args.a) + Number(args.b) === 42,
        "TOOL_SMOKE_BAD_ARGS",
        `${args.a}+${args.b}`,
      );
      return {};
    });

    if (!cfg.skipBuild) {
      for (const target of ["borealis-server", "borealis-web"]) {
        const proc = spawnSync("pnpm", ["--filter", target, "build"], {
          cwd: REPO_ROOT,
          stdio: "inherit",
        });
        if (proc.status !== 0) throw new HarnessError("BUILD_FAILED", target);
      }
    }

    const server = await serverMod.startServer({
      workspace,
      repoRoot: REPO_ROOT,
      provider: { origin: cfg.provider },
      models: {
        chatModel: cfg.chatModel,
        embedModel: cfg.embedModel,
        embedDim: cfg.embedDim,
      },
    });
    const browser = await browserMod.launchBrowser({
      workspace,
      repoRoot: REPO_ROOT,
    });
    const artifactsDir = path.join(workspace.artifactsDir, "live");
    fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

    /* -- finance scope ------------------------------------------------------ */
    const sampleDir = path.join(workspace.inputsDir, "sample");
    const generator = spawnSync(
      "pnpm",
      [
        "--filter",
        "borealis-server",
        "exec",
        "tsx",
        "../data/generate_sample.ts",
      ],
      {
        cwd: path.join(REPO_ROOT, "server"),
        env: { ...process.env, E2E_SAMPLE_DIR: sampleDir },
        stdio: "inherit",
      },
    );
    if (generator.status !== 0)
      throw new HarnessError("SAMPLE_GENERATION_FAILED");

    const session = await browser.newSession({ origin: server.origin });
    await session.register({
      email: "live-e2e@borealis.test",
      password: "borealis-e2e-live-pass-1",
    });

    await check("finance-upload-ingest", async () => {
      const fileInput = () =>
        session.page.locator('input[aria-label="Upload a source file"]');
      const picker = () =>
        session.page.locator('button[aria-label^="Chat sources:"]');
      await session.page.goto(`${server.origin}/#/chat`);
      await picker().waitFor({ timeout: 30_000 });
      await picker().click();
      const names = [
        "transactions.csv",
        "accounts.csv",
        "budget.csv",
        "networth.csv",
      ];
      for (const name of names) {
        await fileInput().setInputFiles(path.join(sampleDir, name));
      }
      const ready = await pollUntil(
        async () => {
          const res = await session.apiFetch("/api/sources", {
            expectStatus: 200,
          });
          const items = res.body?.items ?? [];
          return items.length === 4 &&
            items.every((item) => item.status === "ready")
            ? items
            : null;
        },
        {
          deadlineMs: 600_000,
          intervalMs: 1000,
          label: "finance sources ready (live embeddings)",
        },
      );
      return { sources: ready.length };
    });

    await check("live-chat-tool-turn", async () => {
      await session.page
        .getByLabel("Ask Borealis about your data")
        .fill(
          "Use a SQL query on the transactions table to break down my 2025 activity by month and category.",
        );
      await session.page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      // The assistant message is persisted only with a successful run
      // completion (runStore), so its presence with receipts proves the real
      // model completed a tool round end to end.
      const outcome = await pollUntil(
        async () => {
          const chats = await session.apiFetch("/api/chats", {
            expectStatus: 200,
          });
          const chat = (chats.body?.items ?? [])[0];
          if (!chat) return null;
          const history = await session.apiFetch(
            `/api/chats/${chat.id}?limit=100`,
            { expectStatus: 200 },
          );
          const messages =
            history.body?.messages ??
            history.body?.history?.items ??
            history.body?.items ??
            [];
          const assistant = messages
            .filter((message) => message.role === "assistant")
            .pop();
          return assistant
            ? { chat_id: chat.id, meta: assistant.meta ?? {} }
            : null;
        },
        {
          deadlineMs: 900_000,
          intervalMs: 2000,
          label: "live chat assistant message",
        },
      );
      const receipts = outcome.meta.query_results ?? [];
      assert(
        Array.isArray(receipts) && receipts.length >= 1,
        "LIVE_RUN_NO_QUERY_RECEIPT",
      );
      return { query_receipts: receipts.length };
    });

    const SELECT_MONTH =
      "SELECT LEFT(CAST(date AS VARCHAR), 7) AS month, category, COUNT(*) AS tx_count, " +
      "ROUND(SUM(amount), 2) AS net_amount, '=' || LEFT(CAST(date AS VARCHAR), 7) || '|Borealis-E2E' AS formula_probe " +
      "FROM transactions WHERE LEFT(CAST(date AS VARCHAR), 7) = ? GROUP BY 1, 2 ORDER BY 1, 2";

    const analysis = await check(
      "finance-analysis-parameterized-rerun",
      async () => {
        const sources = (
          await session.apiFetch("/api/sources", { expectStatus: 200 })
        ).body.items;
        const created = await session.apiFetch("/api/analyses", {
          method: "POST",
          expectStatus: 201,
          body: {
            title: "Monthly category totals (LIVE)",
            description:
              "Live-model environment; numbers are computed by DuckDB, not the model.",
            sql: SELECT_MONTH,
            parameters: [
              {
                name: "month",
                type: "string",
                required: true,
                nullable: false,
                default: "2025-06",
              },
            ],
            source_ids: sources.map((item) => item.id).sort(),
            comparison_key: ["month", "category"],
          },
        });
        const id = created.body?.id;
        assert(typeof id === "string", "ANALYSIS_CREATE_SHAPE");
        const run = await session.apiFetch(`/api/analyses/${id}/runs`, {
          method: "POST",
          expectStatus: 202,
          body: {
            values: { month: "2025-06" },
            operation_id: crypto.randomUUID(),
            expected_revision: 1,
          },
        });
        const runId = run.body?.run?.id;
        await pollUntil(
          async () => {
            const detail = await session.apiFetch(
              `/api/analyses/${id}/runs/${runId}`,
              { expectStatus: 200 },
            );
            return detail.body?.status === "succeeded" ||
              detail.body?.status === "failed"
              ? detail.body
              : null;
          },
          {
            deadlineMs: 300_000,
            intervalMs: 1000,
            label: "analysis run terminal",
          },
        );
        const results = await session.apiFetch(`/api/analyses/${id}/results`, {
          expectStatus: 200,
        });
        const summary = (results.body?.items ?? [])[0];
        assert(summary && typeof summary.id === "string", "NO_RESULT");
        const result = (
          await session.apiFetch(`/api/analyses/${id}/results/${summary.id}`, {
            expectStatus: 200,
          })
        ).body;
        assert(Array.isArray(result?.rows), "RESULT_ROWS_SHAPE");
        const transactionsText = fs.readFileSync(
          path.join(sampleDir, "transactions.csv"),
          "utf8",
        );
        const expected = financeExpected.expectedAnalysisRows(
          transactionsText,
          "2025-06",
        );
        assert(expected.length > 0, "EXPECTED_ROWS_EMPTY");
        assert(
          result.rows.length === expected.length,
          "RESULT_ROWS_COUNT",
          `${result.rows.length} vs ${expected.length}`,
        );
        for (let index = 0; index < expected.length; index += 1) {
          const want = expected[index];
          const got = result.rows[index];
          assert(
            got[0] === want[0] && got[1] === want[1],
            "RESULT_KEY",
            String(index),
          );
          assert(Number(got[2]) === want[2], "RESULT_COUNT", String(index));
          assert(
            Math.abs(Number(got[3]) - want[3]) < 0.005,
            "RESULT_NET",
            String(index),
          );
        }
        assert(
          result.rows.some((row) =>
            String(
              row.find((cell) => String(cell).startsWith("'=")) ?? "",
            ).includes("Borealis-E2E"),
          ),
          "FORMULA_GUARD",
        );
        return {
          rows: result.rows.length,
          checked: expected.length,
          analysis_id: id,
          result_id: summary.id,
        };
      },
    );

    await check("finance-exports", async () => {
      const csv = await session.apiFetchText(
        `/api/analyses/${analysis.analysis_id}/results/${analysis.result_id}/export?format=csv`,
        { expectStatus: 200 },
      );
      const bytes = Buffer.from(csv.body);
      assert(bytes.subarray(0, 3).toString("hex") === "efbbbf", "CSV_BOM");
      assert(csv.body.includes("'="), "CSV_FORMULA_GUARD");
      const manifest = await session.apiFetch(
        `/api/analyses/${analysis.analysis_id}/results/${analysis.result_id}/export?format=manifest`,
        { expectStatus: 200 },
      );
      assert(
        manifest.body?.analysis_id === analysis.analysis_id,
        "MANIFEST_IDENTITY",
      );
      return { csv_bytes: bytes.length };
    });

    /* -- research scope (documents, live embeddings + live model) ---------- */
    const corpusDir = path.join(REPO_ROOT, "data", "e2e", "supplier-corpus");
    const researchDocs = [
      "01_acme_logistics_agreement.md",
      "02_acme_renewal_quote.md",
      "04_blueriver_change_order.md",
    ];

    await check("research-import-and-run", async () => {
      const sourceIds = [];
      for (const name of researchDocs) {
        const res = await uploadFile(session, path.join(corpusDir, name), name);
        assert(
          res.status === 201,
          "RESEARCH_UPLOAD_STATUS",
          `${name} → ${res.status}`,
        );
        sourceIds.push(res.body?.id);
      }
      assert(sourceIds.every(Boolean), "RESEARCH_IMPORT_SHAPE");
      await pollUntil(
        async () => {
          const res = await session.apiFetch("/api/sources", {
            expectStatus: 200,
          });
          const wanted = (res.body?.items ?? []).filter((item) =>
            researchDocs.some((n) => item.display_name === n),
          );
          return wanted.length === researchDocs.length &&
            wanted.every((item) => item.status === "ready")
            ? wanted
            : null;
        },
        { deadlineMs: 600_000, intervalMs: 1000, label: "research docs ready" },
      );

      const col = (label, type, extra = {}) => ({
        id: crypto.randomUUID(),
        label,
        question: `${label}?`,
        type,
        unit: null,
        choices: null,
        ...extra,
      });
      const created = await session.apiFetch("/api/research", {
        method: "POST",
        expectStatus: 201,
        body: {
          title: "Supplier terms dossier (LIVE)",
          question:
            "Compare renewal pricing, effective dates, renewal handling, tier, and exception clauses across the supplier documents.",
          output_kind: "comparison",
          chat_model: cfg.chatModel,
          source_ids: sourceIds,
          columns: [
            col("Price", "number", {
              unit: "USD",
              question: "What is the quoted price in USD?",
            }),
            col("Effective date", "date", {
              question: "What is the effective date?",
            }),
            col("Auto-renewal", "boolean", { question: "Does it auto-renew?" }),
            col("Tier", "enum", {
              choices: ["Basic", "Pro", "Enterprise"],
              question: "Which service tier?",
            }),
            col("Exceptions", "text", {
              question: "Which exception clauses are present?",
            }),
          ],
        },
      });
      const defId = created.body?.id ?? created.body?.definition?.id;
      assert(typeof defId === "string", "RESEARCH_DEF_SHAPE");

      const proposal = await session.apiFetch(`/api/research/${defId}/plan`, {
        method: "POST",
        expectStatus: 200,
        body: { expected_revision: created.body?.current_revision ?? 1 },
      });
      const plan = proposal.body?.plan;
      const steps = Array.isArray(plan?.steps) ? plan.steps : [];
      assert(
        steps.length >= 1 && steps.length <= 8,
        "PLAN_STEPS",
        String(steps.length),
      );
      assert(
        steps.every(
          (step) =>
            typeof step.objective === "string" && step.objective.length > 0,
        ),
        "PLAN_SHAPE",
      );

      await session.apiFetch(`/api/research/${defId}`, {
        method: "PATCH",
        expectStatus: 200,
        body: { expected_revision: 1, plan: { steps } },
      });
      const started = await session.apiFetch(`/api/research/${defId}/runs`, {
        method: "POST",
        expectStatus: 202,
        body: {},
      });
      const runId = started.body?.run?.id ?? started.body?.run_id;
      assert(typeof runId === "string", "RESEARCH_RUN_SHAPE");
      const detail = await pollUntil(
        async () => {
          const res = await session.apiFetch(`/api/research-runs/${runId}`, {
            expectStatus: 200,
          });
          const status = res.body?.status;
          return status === "completed" ||
            status === "needs_review" ||
            status === "failed" ||
            status === "cancelled"
            ? res.body
            : null;
        },
        {
          deadlineMs: 1_800_000,
          intervalMs: 3000,
          label: "research run terminal",
        },
      );
      assert(
        detail.status === "completed" || detail.status === "needs_review",
        "RESEARCH_RUN_FAILED",
        detail.status,
      );
      const evidence = await session.apiFetch(
        `/api/research-runs/${runId}/evidence?limit=50`,
        { expectStatus: 200 },
      );
      const items = evidence.body?.items ?? [];
      assert(items.length > 0, "RESEARCH_NO_EVIDENCE");
      const table = await session.apiFetch(
        `/api/research-runs/${runId}/table?limit=100`,
        { expectStatus: 200 },
      );
      const rows = table.body?.items ?? [];
      assert(
        rows.length === researchDocs.length,
        "RESEARCH_TABLE_ROWS",
        String(rows.length),
      );
      const serialized = JSON.stringify(items) + JSON.stringify(rows);
      assert(!serialized.includes("4600"), "HIDDEN_FACT_LEAKED");
      return {
        evidence: items.length,
        rows: rows.length,
        status: detail.status,
      };
    });

    await session.close?.();
    await browser.close();
    await server.close();
  } catch (error) {
    failure = String(error && error.code ? error.code : error).slice(0, 160);
  } finally {
    const summary = {
      entry: "run-product-live",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      chat_model: cfg.chatModel,
      embed_model: cfg.embedModel,
      embed_dim: cfg.embedDim,
      checks,
      passed:
        !failure &&
        !blocked &&
        checks.length > 0 &&
        checks.every((entry) => entry.status === "pass"),
      ...(failure ? { failure } : {}),
      ...(blocked ? { blocked } : {}),
    };
    try {
      writeText(
        path.join(workspace.root, "summary.json"),
        JSON.stringify(summary, null, 2),
      );
    } catch {
      /* the summary line already carries the result */
    }
    const cleanup = workspace.cleanup({
      keep: Boolean((failure || blocked) && cfg.keepOnFailure),
    });
    summary.cleanup = {
      workspace_removed: cleanup.removed,
      kept_path: cleanup.keptPath,
      lock_released: cleanup.proofs?.lock_released ?? true,
      pids_gone: cleanup.proofs?.pids_gone ?? true,
      problems: cleanup.problems,
    };
    emit(summary);
    if (blocked) process.exitCode = 3;
    else if (failure || !summary.passed) process.exitCode = 1;
  }
}

await main();
