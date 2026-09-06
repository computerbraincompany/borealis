/**
 * Packaged-desktop lifecycle SKELETON (stage 1).
 *
 * Locates the unsigned arm64 packaged application at the documented
 * convention (`desktop/release/mac-arm64/Borealis.app`, see
 * desktop/README.md), launches the real app executable with an absolute
 * `--user-data-dir` inside the isolated run tree, proves single-instance
 * behavior (a second launch against the same profile must exit while the
 * first keeps running), and proves an orderly SIGTERM quit (bounded wait,
 * escalation only against the owned pid, profile singleton lock released).
 *
 * A–F desktop journey coverage arrives with the features; if no packaged app
 * exists, the entry must surface BLOCKED (distinct exit code), never a fake
 * pass.
 */
import fs from "node:fs";
import path from "node:path";
import { HarnessError, assert, pidAlive, sleep, spawnOwned, stopOwned } from "./util.mjs";

const START_TIMEOUT_MS = 45_000;
const QUIT_TIMEOUT_MS = 60_000;

/** Documented electron-builder output for the unpacked app directory. */
export function locatePackagedApp(repoRoot) {
  const appDir = path.join(repoRoot, "desktop", "release", "mac-arm64", "Borealis.app");
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
 * Run the packaged-app lifecycle proof inside the isolated run tree.
 * Returns a content-free result record; throws HarnessError on proof failure.
 */
export async function runDesktopLifecycle({ workspace, repoRoot }) {
  const app = locatePackagedApp(repoRoot);
  if (!app) {
    return {
      status: "blocked",
      reason: "PACKAGED_APP_MISSING",
      expected_path: path.join(repoRoot, "desktop", "release", "mac-arm64", "Borealis.app"),
    };
  }

  const profileDir = workspace.assertOwnedPath(path.join(workspace.root, "desktop-profile"));
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const appArgs = [`--user-data-dir=${profileDir}`];

  const owned = [];
  const first = spawnOwned({
    command: app.binary,
    args: appArgs,
    cwd: workspace.root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME },
    label: "desktop-app",
  });
  workspace.trackPid(first.pid, "desktop-app");
  owned.push(first);

  try {
    // Ready proof: Electron's single-instance lease appears in the profile.
    const until = Date.now() + START_TIMEOUT_MS;
    while (!fs.existsSync(singletonLockPath(profileDir))) {
      if (first.child.exitCode !== null || first.child.signalCode !== null) {
        throw new HarnessError("DESKTOP_APP_EXITED_EARLY");
      }
      if (Date.now() >= until) throw new HarnessError("DESKTOP_APP_START_TIMEOUT");
      await sleep(200);
    }

    // Single instance: a second launch against the same profile must exit
    // promptly (the first instance focuses instead), while the first lives.
    const second = spawnOwned({
      command: app.binary,
      args: appArgs,
      cwd: workspace.root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME },
      label: "desktop-app-second",
    });
    workspace.trackPid(second.pid, "desktop-app-second");
    owned.push(second);
    const secondUntil = Date.now() + 15_000;
    while (second.child.exitCode === null && second.child.signalCode === null && Date.now() < secondUntil) {
      await sleep(100);
    }
    assert(
      second.child.exitCode !== null || second.child.signalCode !== null,
      "DESKTOP_SINGLE_INSTANCE_BROKEN",
      "second instance did not exit"
    );
    assert(pidAlive(first.pid), "DESKTOP_FIRST_INSTANCE_DIED");

    // Orderly quit: SIGTERM to the owned pid (before-quit drains the backend
    // utility process), bounded wait, then escalation to the owned pid only.
    const stop = await stopOwned(first, { graceMs: QUIT_TIMEOUT_MS });
    assert(stop.gone, "DESKTOP_APP_UNREACHABLE");
    assert(!stop.escalated, "DESKTOP_APP_REQUIRED_KILL", "orderly SIGTERM quit not proven");
    await sleep(250);
    assert(!fs.existsSync(singletonLockPath(profileDir)), "DESKTOP_PROFILE_LOCK_LEAKED");

    return {
      status: "pass",
      checks: {
        launch: "isolated-profile",
        singleInstance: "second-exited",
        quit: "sigterm-orderly",
        profileLock: "released",
        exitCode: stop.exited?.code ?? null,
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
