#!/usr/bin/env node
/**
 * Packaged acceptance uses the hardened app's native renderer via an external
 * normal-UI driver (for example CUA). `--native-driver=external` starts a
 * private, per-run checkpoint bridge; see nativeDesktop.mjs and HARNESS.md.
 * Missing driver is BLOCKED (exit 3), never an automatic native pass.
 *
 * No --journey retains the separate lifecycle smoke. The legacy
 * --surface=browser --journey=B is explicitly browser-on-packaged-backend
 * compatibility coverage, not native UI acceptance.
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
import { runNativeJourneys } from "./harness/nativeDesktop.mjs";
import { createEvidenceOutput } from "./harness/evidence.mjs";

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
  assert(
    tokens.length > 0,
    "ARG_JOURNEY_MISSING",
    "pass --journey=A|B|C|D|E|F|all",
  );
  if (tokens.length === 1 && tokens[0] === "ALL")
    return ["A", "B", "C", "D", "E", "F"];
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
    assert(
      typeof appArg === "string" && path.isAbsolute(appArg),
      "ARG_APP_ABSOLUTE",
      String(appArg),
    );
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
      ...ids.map((id) => ({
        journey: id,
        status: "blocked",
        failure: "PACKAGED_APP_MISSING",
      })),
    );
    process.stderr.write(
      `E2E_DESKTOP_BLOCKED packaged app missing at ${path.join(
        REPO_ROOT,
        "desktop",
        "release",
        "mac-arm64",
        "Borealis.app",
      )} — run pnpm package:unsigned (or pass --app); never treated as a pass\n`,
    );
    return 3;
  }

  const native = args.surface !== "browser";
  assert(
    args.surface === undefined ||
      args.surface === "native" ||
      args.surface === "browser",
    "ARG_DESKTOP_SURFACE_INVALID",
  );
  if (native && args["native-driver"] !== "external") {
    summary.journeys.push(
      ...ids.map((id) => ({
        journey: id,
        status: "blocked",
        surface: "packaged-native-ui",
        failure: "NATIVE_DRIVER_REQUIRED",
      })),
    );
    process.stderr.write(
      "E2E_DESKTOP_BLOCKED native UI driver required: pass --native-driver=external and drive each private checkpoint with normal OS UI automation. Browser coverage cannot satisfy this gate.\n",
    );
    return 3;
  }

  if (!native)
    for (const id of ids) {
      if (!REAL_DESKTOP_JOURNEYS.has(id)) {
        summary.journeys.push({
          journey: id,
          status: "not_implemented",
          failure: "JOURNEY_NOT_IMPLEMENTED:DESKTOP",
        });
        process.stdout.write(`journey ${id}: not_implemented\n`);
      }
    }

  if (!native && !ids.some((id) => REAL_DESKTOP_JOURNEYS.has(id))) {
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

  if (native) {
    const result = await runNativeJourneys({
      workspace,
      repoRoot: REPO_ROOT,
      app: appHandle,
      provider,
      ids,
      onJourney: (result) => summary.journeys.push(result),
      ...(args["driver-timeout-ms"] !== undefined
        ? { driverTimeoutMs: Number(args["driver-timeout-ms"]) }
        : {}),
    });

    summary.native = {
      checkpoints: result.checkpoints,
      profile_quit_verified: true,
      package_sha256: result.package_sha256,
    };
    return 0;
  }

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
        surface: "browser-on-packaged-backend",
        duration_ms: Date.now() - started,
        artifacts: [...(outcome?.artifacts ?? [])],
      };
    } catch (error) {
      const code = error instanceof HarnessError ? error.code : "JOURNEY_ERROR";
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
    result.restart_disclosures = appHandle.disclosures.restarts;
    summary.journeys.push(result);
    process.stdout.write(`journey ${id}: ${result.status}\n`);
  }

  return summary.journeys.every((j) => j.status === "pass") ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const journeyIds =
    typeof args.journey === "string"
      ? resolveDesktopJourneyIds(args.journey)
      : null;

  const evidence = createEvidenceOutput(args["evidence-dir"]);
  const workspace = createIsolatedWorkspace({
    repoRoot: REPO_ROOT,
    workspaceOverride:
      typeof args.workspace === "string" ? args.workspace : undefined,
    runId:
      journeyIds === null
        ? "desktop"
        : `desktop-journey-${journeyIds.join("")}`,
  });

  const summary = {
    entry: "run-product-desktop",
    started_at: new Date().toISOString(),
    journeys: [],
  };
  const extraProblems = [];
  let exitCode = 0;
  try {
    if (journeyIds === null) {
      const lifecycle = await runDesktopLifecycle({
        workspace,
        repoRoot: REPO_ROOT,
      });
      summary.lifecycle = {
        status: lifecycle.status,
        ...(lifecycle.checks ? { checks: lifecycle.checks } : {}),
        ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
      };
      if (lifecycle.status === "blocked") {
        exitCode = 3;
        process.stderr.write(
          `E2E_DESKTOP_BLOCKED packaged app missing at ${lifecycle.expected_path} — run pnpm package:unsigned; never treated as a pass\n`,
        );
      } else if (lifecycle.status === "pass") {
        exitCode = 0;
      } else {
        exitCode = 1;
      }
    } else {
      exitCode = await runJourneys({
        args,
        ids: journeyIds,
        workspace,
        summary,
        extraProblems,
      });
    }
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "DESKTOP_ERROR";
    summary.failure = code;
    if (journeyIds !== null) {
      for (const id of journeyIds) {
        if (!summary.journeys.some((journey) => journey.journey === id)) {
          summary.journeys.push({
            journey: id,
            status: "not_run",
            failure: code,
          });
        }
      }
    }
    process.stderr.write(`E2E_DESKTOP_FAILURE ${code}\n`);
    exitCode = 1;
  } finally {
    try {
      evidence?.capture(workspace.artifactsDir);
    } catch {
      extraProblems.push("EVIDENCE_CAPTURE_FAILED");
      exitCode = 1;
    }
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
    try {
      evidence?.finish(summary);
    } catch {
      process.stderr.write("E2E_EVIDENCE_FAILURE\n");
      exitCode = 1;
    }
    process.stdout.write(`E2E_SUMMARY ${JSON.stringify(summary)}\n`);
  }
  return exitCode;
}

process.exitCode = await main().catch((error) => {
  const code =
    error instanceof HarnessError ? error.code : "UNEXPECTED_ENTRY_ERROR";
  process.stderr.write(`E2E_FATAL ${code}\n`);
  return 2;
});
