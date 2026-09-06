/**
 * Launch/stop helpers for the committed protocol fixtures under
 * `scripts/e2e/fixtures/`.
 *
 * Every HTTP fixture prints exactly one content-free ready line
 * `{"protocol":"borealis-e2e-fixture","fixture":...,"origin":...}`; the stdio
 * MCP fixture prints none (stdout is protocol bytes), so it is launched with
 * `stdioReady` and readiness comes from the MCP `initialize` response driven
 * by the journey. Each fixture's parsed ready payload is injected into the
 * harness context (`ctx.fixtures[name]`) so journeys configure the product
 * under test from the actual loopback endpoints rather than guessing ports.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, assert, fetchJson, spawnOwned, stopOwned } from "./util.mjs";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, "..", "..", "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "scripts", "e2e", "fixtures");

export const FIXTURE_SCRIPTS = {
  "openai-provider": "openai-provider.mjs",
  "mcp-server-stdio": "mcp-server-stdio.mjs",
  "mcp-server-http": "mcp-server-http.mjs",
  "oauth-issuer": "oauth-issuer.mjs",
  webdav: "webdav.mjs",
};

/**
 * Spawn one committed fixture with an explicit minimal environment and await
 * its single ready line (HTTP fixtures). Returns a tracked handle whose
 * `ready` payload carries the fixture's own loopback endpoints.
 */
export async function launchFixture({ workspace, name, env = {}, stdioReady = false, readyTimeoutMs = 15_000 }) {
  const script = FIXTURE_SCRIPTS[name];
  assert(script !== undefined, "FIXTURE_UNKNOWN", name);
  const file = path.join(FIXTURES_DIR, script);

  const fixtureEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env };
  let readyPayload;
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const entry = spawnOwned({
    command: process.execPath,
    args: [file],
    cwd: REPO_ROOT,
    env: fixtureEnv,
    label: `fixture:${name}`,
    onStdoutLine: stdioReady
      ? undefined
      : (line) => {
          if (readyPayload) return;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            readyReject(new HarnessError(`FIXTURE_READY_UNPARSEABLE:${name}`));
            return;
          }
          if (parsed?.protocol !== "borealis-e2e-fixture" || parsed?.fixture === undefined) {
            readyReject(new HarnessError(`FIXTURE_READY_PROTOCOL:${name}`));
            return;
          }
          readyPayload = parsed;
          readyResolve(parsed);
        },
  });
  entry.child.on("exit", () => readyReject(new HarnessError(`FIXTURE_EXITED_BEFORE_READY:${name}`)));
  workspace.trackPid(entry.pid, `fixture:${name}`);

  let ready = null;
  if (!stdioReady) {
    const timer = setTimeout(() => readyReject(new HarnessError(`FIXTURE_READY_TIMEOUT:${name}`)), readyTimeoutMs);
    ready = await readyPromise.finally(() => clearTimeout(timer));
  }

  const handle = {
    name,
    pid: entry.pid,
    ready,
    /** Per-fixture config injected into the harness context. */
    config: ready ?? { stdio: true },
    async stop() {
      return stopOwned(entry, { graceMs: 6_000, viaStdinClose: stdioReady });
    },
  };
  return handle;
}

/**
 * Launch the scripted OpenAI-compatible provider and return its handle plus
 * the exact model identity the server must be configured with.
 */
export async function launchProvider({ workspace, script, chatModel = "fixture-chat-v1", embedModel = "fixture-embed-v1", embedDim = 64, onExhausted }) {
  const env = {
    E2E_OPENAI_CHAT_MODEL: chatModel,
    E2E_OPENAI_EMBED_MODEL: embedModel,
    E2E_OPENAI_EMBED_DIM: String(embedDim),
  };
  if (script !== undefined) {
    env.E2E_OPENAI_SCRIPT = typeof script === "string" ? script : JSON.stringify(script);
  }
  if (onExhausted !== undefined) env.E2E_OPENAI_ON_EXHAUSTED = onExhausted;
  const handle = await launchFixture({ workspace, name: "openai-provider", env });
  assert(typeof handle.ready?.origin === "string", "FIXTURE_READY_MISSING_ORIGIN:openai-provider");
  handle.origin = handle.ready.origin;
  handle.models = { chatModel, embedModel, embedDim };
  handle.state = async () => {
    const res = await fetchJson(`${handle.origin}/fixture/state`, { timeoutMs: 5_000 });
    assert(res.status === 200, "PROVIDER_STATE_UNAVAILABLE");
    return res.body;
  };
  /**
   * Install a deterministic step script at runtime (resets the provider's
   * step pointer). Used by journeys that need a scripted tool-call
   * roundtrip against the one provider instance the entry launched.
   */
  handle.setScript = async ({ steps, onExhausted } = {}) => {
    assert(Array.isArray(steps) && steps.length > 0, "PROVIDER_SCRIPT_MISSING_STEPS");
    const body = { steps };
    if (onExhausted !== undefined) body.on_exhausted = onExhausted;
    const res = await fetchJson(`${handle.origin}/fixture/script`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      requestBody: JSON.stringify(body),
      timeoutMs: 5_000,
    });
    assert(res.status === 200, "PROVIDER_SCRIPT_REJECTED", String(res.status));
    return res.body;
  };
  return handle;
}

/**
 * Convenience: launch any subset of the remaining fixtures concurrently and
 * inject their ready payloads into `ctx.fixtures` keyed by fixture name.
 */
export async function launchFixtures({ workspace, wants }) {
  const handles = await Promise.all(wants.map((spec) => (typeof spec === "string" ? launchFixture({ workspace, name: spec }) : launchFixture({ workspace, ...spec }))));
  const byName = {};
  for (const handle of handles) {
    byName[handle.name] = handle;
    workspace.onCleanup(() => handle.stop());
  }
  return byName;
}
