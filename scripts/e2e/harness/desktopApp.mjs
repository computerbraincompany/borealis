/**
 * Packaged-app product-scenario target: drive the REAL unsigned desktop build
 * (not the harness-launched server) through its loopback origin.
 *
 * The packaged app runs the compiled Fastify backend inside an Electron
 * utility process forked with `stdio: "inherit"`, so the backend's pino
 * ready line (`{"msg":"Borealis server listening","host":...,"port":...}`)
 * reaches the app process's own stdout. We spawn the app binary with
 * `spawnOwned` and drain every stdout line into a run log — an undrained
 * 64 KiB pipe stalls the app — and derive the loopback origin only from the
 * app's own ready line, never a guessed port.
 *
 * Product contract this target relies on (all verified against source):
 * - `POST /api/register` and `POST /api/login` are PUBLIC routes, so a
 *   journey account is registered through the real public route despite the
 *   desktop one-shot preload bootstrap the harness cannot use;
 * - `PATCH /api/settings` is process-wide and takes effect for later model
 *   operations without a restart. It refuses any embedding-identity change
 *   (`EMBEDDING_REINDEX_REQUIRED`), so the harness NEVER sends
 *   `default_embed_model`/`embedding_dimension`: the app keeps its default
 *   `nomic-embed`/768 identity and the scripted provider fixture is
 *   configured to answer as that exact physical model id at that exact
 *   dimension (alias `nomic-embed` resolves to
 *   `text-embedding-nomic-embed-text-v1.5`);
 * - the provider stays on loopback, so the remote-egress consent gate never
 *   applies (`local` locality is never gated);
 * - restart durability: `jwt.secret` is durable in the profile, so a
 *   pre-restart JWT must still authenticate (`GET /api/me` → 200) against
 *   the relaunched process. The UI session is re-established through the
 *   real login form because localStorage is per-origin and the relaunched
 *   app binds a NEW OS-assigned port.
 *
 * Teardown of the journey instance is cleanup, not a quit proof (same
 * disclosure as the lifecycle gate): packaged Electron dies from the signal
 * disposition without running `before-quit`, so SIGTERM here may escalate
 * to SIGKILL and that escalation is recorded and disclosed, never claimed
 * as an orderly quit. After the main pid dies we also wait until no OS
 * process still references the profile directory (the backend utility
 * process is an Electron child); any surviving child is killed against its
 * exact pid and disclosed.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HarnessError, assert, fetchJson, pidAlive, sleep, spawnOwned, stopOwned } from "./util.mjs";

const READY_MSG = "Borealis server listening";
const READY_TIMEOUT_MS = 120_000;
const BASELINE_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 20_000;
const CHILD_SETTLE_MS = 20_000;

/** The physical embed identity the packaged app defaults to, unchanged. */
export const DESKTOP_DEFAULT_EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5";
export const DESKTOP_DEFAULT_EMBED_DIM = 768;
export const DESKTOP_DEFAULT_CHAT_MODEL = "fixture-chat-v1";

function appSpawnEnv() {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME };
}

/** Drain app stdout/stderr into a run log; diagnostics never fail the run. */
function instanceLogger(workspace, label) {
  const file = path.join(workspace.logsDir, `${label}.log`);
  return {
    stdout: (line) => {
      try {
        fs.appendFileSync(file, `${line}\n`);
      } catch {
        /* ignore */
      }
    },
    stderr: (chunk) => {
      try {
        fs.appendFileSync(file, String(chunk).slice(0, 4_000));
      } catch {
        /* ignore */
      }
    },
  };
}

/** Parse one stdout line into {host, port} when it is the backend ready line. */
export function parseAppReadyLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && parsed.msg === READY_MSG && Number.isSafeInteger(parsed.port)) {
      return { host: String(parsed.host ?? "127.0.0.1"), port: parsed.port };
    }
  } catch {
    /* not JSON: fall through to the textual form */
  }
  const match = /Server listening at https?:\/\/(127\.0\.0\.1|\[::1\]|localhost):(\d+)/i.exec(line);
  if (match) return { host: match[1], port: Number.parseInt(match[2], 10) };
  return null;
}

/**
 * Bounded wait until no OS process still references the profile directory.
 * Returns the surviving pids. Any survivor is an Electron child of the owned
 * app; cleanup kills those exact pids and discloses the escalation.
 */
async function waitForProfileProcessesGone(profileDir, deadlineMs) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    let survivors = [];
    try {
      const listing = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 5_000 });
      survivors = listing
        .split("\n")
        .filter((line) => line.includes(profileDir))
        .map((line) => Number.parseInt(line.trim().split(/\s+/, 1)[0], 10))
        .filter((pid) => Number.isSafeInteger(pid) && pid !== process.pid);
    } catch {
      survivors = [];
    }
    if (survivors.length === 0) return [];
    if (Date.now() >= until) return survivors;
    await sleep(250);
  }
}

/**
 * Launch the packaged app and return a durable handle. The handle keeps the
 * CURRENT instance (restart replaces pid, port, and origin).
 */
export async function launchPackagedApp({ workspace, app, profileDirName = "desktop-app-profile", label = "desktop-app" }) {
  assert(app && fs.existsSync(app.binary), "PACKAGED_APP_BINARY_MISSING", app?.binary ?? "none");
  const profileDir = workspace.assertOwnedPath(path.join(workspace.root, profileDirName));
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  let currentEntry = null;
  let currentOrigin = null;
  let instanceIndex = 0;

  async function spawnInstance() {
    instanceIndex += 1;
    const labelInstance = instanceIndex === 1 ? label : `${label}-restart${instanceIndex - 1}`;
    const logger = instanceLogger(workspace, labelInstance);
    let ready;
    let readySettled;
    const readyPromise = new Promise((resolve, reject) => {
      readySettled = { resolve, reject };
    });
    const entry = spawnOwned({
      command: app.binary,
      args: [`--user-data-dir=${profileDir}`],
      cwd: workspace.root,
      env: appSpawnEnv(),
      label: labelInstance,
      onStdoutLine: (line) => {
        logger.stdout(line);
        if (ready) return;
        const parsed = parseAppReadyLine(line);
        if (parsed) {
          ready = parsed;
          readySettled.resolve(parsed);
        }
      },
    });
    entry.child.stderr.on("data", (chunk) => logger.stderr(chunk));
    entry.child.on("exit", () => readySettled.reject(new HarnessError("DESKTOP_APP_EXITED_EARLY")));
    workspace.trackPid(entry.pid, labelInstance);

    const deadline = setTimeout(() => readySettled.reject(new HarnessError("DESKTOP_APP_READY_TIMEOUT")), READY_TIMEOUT_MS);
    let listenInfo;
    try {
      listenInfo = await readyPromise;
    } finally {
      clearTimeout(deadline);
    }
    currentEntry = entry;
    currentOrigin = `http://${listenInfo.host}:${listenInfo.port}`;
    return listenInfo;
  }

  async function waitBaseline(origin) {
    const until = Date.now() + BASELINE_TIMEOUT_MS;
    let health;
    for (;;) {
      try {
        health = await fetchJson(`${origin}/health`, { timeoutMs: 3_000 });
        if (health.status === 200 && health.body?.status === "ok") break;
      } catch {
        /* connection refused while the socket opens */
      }
      if (Date.now() >= until) {
        throw new HarnessError("DESKTOP_APP_HEALTH_TIMEOUT", String(health?.status ?? 0));
      }
      await sleep(200);
    }
    const status = await fetchJson(`${origin}/api/status`, { timeoutMs: 5_000 });
    assert(status.status === 401, "DESKTOP_STATUS_GATE_BROKEN", `got ${status.status}`);
    const apiHealth = await fetchJson(`${origin}/api/health`, { timeoutMs: 5_000 });
    assert(apiHealth.status === 401, "DESKTOP_HEALTH_GATE_BROKEN", `got ${apiHealth.status}`);
  }

  const firstListen = await spawnInstance();
  await waitBaseline(currentOrigin);

  const handle = {
    app,
    profileDir,
    get pid() {
      return currentEntry.pid;
    },
    get origin() {
      return currentOrigin;
    },
    listen: firstListen,
    disclosures: { restarts: [] },

    /** Public registration route; returns {token, user}. */
    async register({ email, password }) {
      const res = await fetchJson(`${currentOrigin}/api/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        requestBody: JSON.stringify({ email, password }),
        timeoutMs: 15_000,
      });
      assert(res.status === 200 && typeof res.body?.token === "string", "DESKTOP_REGISTER_FAILED", String(res.status));
      return res.body;
    },

    /** Public login route (the harness logs in through the real UI form). */
    async login({ email, password }) {
      const res = await fetchJson(`${currentOrigin}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        requestBody: JSON.stringify({ email, password }),
        timeoutMs: 15_000,
      });
      assert(res.status === 200 && typeof res.body?.token === "string", "DESKTOP_LOGIN_FAILED", String(res.status));
      return res.body;
    },

    /**
     * Point the app's process-wide Settings at the scripted loopback
     * provider WITHOUT touching embedding identity. First the draft-effective
     * connection test (a body-free GET /v1/models against the unsaved draft),
     * then the authenticated PATCH. Saves take effect for later model
     * operations without a restart.
     */
    async configureProvider({ token, providerOrigin, chatModel }) {
      const draft = { llm_base_url: providerOrigin, default_chat_model: chatModel };
      const test = await fetchJson(`${currentOrigin}/api/settings/test`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        requestBody: JSON.stringify(draft),
        timeoutMs: 20_000,
      });
      assert(test.status === 200 && test.body?.ok === true, "DESKTOP_SETTINGS_TEST_FAILED", String(test.status));
      const patch = await fetchJson(`${currentOrigin}/api/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        requestBody: JSON.stringify(draft),
        timeoutMs: 20_000,
      });
      assert(patch.status === 200, "DESKTOP_SETTINGS_PATCH_FAILED", String(patch.status));
      assert(patch.body?.llm_base_url === providerOrigin, "DESKTOP_SETTINGS_BASE_URL_ECHO");
      assert(patch.body?.default_chat_model === chatModel, "DESKTOP_SETTINGS_CHAT_ECHO");
      // Identity honesty: the harness must not have moved the embedding identity.
      assert(patch.body?.default_embed_model === "nomic-embed", "DESKTOP_SETTINGS_EMBED_MOVED");
      assert(patch.body?.embedding_dimension === DESKTOP_DEFAULT_EMBED_DIM, "DESKTOP_SETTINGS_EMBED_DIM_MOVED");
      return patch.body;
    },

    /**
     * Worker-quiescence gate: the same product readiness surface
     * (`GET /api/health`) the browser-mode harness polls, on this origin.
     */
    async quiesceWorkers({ token, deadlineMs = 30_000 } = {}) {
      assert(typeof token === "string" && token.length > 0, "QUIESCE_TOKEN_MISSING");
      const until = Date.now() + deadlineMs;
      for (;;) {
        const health = await fetchJson(`${currentOrigin}/api/health`, {
          timeoutMs: 5_000,
          headers: { Authorization: `Bearer ${token}` },
        });
        const services = Array.isArray(health.body?.services) ? health.body.services : [];
        const operational =
          health.status === 200 &&
          health.body?.status === "operational" &&
          services.length > 0 &&
          services.every((service) => service?.status === "operational");
        if (operational) return { quiesced: true };
        if (Date.now() >= until) {
          throw new HarnessError(
            "WORKER_QUIESCE_TIMEOUT",
            services.length ? services.map((s) => `${s.id}=${s.status}`).join(",") : String(health.status)
          );
        }
        await sleep(150);
      }
    },

    /**
     * Restart-survival step for journey B: quiesce on the product's own
     * readiness gate, terminate the owned app (SIGTERM, bounded escalation
     * to SIGKILL — disclosed, not a quit-contract claim), wait until no OS
     * process references the profile, relaunch on the SAME profile, re-derive
     * the origin from the fresh log line, re-verify the fail-closed auth
     * gate, and prove the durable `jwt.secret`: a pre-restart JWT must
     * authenticate on the new process.
     */
    async restart({ token }) {
      assert(typeof token === "string" && token.length > 0, "DESKTOP_RESTART_TOKEN_MISSING");
      await handle.quiesceWorkers({ token });
      const stopped = await stopOwned(currentEntry, { graceMs: STOP_GRACE_MS });
      assert(stopped.gone, "DESKTOP_RESTART_STOP_UNREACHABLE");
      const survivors = await waitForProfileProcessesGone(profileDir, CHILD_SETTLE_MS);
      let killedSurvivors = [];
      if (survivors.length > 0) {
        killedSurvivors = survivors.filter((pid) => {
          try {
            process.kill(pid, "SIGKILL");
            return true;
          } catch {
            return false;
          }
        });
        const still = await waitForProfileProcessesGone(profileDir, CHILD_SETTLE_MS);
        assert(still.length === 0, "DESKTOP_APP_CHILD_ORPHANED", still.join(","));
      }
      const previousPort = Number.parseInt(currentOrigin.lastIndexOf(":") >= 0 ? currentOrigin.slice(currentOrigin.lastIndexOf(":") + 1) : "0", 10);
      const listenInfo = await spawnInstance();
      await waitBaseline(currentOrigin);
      const me = await fetchJson(`${currentOrigin}/api/me`, {
        timeoutMs: 10_000,
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(me.status === 200, "DESKTOP_JWT_NOT_DURABLE_ACROSS_RESTART", String(me.status));
      const disclosure = {
        escalated: stopped.escalated,
        survivors_killed: killedSurvivors.length,
        origin_changed: listenInfo.port !== previousPort,
      };
      handle.disclosures.restarts.push(disclosure);
      return { pid: currentEntry.pid, origin: currentOrigin, ...disclosure };
    },

    /** Owned cleanup: stop the current instance and prove profile quiescence. */
    async stop() {
      const result = { problems: [] };
      if (currentEntry && currentEntry.child.exitCode === null && currentEntry.child.signalCode === null) {
        const stopped = await stopOwned(currentEntry, { graceMs: STOP_GRACE_MS });
        result.escalated = stopped.escalated;
        result.gone = stopped.gone;
        if (!stopped.gone) result.problems.push("DESKTOP_APP_STOP_UNREACHABLE");
      }
      const survivors = await waitForProfileProcessesGone(profileDir, CHILD_SETTLE_MS);
      for (const pid of survivors) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* pid vanished between listing and kill */
        }
      }
      const still = await waitForProfileProcessesGone(profileDir, CHILD_SETTLE_MS);
      if (still.length > 0) result.problems.push("DESKTOP_APP_CHILD_ORPHANED");
      result.survivors_gone = still.length === 0;
      return result;
    },

    pidAlive: () => pidAlive(currentEntry?.pid),
  };
  return handle;
}

/**
 * Journey-target adapter over a packaged-app handle. The browser-mode target
 * lives in journeys/B.mjs's default; this one differs exactly where the
 * packaged app differs: registration happens through the public API route
 * (the preload bootstrap is unavailable to Playwright), the app restarts as
 * a NEW process on a NEW loopback port, and the authenticated UI session is
 * re-established afterwards through the real login form (localStorage is
 * per-origin; the JWT itself is separately proven durable by the handle).
 */
export function createPackagedAppTarget({ app }) {
  const credentialsBySession = new WeakMap();
  let origin = app.origin;
  return {
    kind: "packaged-desktop",
    get origin() {
      return origin;
    },
    pid: () => app.pid,
    async registerAccount(session, credentials) {
      await app.register(credentials);
      // A fresh context starts on about:blank where localStorage is denied;
      // land on the app origin first (the browser-mode register always
      // navigated there) and then log in through the real form.
      await session.page.goto(`${session.origin}/`, { waitUntil: "domcontentloaded" });
      await session.login(credentials);
      credentialsBySession.set(session, credentials);
    },
    async restart({ token, session }) {
      // Detach the UI from the dying origin so in-flight app polls cannot
      // produce console noise during the outage; the resume re-navigates.
      await session.page.goto("about:blank").catch(() => undefined);
      const info = await app.restart({ token });
      origin = info.origin;
      session.setOrigin(info.origin);
      return info;
    },
    async resumeAfterRestart(session) {
      const credentials = credentialsBySession.get(session);
      assert(credentials !== undefined, "DESKTOP_RESUME_CREDENTIALS_MISSING");
      await session.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await session.login(credentials);
    },
    quiesceWorkers: (options) => app.quiesceWorkers(options),
  };
}
