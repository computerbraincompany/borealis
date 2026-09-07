/**
 * Boot the actual production Borealis server under test.
 *
 * Builds are assumed pre-done by the entry script (this module only verifies
 * the compiled artifacts exist). The server is the real `server/dist/index.js`
 * composed exactly as production, with a harness-owned environment:
 *
 * - `LLM_BASE_URL` points at the launched scripted provider fixture;
 * - the embedding/chat identity is pinned to the fixture pair
 *   (`LLM_EMBED_MODEL`/`EMBEDDING_DIM`/`LLM_CHAT_MODEL`), which are the
 *   operator-precedence overrides and disable any Settings-managed migration;
 * - `JWT_SECRET` is deliberately absent so the server generates its own
 *   mode-0600 secret inside the isolated workspace;
 * - `BOREALIS_DATA_DIR` is the exact isolated workspace directory;
 * - `STATIC_WEB_DIR` serves the built production web UI from the same origin;
 * - `PORT=0` gives an OS-assigned loopback port, taken from the server's own
 *   `Borealis server listening` log line, never guessed.
 */
import fs from "node:fs";
import path from "node:path";
import { HarnessError, assert, fetchJson, spawnOwned, stopOwned } from "./util.mjs";

const READY_MSG = "Borealis server listening";

function assertPrebuilt(repoRoot) {
  const serverEntry = path.join(repoRoot, "server", "dist", "index.js");
  const webIndex = path.join(repoRoot, "web", "dist", "index.html");
  for (const file of [serverEntry, webIndex]) {
    if (!fs.existsSync(file)) {
      throw new HarnessError(
        "PREBUILT_MISSING",
        `${path.relative(repoRoot, file)} not found — run the builds (omit --skip-build) or pnpm build`
      );
    }
  }
  return { serverEntry, webDist: path.join(repoRoot, "web", "dist") };
}

/**
 * Start the server, resolve its loopback origin from the ready log line, and
 * verify baseline health: public `/health` must answer `ok`, and the
 * authenticated `/api/status` surface must be present and fail closed with
 * `401` before any session exists (the ambient strip route is wired).
 */
export async function startServer({ workspace, repoRoot, provider, models }) {
  const { serverEntry, webDist } = assertPrebuilt(repoRoot);
  const { chatModel, embedModel, embedDim } = models;

  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME,
    LANG: "en_US.UTF-8",
    NODE_ENV: "production",
    BOREALIS_DATA_DIR: workspace.workspaceDir,
    HOST: "127.0.0.1",
    PORT: "0",
    STATIC_WEB_DIR: webDist,
    LLM_BASE_URL: provider.origin,
    LLM_CHAT_MODEL: chatModel,
    LLM_EMBED_MODEL: embedModel,
    EMBEDDING_DIM: String(embedDim),
    // No JWT_SECRET, no LITELLM_* aliases, no CORS overrides: the server
    // generates its secret in the isolated workspace and serves the UI from
    // the exact same origin, which needs no CORS.
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

  const logFile = path.join(workspace.logsDir, "server.log");

  /**
   * Spawn one server process and resolve its listen coordinates from its own
   * ready log line. Used for the first boot and for mid-journey restarts
   * (durability proof); every spawn is pid-tracked and owns its own promise.
   */
  async function spawnListeningProcess(processEnv) {
    let ready;
    let readySettled;
    const readyPromise = new Promise((resolve, reject) => {
      readySettled = { resolve, reject };
    });

    const entry = spawnOwned({
      command: process.execPath,
      args: [serverEntry],
      // A neutral cwd so no stray .env next to the sources can leak in.
      cwd: workspace.root,
      env: processEnv,
      label: "server",
      onStdoutLine: (line) => {
        fs.appendFileSync(logFile, `${line}\n`);
        if (ready) return;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (parsed && parsed.msg === READY_MSG && Number.isSafeInteger(parsed.port)) {
          ready = { port: parsed.port, host: String(parsed.host ?? "127.0.0.1") };
          readySettled.resolve(ready);
        }
      },
    });
    entry.child.stderr.on("data", (piece) => fs.appendFileSync(logFile, String(piece).slice(0, 4_000)));
    entry.child.on("exit", () => readySettled.reject(new HarnessError("SERVER_EXITED_EARLY")));
    workspace.trackPid(entry.pid, "server");

    const deadline = setTimeout(() => readySettled.reject(new HarnessError("SERVER_READY_TIMEOUT")), 60_000);
    let listenInfo;
    try {
      // The exit listener rejects this promise on an early death, so a single
      // await covers ready, timeout, and early exit.
      listenInfo = await readyPromise;
    } finally {
      clearTimeout(deadline);
    }
    if (!listenInfo) throw new HarnessError("SERVER_EXITED_EARLY");
    return { entry, listenInfo };
  }

  let currentEntry = null;
  let currentPort = 0;

  const first = await spawnListeningProcess(env);
  currentEntry = first.entry;
  currentPort = first.listenInfo.port;

  const origin = `http://${first.listenInfo.host}:${first.listenInfo.port}`;
  const server = {
    origin,
    get port() {
      return currentPort;
    },
    get pid() {
      return currentEntry.pid;
    },
    logFile,
    fetchJson: (route, options) => fetchJson(`${origin}${route}`, options),

    async waitBaseline() {
      const health = await pollHealth(`${origin}/health`, 30_000);
      assert(health.status === 200 && health.body?.status === "ok", "SERVER_HEALTH_UNHEALTHY");
      // The authenticated surfaces exist and fail closed pre-session. A
      // 401 here is the positive sanity signal, not an error.
      const status = await fetchJson(`${origin}/api/status`, { timeoutMs: 5_000 });
      assert(status.status === 401, "SERVER_STATUS_GATE_BROKEN", `got ${status.status}`);
      const apiHealth = await fetchJson(`${origin}/api/health`, { timeoutMs: 5_000 });
      assert(apiHealth.status === 401, "SERVER_HEALTH_GATE_BROKEN", `got ${apiHealth.status}`);
      return { health: "ok", authGate: "enforced" };
    },

    /**
     * Worker-quiescence gate: poll the product's own authenticated
     * dependency-readiness surface until every service (including the
     * DuckDB-backed data worker) reports operational. This is a bounded poll
     * on a real readiness signal, used to settle browser journey transitions.
     * It is not active-work shutdown evidence. The repaired product drain is
     * exercised without this convenience gate by shutdownDrain.test.ts and
     * run-product-lifecycle.mjs, including native work and late HTTP responses.
     */
    async quiesceWorkers({ token, deadlineMs = 30_000 } = {}) {
      assert(typeof token === "string" && token.length > 0, "QUIESCE_TOKEN_MISSING");
      const until = Date.now() + deadlineMs;
      for (;;) {
        const health = await fetchJson(`${origin}/api/health`, {
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
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    },

    /** Orderly SIGTERM (the production shutdown path) with bounded escalation. */
    async stop() {
      const result = await stopOwned(currentEntry, { graceMs: 25_000 });
      return result;
    },

    /**
     * Mid-journey backend restart (acceptance durability proof): quiesce on
     * the product's own readiness gate, request orderly shutdown of the
     * current process, then boot a fresh process against the SAME isolated
     * data directory pinned to the SAME loopback port, so the browser
     * session's origin and stored JWT remain valid across the restart
     * (`jwt.secret` lives in the isolated workspace and is not regenerated).
     * Optional whileStopped prepares historical acceptance fixtures only after
     * shutdown has released all stores; the callback owns its workspace lock.
     */
    async restart({ token, whileStopped } = {}) {
      await server.quiesceWorkers({ token });
      const stopped = await server.stop();
      assert(stopped.gone && !stopped.escalated, "SERVER_RESTART_STOP_UNCLEAN");
      if (whileStopped !== undefined) {
        assert(typeof whileStopped === "function", "SERVER_STOPPED_CALLBACK_INVALID");
        await whileStopped();
      }
      const next = await spawnListeningProcess({ ...env, PORT: String(currentPort) });
      currentEntry = next.entry;
      assert(next.listenInfo.port === currentPort, "SERVER_RESTART_PORT_MOVED");
      await server.waitBaseline();
      return { pid: next.entry.pid, port: currentPort };
    },
  };
  return server;
}

async function pollHealth(url, deadlineMs) {
  const until = Date.now() + deadlineMs;
  let last;
  for (;;) {
    try {
      last = await fetchJson(url, { timeoutMs: 3_000 });
      if (last.status === 200) return last;
    } catch {
      // Connection refused while the socket is still opening.
    }
    if (Date.now() >= until) return last ?? { status: 0, body: null };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
