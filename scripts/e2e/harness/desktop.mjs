/**
 * Packaged-desktop lifecycle SKELETON (stage 1).
 *
 * Locates the unsigned arm64 packaged application at the documented
 * convention (`desktop/release/mac-arm64/Borealis.app`, see
 * desktop/README.md), launches the real app executable with an absolute
 * `--user-data-dir` inside the isolated run tree, and proves single-instance
 * behavior (a second launch against the same profile must exit while the
 * first keeps running).
 *
 * The orderly-quit contract is proven by the packaged shutdown smoke
 * (`--borealis-packaged-shutdown-smoke`): the same packaged binary boots
 * fully, then a user-identical `app.quit()` drives the production
 * before-quit → DesktopApplication.shutdown() chain and the token is printed
 * only when the backend acknowledged an orderly stop before the bounded
 * escalation. A plain signal is NOT used to prove quit here: macOS packaged
 * Electron swallows SIGTERM/SIGINT during startup and otherwise dies by
 * signal disposition without running before-quit, and unattended Apple Event
 * or Accessibility quit requires Automation consent this gate cannot assume.
 *
 * A–F desktop journey coverage arrives with the features; if no packaged app
 * exists, the entry must surface BLOCKED (distinct exit code), never a fake
 * pass.
 */
import fs from "node:fs";
import path from "node:path";
import {
  HarnessError,
  assert,
  pidAlive,
  sleep,
  spawnOwned,
  stopOwned,
} from "./util.mjs";

const START_TIMEOUT_MS = 45_000;
const SMOKE_TIMEOUT_MS = 180_000;

/**
 * Consume the app's stdout into the run log. Without a reader the kernel pipe
 * fills (64 KiB), the app's pino writes block, and startup stalls before the
 * single-instance lease appears.
 */
function stdoutLogger(workspace, name) {
  const file = path.join(workspace.logsDir, `${name}.log`);
  return (line) => {
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      /* diagnostics must never fail the run */
    }
  };
}

/** Documented electron-builder output for the unpacked app directory. */
export function locatePackagedApp(repoRoot) {
  const appDir = path.join(
    repoRoot,
    "desktop",
    "release",
    "mac-arm64",
    "Borealis.app",
  );
  const binary = path.join(appDir, "Contents", "MacOS", "Borealis");
  if (!fs.existsSync(appDir) || !fs.existsSync(binary)) {
    return null;
  }
  return { appDir, binary };
}

function singletonLockPath(profileDir) {
  return path.join(profileDir, "SingletonLock");
}

/**
 * Chromium's SingletonLock is a symlink whose target is a machine-pid token,
 * not an existing path. fs.existsSync follows symlinks and would report a
 * live lease as missing, so lease checks must lstat without following.
 */
function singletonLockPresent(profileDir) {
  try {
    fs.lstatSync(singletonLockPath(profileDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the packaged-app lifecycle proof inside the isolated run tree.
 * Returns a content-free result record; throws HarnessError on proof failure.
 */
export async function runDesktopLifecycle({ workspace, repoRoot }) {
  const app = locatePackagedApp(repoRoot);
  if (!app) {
    return {
      status: "blocked",
      reason: "PACKAGED_APP_MISSING",
      expected_path: path.join(
        repoRoot,
        "desktop",
        "release",
        "mac-arm64",
        "Borealis.app",
      ),
    };
  }

  const profileDir = workspace.assertOwnedPath(
    path.join(workspace.root, "desktop-profile"),
  );
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const appArgs = [`--user-data-dir=${profileDir}`];

  const owned = [];
  const first = spawnOwned({
    command: app.binary,
    args: appArgs,
    cwd: workspace.root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME },
    label: "desktop-app",
    onStdoutLine: stdoutLogger(workspace, "desktop-app"),
  });
  workspace.trackPid(first.pid, "desktop-app");
  owned.push(first);

  try {
    // Ready proof: Electron's single-instance lease appears in the profile.
    const until = Date.now() + START_TIMEOUT_MS;
    while (!singletonLockPresent(profileDir)) {
      if (first.child.exitCode !== null || first.child.signalCode !== null) {
        throw new HarnessError("DESKTOP_APP_EXITED_EARLY");
      }
      if (Date.now() >= until)
        throw new HarnessError("DESKTOP_APP_START_TIMEOUT");
      await sleep(200);
    }

    // Single instance: a second launch against the same profile must exit
    // promptly (the first instance focuses instead), while the first lives.
    const second = spawnOwned({
      command: app.binary,
      args: appArgs,
      cwd: workspace.root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME,
      },
      label: "desktop-app-second",
      onStdoutLine: stdoutLogger(workspace, "desktop-app-second"),
    });
    workspace.trackPid(second.pid, "desktop-app-second");
    owned.push(second);
    const secondUntil = Date.now() + 15_000;
    while (
      second.child.exitCode === null &&
      second.child.signalCode === null &&
      Date.now() < secondUntil
    ) {
      await sleep(100);
    }
    assert(
      second.child.exitCode !== null || second.child.signalCode !== null,
      "DESKTOP_SINGLE_INSTANCE_BROKEN",
      "second instance did not exit",
    );
    assert(pidAlive(first.pid), "DESKTOP_FIRST_INSTANCE_DIED");

    // Teardown of the lifecycle instance is cleanup, not a quit proof: macOS
    // packaged Electron never routes an external signal into before-quit.
    const stop = await stopOwned(first, { graceMs: 10_000 });
    assert(stop.gone, "DESKTOP_APP_UNREACHABLE");

    // Orderly-quit contract: the packaged shutdown smoke boots a second
    // isolated instance and drives the production quit chain in-process. The
    // success token is only ever printed after the backend's own stop ack.
    const smokeProfile = workspace.assertOwnedPath(
      path.join(workspace.root, "desktop-profile-smoke"),
    );
    fs.mkdirSync(smokeProfile, { recursive: true, mode: 0o700 });
    const smoke = spawnOwned({
      command: app.binary,
      args: [
        "--borealis-packaged-shutdown-smoke",
        `--user-data-dir=${smokeProfile}`,
      ],
      cwd: workspace.root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME,
      },
      label: "desktop-shutdown-smoke",
      onStdoutLine: stdoutLogger(workspace, "desktop-shutdown-smoke"),
    });
    workspace.trackPid(smoke.pid, "desktop-shutdown-smoke");
    owned.push(smoke);
    const smokeUntil = Date.now() + SMOKE_TIMEOUT_MS;
    while (
      smoke.child.exitCode === null &&
      smoke.child.signalCode === null &&
      Date.now() < smokeUntil
    ) {
      await sleep(250);
    }
    assert(
      smoke.child.exitCode !== null || smoke.child.signalCode !== null,
      "DESKTOP_SHUTDOWN_SMOKE_HANG",
      "shutdown smoke instance did not exit on its own",
    );
    const smokeLog = path.join(workspace.logsDir, "desktop-shutdown-smoke.log");
    const smokeEvidence = fs.existsSync(smokeLog)
      ? fs.readFileSync(smokeLog, "utf8")
      : "";
    assert(
      smoke.child.exitCode === 0 &&
        smokeEvidence.includes("BOREALIS_PACKAGED_SHUTDOWN_SMOKE_OK"),
      "DESKTOP_SHUTDOWN_SMOKE_FAILED",
      "packaged quit chain did not prove an orderly backend stop",
    );
    assert(pidAlive(smoke.pid) === false, "DESKTOP_SHUTDOWN_SMOKE_PID_LEAKED");

    return {
      status: "pass",
      checks: {
        launch: "isolated-profile",
        singleInstance: "second-exited",
        teardown: stop.escalated ? "owned-kill" : "owned-term",
        quit: "packaged-shutdown-smoke-orderly",
        smokeExitCode: smoke.child.exitCode,
      },
    };
  } finally {
    // Never leave an owned app process behind, whatever the proof outcome.
    for (const entry of owned) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        await stopOwned(entry, { graceMs: 8_000 });
      }
    }
  }
}
