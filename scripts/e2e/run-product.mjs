#!/usr/bin/env node
/**
 * Product-acceptance entry point (`pnpm test:e2e:product`).
 *
 * Builds the actual production web/backend (unless `--skip-build` assumes
 * prebuilt output), boots the real server against the scripted provider
 * fixture inside an isolated disposable workspace, drives the browser, and
 * runs the selected journeys sequentially.
 *
 * Flags:
 *   --journey=A|B|C|D|E|F|smoke|all   (comma-separated ids allowed; `all`
 *                                      means exactly the six required A–F)
 *   --skip-build                      assume server/web dist outputs exist
 *   --workspace=DIR                   adopt an explicit empty absolute run
 *                                      root instead of a fresh temp dir
 *   --keep-on-failure                 keep the run tree and print its path
 *   --evidence-dir=ABS_NEW_DIR         retain synthetic artifacts and summary only
 *   --inject-failure                  smoke-only self-test tripwire
 *
 * Output contract: one content-free JSON summary line on stdout
 * (journey ids, pass/fail, durations, artifact filenames) plus
 * `summary.json` in the run directory. Exit `0` only when every selected
 * journey passed; `1` on any failure (NOT-IMPLEMENTED stubs fail loudly);
 * `2` on usage/build/workspace errors before any journey ran.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, assert, parseArgs, writeText } from "./harness/util.mjs";
import { createIsolatedWorkspace } from "./harness/workspace.mjs";
import { startServer } from "./harness/server.mjs";
import { launchProvider } from "./harness/providers.mjs";
import { launchBrowser } from "./harness/browser.mjs";
import { loadJourney, resolveJourneyIds } from "./journeys/registry.mjs";
import { createEvidenceOutput } from "./harness/evidence.mjs";

const ENTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ENTRY_DIR, "..", "..");

function buildProduction() {
  for (const target of ["borealis-server", "borealis-web"]) {
    const proc = spawnSync("pnpm", ["--filter", target, "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env },
    });
    if (proc.status !== 0) {
      throw new HarnessError("BUILD_FAILED", target);
    }
  }
}

function emitSummary(summary) {
  process.stdout.write(`E2E_SUMMARY ${JSON.stringify(summary)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceOutput = createEvidenceOutput(args["evidence-dir"]);
  const journeyIds = resolveJourneyIds(args.journey);
  const skipBuild = args["skip-build"] === true;
  const keepOnFailure = args["keep-on-failure"] === true;
  const injectFailure = args["inject-failure"] === true;

  if (skipBuild) {
    for (const f of ["server/dist/index.js", "web/dist/index.html"]) {
      if (!fs.existsSync(path.join(REPO_ROOT, f))) {
        throw new HarnessError(
          "PREBUILT_MISSING",
          `${f} not found — omit --skip-build to build it`,
        );
      }
    }
  } else {
    buildProduction();
  }

  const workspace = createIsolatedWorkspace({
    repoRoot: REPO_ROOT,
    workspaceOverride:
      typeof args.workspace === "string" ? args.workspace : undefined,
    runId: "product",
  });

  const summary = {
    entry: "run-product",
    journeys: [],
    passed: false,
    started_at: new Date().toISOString(),
  };
  let exitCode = 0;

  let provider;
  let server;
  let browser;
  try {
    provider = await launchProvider({ workspace });
    workspace.onCleanup(() => provider.stop());
    server = await startServer({
      workspace,
      repoRoot: REPO_ROOT,
      provider,
      models: {
        chatModel: provider.models.chatModel,
        embedModel: provider.models.embedModel,
        embedDim: provider.models.embedDim,
      },
    });
    workspace.onCleanup(() => server.stop());
    await server.waitBaseline();
    browser = await launchBrowser({ workspace, repoRoot: REPO_ROOT });
    workspace.onCleanup(() => browser.close());

    for (const id of journeyIds) {
      const journey = await loadJourney(id);
      const started = Date.now();
      const artifactsDir = workspace.journeyArtifacts(id);
      const ctx = {
        journeyId: id,
        repoRoot: REPO_ROOT,
        workspace,
        server,
        provider,
        browser,
        fixtures: { "openai-provider": provider },
        artifactsDir,
        injectFailure: injectFailure && id === "smoke",
      };
      let result;
      try {
        const outcome = await journey.run(ctx);
        if (outcome?.checks) {
          await writeText(
            path.join(artifactsDir, "checks.json"),
            `${JSON.stringify(outcome.checks, null, 2)}\n`,
          );
        }
        if (outcome?.checks?.skipped?.length) {
          throw new HarnessError("REQUIRED_JOURNEY_CHECKS_SKIPPED");
        }
        result = {
          journey: id,
          status: "pass",
          duration_ms: Date.now() - started,
          artifacts: [
            ...(outcome?.artifacts ?? []),
            ...(outcome?.checks ? ["checks.json"] : []),
          ],
        };
      } catch (error) {
        const code =
          error instanceof HarnessError ? error.code : "JOURNEY_ERROR";
        result = {
          journey: id,
          status: code.startsWith("JOURNEY_NOT_IMPLEMENTED")
            ? "not_implemented"
            : "fail",
          duration_ms: Date.now() - started,
          failure: code,
          artifacts: fs.existsSync(artifactsDir)
            ? fs.readdirSync(artifactsDir).sort()
            : [],
        };
      }
      summary.journeys.push(result);
      process.stdout.write(`journey ${id}: ${result.status}\n`);
    }
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "ENTRY_ERROR";
    summary.setup_failure = code;
    process.stderr.write(`E2E_SETUP_FAILURE ${code}\n`);
  } finally {
    // Persist a pre-cleanup summary while the run tree still exists (the
    // tree is removed during cleanup unless --keep-on-failure).
    try {
      await writeText(
        workspace.summaryFile,
        `${JSON.stringify({ ...summary, phase: "pre-cleanup" }, null, 2)}\n`,
      );
    } catch {
      // The tree may already be unusable; stdout remains the record.
    }
    try {
      evidenceOutput?.capture(workspace.artifactsDir);
    } catch {
      summary.setup_failure = "EVIDENCE_CAPTURE_FAILED";
    }
    const anyFailure =
      summary.setup_failure !== undefined ||
      summary.journeys.some((j) => j.status !== "pass");
    const cleanup = await workspace.cleanup({
      keep: keepOnFailure && anyFailure,
    });
    summary.cleanup = {
      workspace_removed: cleanup.removed,
      kept_path: cleanup.kept ? workspace.root : null,
      lock_released: cleanup.lockReleased,
      pids_gone: cleanup.pidsGone,
      problems: cleanup.problems,
    };
    if (cleanup.problems.length > 0) {
      process.stderr.write(
        `E2E_CLEANUP_PROBLEMS ${cleanup.problems.join(",")}\n`,
      );
    }
    summary.finished_at = new Date().toISOString();
    summary.passed =
      summary.setup_failure === undefined &&
      summary.journeys.length > 0 &&
      summary.journeys.every((j) => j.status === "pass") &&
      cleanup.problems.length === 0;
    if (cleanup.kept) {
      try {
        await writeText(
          workspace.summaryFile,
          `${JSON.stringify(summary, null, 2)}\n`,
        );
      } catch {
        // keep-on-failure tree stays usable regardless
      }
    }
    evidenceOutput?.finish(summary);
    emitSummary(summary);
    exitCode = summary.passed ? 0 : summary.setup_failure !== undefined ? 2 : 1;
  }
  return exitCode;
}

process.exitCode = await main().catch((error) => {
  const code =
    error instanceof HarnessError ? error.code : "UNEXPECTED_ENTRY_ERROR";
  process.stderr.write(`E2E_FATAL ${code}\n`);
  return 2;
});
