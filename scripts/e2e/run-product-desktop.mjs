#!/usr/bin/env node
/**
 * Packaged-desktop acceptance entry point SKELETON (`pnpm
 * test:e2e:product:desktop`).
 *
 * This stage proves only the packaged-app lifecycle inside an isolated
 * profile: locate the unsigned arm64 build, launch with an absolute
 * `--user-data-dir` under the disposable run tree, prove single-instance
 * behavior, and prove an orderly SIGTERM quit with the profile lock released.
 * The A–F desktop journeys arrive with their features and are reported as
 * explicit NOT-IMPLEMENTED results, never as skips.
 *
 * Exit codes:
 *   0 — lifecycle proof passed (only when no A–F journey was demanded)
 *   1 — a proof failed or an A–F journey was demanded (stubs fail loudly)
 *   2 — usage/setup error before any process launched
 *   3 — BLOCKED: no packaged app exists (build `pnpm package:unsigned`);
 *       a missing app is never a silent pass
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, parseArgs } from "./harness/util.mjs";
import { createIsolatedWorkspace } from "./harness/workspace.mjs";
import { runDesktopLifecycle } from "./harness/desktop.mjs";

const ENTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ENTRY_DIR, "..", "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requested = typeof args.journey === "string" ? args.journey.toUpperCase() : "LIFECYCLE";
  const demandsRequiredJourney = ["A", "B", "C", "D", "E", "F", "ALL"].includes(requested);

  const workspace = createIsolatedWorkspace({
    repoRoot: REPO_ROOT,
    workspaceOverride: typeof args.workspace === "string" ? args.workspace : undefined,
    runId: "desktop",
  });

  const summary = { entry: "run-product-desktop", started_at: new Date().toISOString(), journeys: [] };
  let exitCode = 0;
  try {
    const lifecycle = await runDesktopLifecycle({ workspace, repoRoot: REPO_ROOT });
    summary.lifecycle = {
      status: lifecycle.status,
      ...(lifecycle.checks ? { checks: lifecycle.checks } : {}),
      ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
    };
    if (demandsRequiredJourney) {
      summary.journeys.push({
        journey: requested,
        status: "not_implemented",
        failure: "JOURNEY_NOT_IMPLEMENTED:DESKTOP",
      });
    }
    if (lifecycle.status === "blocked") {
      exitCode = 3;
      process.stderr.write(
        `E2E_DESKTOP_BLOCKED packaged app missing at ${lifecycle.expected_path} — run pnpm package:unsigned; never treated as a pass\n`
      );
    } else if (lifecycle.status === "pass" && !demandsRequiredJourney) {
      exitCode = 0;
    } else {
      exitCode = 1;
    }
  } catch (error) {
    summary.lifecycle = { status: "fail", failure: error instanceof HarnessError ? error.code : "DESKTOP_ERROR" };
    process.stderr.write(`E2E_DESKTOP_FAILURE ${summary.lifecycle.failure}\n`);
    exitCode = 1;
  } finally {
    const keep = args["keep-on-failure"] === true && exitCode !== 0;
    const cleanup = await workspace.cleanup({ keep });
    summary.cleanup = {
      workspace_removed: cleanup.removed,
      kept_path: cleanup.kept ? workspace.root : null,
      pids_gone: cleanup.pidsGone,
      problems: cleanup.problems,
    };
    if (cleanup.problems.length > 0) {
      process.stderr.write(`E2E_CLEANUP_PROBLEMS ${cleanup.problems.join(",")}\n`);
      if (exitCode === 0) exitCode = 1;
    }
    summary.finished_at = new Date().toISOString();
    process.stdout.write(`E2E_SUMMARY ${JSON.stringify(summary)}\n`);
  }
  return exitCode;
}

process.exitCode = await main().catch((error) => {
  const code = error instanceof HarnessError ? error.code : "UNEXPECTED_ENTRY_ERROR";
  process.stderr.write(`E2E_FATAL ${code}\n`);
  return 2;
});
