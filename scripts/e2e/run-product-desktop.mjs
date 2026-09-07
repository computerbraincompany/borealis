#!/usr/bin/env node
/**
 * Packaged-desktop acceptance entry point (`pnpm test:e2e:product:desktop`).
 *
 * Default (no `--journey`): the packaged-app lifecycle proof inside an
 * isolated profile — locate the unsigned arm64 build, launch with an
 * absolute `--user-data-dir` under the disposable run tree, prove
 * single-instance behavior, and prove an orderly quit via the packaged
 * shutdown smoke.
 *
 * `--journey=B` runs the saved-finance-analyses journey against the REAL
 * packaged app instead of the harness-launched server. The app is launched
 * with an absolute `--user-data-dir` inside the isolated run tree, every
 * stdout line is drained into the run log (an undrained pipe backpressures
 * the app), the loopback origin comes from the app's own
 * `Borealis server listening` line (or its textual `Server listening at
 * http://127.0.0.1:<port>` form), journey accounts register through the
 * PUBLIC `/api/register` route, and the harness-launched scripted
 * OpenAI-compatible provider is wired through the app's authenticated
 * `PATCH /api/settings` (loopback provider, so the remote-egress gate never
 * applies; the default embedding identity is never sent because Settings
 * must reject any embedding-identity change — the fixture answers as the
 * app's default physical embed model id and dimension instead). The B
 * restart step terminates the owned app pid (SIGTERM with bounded SIGKILL
 * escalation, disclosed), relaunches on the SAME profile with a new
 * OS-assigned port, and proves the durable `jwt.secret` (a pre-restart JWT
 * authenticates on the new process) before the UI session is
 * re-established through the real login form.
 *
 * `--app=PATH` points the locator at an explicit unsigned `Borealis.app`
 * bundle (absolute path) instead of this checkout's
 * `desktop/release/mac-arm64/Borealis.app`.
 *
 * Journeys A, C, D, E, F (and therefore `all`) remain explicit
 * NOT-IMPLEMENTED results — they fail loudly, never as skips. A journey
 * demand replaces the lifecycle proof (the lifecycle default run is its own
 * gate and the journey mode drives the app itself).
 *
 * Exit codes:
 *   0 — the default lifecycle proof passed, or every demanded journey
 *       passed (today that means exactly `--journey=B`)
 *   1 — a proof or journey failed, or a not-implemented journey was demanded
 *   2 — usage/setup error before any process launched
 *   3 — BLOCKED: no packaged app exists (build `pnpm package:unsigned`);
 *       a missing app is never a silent pass
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, assert, parseArgs } from "./harness/util.mjs";
import { createIsolatedWorkspace } from "./harness/workspace.mjs";
import { runDesktopLifecycle, locatePackagedApp } from "./harness/desktop.mjs";
import { launchProvider } from "./harness/providers.mjs";
import { launchBrowser } from "./harness/browser.mjs";
import {
  launchPackagedApp,
  createPackagedAppTarget,
  DESKTOP_DEFAULT_CHAT_MODEL,
  DESKTOP_DEFAULT_EMBED_MODEL,
  DESKTOP_DEFAULT_EMBED_DIM,
} from "./harness/desktopApp.mjs";
import { loadJourney } from "./journeys/registry.mjs";

const ENTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ENTRY_DIR, "..", "..");

/** A process-wide Settings write is needed before any journey account acts. */
const SETTINGS_SETUP_ACCOUNT = Object.freeze({
  email: "e2e-desktop-settings-setup@borealis.test",
  password: "borealis-e2e-desktop-settings-setup-pass",
});

const REAL_DESKTOP_JOURNEYS = new Set(["B"]);

function resolveDesktopJourneyIds(value) {
  const tokens = String(value)
    .split(",")
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
  assert(tokens.length > 0, "ARG_JOURNEY_MISSING", "pass --journey=A|B|C|D|E|F|all");
  if (tokens.length === 1 && tokens[0] === "ALL") return ["A", "B", "C", "D", "E", "F"];
  const ids = [];
  for (const token of tokens) {
    assert(/^[A-F]$/.test(token), "ARG_JOURNEY_UNKNOWN", token);
    if (!ids.includes(token)) ids.push(token);
  }
  return ids;
}

/** `--app=PATH` (explicit bundle) or the documented electron-builder path. */
function resolveApp(appArg) {
  if (appArg !== undefined) {
    assert(typeof appArg === "string" && path.isAbsolute(appArg), "ARG_APP_ABSOLUTE", String(appArg));
    const appDir = path.resolve(appArg);
    let stat = null;
    try {
      stat = fs.statSync(appDir);
    } catch {
      stat = null;
    }
    assert(stat?.isDirectory(), "PACKAGED_APP_MISSING", appDir);
    const binary = path.join(appDir, "Contents", "MacOS", "Borealis");
    assert(fs.existsSync(binary), "PACKAGED_APP_BINARY_MISSING", binary);
    return { appDir, binary };
  }
  return locatePackagedApp(REPO_ROOT);
}

async function runJourneys({ args, ids, workspace, summary, extraProblems }) {
  const app = resolveApp(args.app);
  if (!app) {
    summary.journeys.push(
      ...ids.map((id) => ({ journey: id, status: "blocked", failure: "PACKAGED_APP_MISSING" }))
    );
    process.stderr.write(
      `E2E_DESKTOP_BLOCKED packaged app missing at ${path.join(
        REPO_ROOT,
        "desktop",
        "release",
        "mac-arm64",
        "Borealis.app"
      )} — run pnpm package:unsigned (or pass --app); never treated as a pass\n`
    );
    return 3;
  }

  for (const id of ids) {
    if (!REAL_DESKTOP_JOURNEYS.has(id)) {
      summary.journeys.push({ journey: id, status: "not_implemented", failure: "JOURNEY_NOT_IMPLEMENTED:DESKTOP" });
      process.stdout.write(`journey ${id}: not_implemented\n`);
    }
  }

  if (!ids.some((id) => REAL_DESKTOP_JOURNEYS.has(id))) {
    return 1;
  }

  const provider = await launchProvider({
    workspace,
    chatModel: DESKTOP_DEFAULT_CHAT_MODEL,
    embedModel: DESKTOP_DEFAULT_EMBED_MODEL,
    embedDim: DESKTOP_DEFAULT_EMBED_DIM,
  });
  workspace.onCleanup(() => provider.stop());

  const appHandle = await launchPackagedApp({ workspace, app });
  workspace.onCleanup(async () => {
    const stop = await appHandle.stop();
    extraProblems.push(...(stop?.problems ?? []));
  });

  // The app's provider must point at the scripted fixture before any
  // journey ingestion or chat turn. Settings are process-wide, so one
  // authenticated setup account configures the surface for every account.
  const setupSession = await appHandle.register(SETTINGS_SETUP_ACCOUNT);
  await appHandle.configureProvider({
    token: setupSession.token,
    providerOrigin: provider.origin,
    chatModel: DESKTOP_DEFAULT_CHAT_MODEL,
  });

  const browser = await launchBrowser({ workspace, repoRoot: REPO_ROOT });
  workspace.onCleanup(() => browser.close());

  const target = createPackagedAppTarget({ app: appHandle });

  for (const id of ids) {
    if (!REAL_DESKTOP_JOURNEYS.has(id)) continue;
    const journey = await loadJourney(id);
    const started = Date.now();
    const artifactsDir = workspace.journeyArtifacts(id);
    const ctx = {
      journeyId: id,
      repoRoot: REPO_ROOT,
      workspace,
      provider,
      browser,
      target,
      fixtures: { "openai-provider": provider },
      artifactsDir,
    };
    let result;
    try {
      const outcome = await journey.run(ctx);
      result = {
        journey: id,
        status: "pass",
        duration_ms: Date.now() - started,
        artifacts: [...(outcome?.artifacts ?? [])],
      };
    } catch (error) {
      const code = error instanceof HarnessError ? error.code : "JOURNEY_ERROR";
      result = {
        journey: id,
        status: code.startsWith("JOURNEY_NOT_IMPLEMENTED") ? "not_implemented" : "fail",
        duration_ms: Date.now() - started,
        failure: code,
        artifacts: fs.existsSync(artifactsDir) ? fs.readdirSync(artifactsDir).sort() : [],
      };
    }
    result.restart_disclosures = appHandle.disclosures.restarts;
    summary.journeys.push(result);
    process.stdout.write(`journey ${id}: ${result.status}\n`);
  }

  return summary.journeys.every((j) => j.status === "pass") ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const journeyIds = typeof args.journey === "string" ? resolveDesktopJourneyIds(args.journey) : null;

  const workspace = createIsolatedWorkspace({
    repoRoot: REPO_ROOT,
    workspaceOverride: typeof args.workspace === "string" ? args.workspace : undefined,
    runId: journeyIds === null ? "desktop" : `desktop-journey-${journeyIds.join("")}`,
  });

  const summary = { entry: "run-product-desktop", started_at: new Date().toISOString(), journeys: [] };
  const extraProblems = [];
  let exitCode = 0;
  try {
    if (journeyIds === null) {
      const lifecycle = await runDesktopLifecycle({ workspace, repoRoot: REPO_ROOT });
      summary.lifecycle = {
        status: lifecycle.status,
        ...(lifecycle.checks ? { checks: lifecycle.checks } : {}),
        ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
      };
      if (lifecycle.status === "blocked") {
        exitCode = 3;
        process.stderr.write(
          `E2E_DESKTOP_BLOCKED packaged app missing at ${lifecycle.expected_path} — run pnpm package:unsigned; never treated as a pass\n`
        );
      } else if (lifecycle.status === "pass") {
        exitCode = 0;
      } else {
        exitCode = 1;
      }
    } else {
      exitCode = await runJourneys({ args, ids: journeyIds, workspace, summary, extraProblems });
    }
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "DESKTOP_ERROR";
    summary.failure = code;
    process.stderr.write(`E2E_DESKTOP_FAILURE ${code}\n`);
    exitCode = 1;
  } finally {
    const keep = args["keep-on-failure"] === true && exitCode !== 0;
    const cleanup = await workspace.cleanup({ keep });
    const problems = [...cleanup.problems, ...extraProblems];
    summary.cleanup = {
      workspace_removed: cleanup.removed,
      kept_path: cleanup.kept ? workspace.root : null,
      pids_gone: cleanup.pidsGone,
      problems,
    };
    if (problems.length > 0) {
      process.stderr.write(`E2E_CLEANUP_PROBLEMS ${problems.join(",")}\n`);
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
