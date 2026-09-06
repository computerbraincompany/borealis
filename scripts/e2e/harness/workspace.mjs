/**
 * Isolated product-acceptance workspace.
 *
 * Creates one disposable absolute directory tree that owns everything the
 * run touches: the server's `BOREALIS_DATA_DIR`, artifacts, logs, and the
 * sibling `.borealis-instance.lock` namespace the server publishes beside its
 * storage directory. Cleanup stops owned processes, proves the workspace lock
 * and every owned pid are released, and only then removes the tree — and only
 * ever inside its own temp root. It refuses any target outside that root and
 * refuses the user's real `.borealis` / installed-app profile outright.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessError, assert, pidAlive, removeTree } from "./util.mjs";

const LOCK_SUFFIX = ".borealis-instance.lock";

function forbiddenRealRoots(repoRoot) {
  const home = os.homedir();
  return [
    path.join(repoRoot, ".borealis"),
    path.join(home, ".borealis"),
    path.join(home, "Library", "Application Support", "Borealis"),
  ];
}

function inside(candidate, parent) {
  return candidate === parent || candidate.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * Create (or adopt an explicitly supplied, empty) isolated run root.
 *
 * Layout under `root`:
 *   workspace/            server BOREALIS_DATA_DIR (exact, absolute)
 *   artifacts/<journey>/  content-free screenshots and evidence
 *   logs/                 bounded process logs
 *   .workspace.borealis-instance.lock/   server lock namespace (sibling of workspace/)
 */
export function createIsolatedWorkspace({ repoRoot, workspaceOverride, runId, preserve = false }) {
  assert(path.isAbsolute(repoRoot), "WORKSPACE_REPO_ROOT_ABSOLUTE");
  const repoReal = fs.realpathSync(repoRoot);
  const forbidden = forbiddenRealRoots(repoReal).flatMap((dir) => {
    try {
      return [fs.realpathSync(dir)];
    } catch {
      return [path.resolve(dir)];
    }
  });

  let root;
  if (workspaceOverride !== undefined) {
    if (!path.isAbsolute(workspaceOverride)) {
      throw new HarnessError("WORKSPACE_OVERRIDE_ABSOLUTE", "--workspace must be an absolute path");
    }
    const wanted = path.resolve(workspaceOverride);
    const parent = path.dirname(wanted);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentReal = fs.realpathSync(parent);
    const candidateReal = path.join(parentReal, path.basename(wanted));
    if (forbidden.some((dir) => candidateReal === dir || inside(candidateReal, dir))) {
      throw new HarnessError("WORKSPACE_FORBIDDEN", "refusing to use a real Borealis workspace for testing");
    }
    let existing;
    try {
      existing = fs.readdirSync(candidateReal);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing !== undefined) {
      const stat = fs.lstatSync(candidateReal);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(candidateReal) !== candidateReal) {
        throw new HarnessError("WORKSPACE_NOT_PLAIN_DIR", "override must be an exact regular directory");
      }
      if (!preserve && existing.length > 0) {
        throw new HarnessError("WORKSPACE_NOT_EMPTY", "override directory must not already contain entries");
      }
    } else {
      fs.mkdirSync(candidateReal, { mode: 0o700 });
    }
    root = candidateReal;
  } else {
    const tmpReal = fs.realpathSync(os.tmpdir());
    root = fs.realpathSync(fs.mkdtempSync(path.join(tmpReal, `borealis-e2e-${runId ?? "run"}-`)));
    assert(root !== tmpReal && inside(root, tmpReal), "WORKSPACE_TMP_ROOT_DRIFT");
  }

  if (forbidden.some((dir) => root === dir || inside(dir, root))) {
    throw new HarnessError("WORKSPACE_FORBIDDEN", "run root overlaps a real Borealis workspace");
  }
  // Fail closed: the repository (or a subtree of it) is never a disposable
  // run root, even if an override points at it.
  if (root === repoReal || inside(root, repoReal)) {
    throw new HarnessError("WORKSPACE_FORBIDDEN", "run root overlaps the repository");
  }

  const workspaceDir = path.join(root, "workspace");
  const artifactsDir = path.join(root, "artifacts");
  const logsDir = path.join(root, "logs");
  for (const dir of [workspaceDir, artifactsDir, logsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // The server publishes its instance lock beside the storage directory.
  const lockNamespace = path.join(root, `.${path.basename(workspaceDir)}${LOCK_SUFFIX}`);

  const ownedPids = new Map();
  const stoppers = [];
  let removed = false;

  const workspace = {
    root,
    workspaceDir,
    artifactsDir,
    logsDir,
    lockNamespace,
    summaryFile: path.join(root, "summary.json"),

    trackPid(pid, label) {
      ownedPids.set(pid, label);
      return pid;
    },

    /** Register an async stop hook run (in reverse order) before removal. */
    onCleanup(stop) {
      stoppers.push(stop);
    },

    journeyArtifacts(journeyId) {
      const dir = path.join(artifactsDir, journeyId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },

    /** Containment proof: only paths inside this run root may be touched. */
    assertOwnedPath(target) {
      const resolved = path.resolve(target);
      if (!(resolved === root || inside(resolved, root))) {
        throw new HarnessError("WORKSPACE_ESCAPE", "refusing to touch a path outside the isolated run root");
      }
      return resolved;
    },

    /** Prove the server released its workspace lock (no live owner records). */
    verifyLockReleased() {
      let entries = [];
      try {
        entries = fs.readdirSync(lockNamespace);
      } catch (error) {
        if (error.code === "ENOENT") return { released: true, namespacePresent: false };
        throw error;
      }
      const leaked = entries.filter((name) => name.startsWith("owner.") || name.startsWith(".tmp."));
      return { released: leaked.length === 0, namespacePresent: true, leakedCount: leaked.length };
    },

    /** Prove every tracked pid is gone. */
    verifyPidsGone() {
      const alive = [];
      for (const [pid, label] of ownedPids) {
        if (pidAlive(pid)) alive.push(label);
      }
      return { gone: alive.length === 0, aliveLabels: alive };
    },

    /**
     * Stop all owned processes (reverse registration order), prove lock and
     * pid release, then remove the tree. With `keep`, stops and proofs still
     * run but the tree stays and its absolute path is returned.
     */
    async cleanup({ keep = false } = {}) {
      const problems = [];
      for (const stop of stoppers.reverse()) {
        try {
          await stop();
        } catch (error) {
          problems.push(error instanceof HarnessError ? error.code : "CLEANUP_STEP_FAILED");
        }
      }
      stoppers.length = 0;
      const lock = workspace.verifyLockReleased();
      const pids = workspace.verifyPidsGone();
      if (!lock.released) problems.push("WORKSPACE_LOCK_LEAKED");
      if (!pids.gone) problems.push("OWNED_PID_LEAK");
      let kept = false;
      if (keep) {
        kept = true;
      } else {
        workspace.assertOwnedPath(root);
        await removeTree(root);
        if (fs.existsSync(root)) problems.push("WORKSPACE_REMOVE_FAILED");
        removed = true;
      }
      return { removed, kept, lockReleased: lock.released, pidsGone: pids.gone, problems };
    },

    get isRemoved() {
      return removed;
    },
  };

  return workspace;
}
