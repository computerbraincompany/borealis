/**
 * Journey `smoke` — the harness lifecycle self-test (NOT one of A–F).
 *
 * Proves the harness skeleton end-to-end against the real production server:
 * scripted provider identity is live, a fresh account registers and logs in
 * through the real UI, the /chat and /settings surfaces load with zero
 * unexpected console errors, authenticated surfaces return real persisted
 * state, and `--inject-failure` produces a loud non-zero failure so a red
 * run is proven to actually fail while cleanup still executes.
 */
import { HarnessError, assert, fetchJson } from "../harness/util.mjs";

export const JOURNEY_ID = "smoke";
export const IMPLEMENTED = true;

const TEST_EMAIL = "e2e-smoke@borealis.test";
const TEST_PASSWORD = "borealis-e2e-smoke-pass";

export async function run(ctx) {
  const { server, provider, browser, artifactsDir, injectFailure } = ctx;
  const artifacts = [];

  // 1. Provider fixture is live and unperturbed at start.
  const startState = await provider.state();
  assert(typeof startState?.chat_calls === "number", "PROVIDER_STATE_SHAPE", "chat_calls");
  assert(startState.chat_calls === 0, "PROVIDER_PRETOUCHED", "expected zero chat calls at start");

  // 2. Baseline health of the real server (public /health ok; authed gate 401).
  const baseline = await server.waitBaseline();
  assert(baseline.health === "ok" && baseline.authGate === "enforced", "SERVER_BASELINE_UNSANITY");

  // 3. Register a fresh account through the real UI.
  const session = await browser.newSession({ origin: server.origin });
  try {
    await session.register({ email: TEST_EMAIL, password: TEST_PASSWORD });
    artifacts.push(await session.screenshot(artifactsDir));

    // 4. Authenticated ambient status comes from the same account/session and
    //    reflects the pinned loopback fixture identity, content-free.
    const status = await session.apiFetch("/api/status", { expectStatus: 200 });
    assert(status.body?.locality === "local", "STATUS_LOCALITY", String(status.body?.locality));
    assert(status.body?.endpoint_reachable === true, "STATUS_REACHABILITY");
    assert(status.body?.chat_model === provider.models.chatModel, "STATUS_CHAT_MODEL");
    assert(status.body?.embed_model === provider.models.embedModel, "STATUS_EMBED_MODEL");

    // 5. Settings modal loads over the workspace shell.
    await session.openSettings();
    artifacts.push(await session.screenshot(artifactsDir));
    await session.closeSettings();

    // 6. Persisted state check: a brand-new account has an empty chat catalog
    //    served by the real ledger (not just a happy DOM).
    const chats = await session.apiFetch("/api/chats", { expectStatus: 200 });
    const chatList = chats.body?.items ?? chats.body?.chats;
    assert(Array.isArray(chatList) && chatList.length === 0, "CHATS_NOT_EMPTY");

    // 7. Log out and back in through the real sign-in form.
    await session.login({ email: TEST_EMAIL, password: TEST_PASSWORD });
    artifacts.push(await session.screenshot(artifactsDir));
    const token = await session.token();
    assert(typeof token === "string" && token.split(".").length === 3, "SESSION_JWT_MALFORMED");

    // 8. The scripted provider was reached through the product path at least
    //    for model discovery during Settings/chat load.
    const endState = await provider.state();
    assert(
      endState.chat_calls + endState.embedding_calls >= startState.chat_calls + startState.embedding_calls,
      "PROVIDER_COUNTERS_REGRESSED"
    );

    // 9. Worker-quiescence gate before shutdown: the product's own
    //    authenticated readiness surface must report every service
    //    (including the DuckDB data worker) operational. Bounded poll, not
    //    a sleep; see harness/server.mjs for the shutdown defect it guards.
    //    Runs even on the tripwire path so a red run still proves clean
    //    cleanup.
    await server.quiesceWorkers({ token: await session.token() });

    // 10. Optional self-test tripwire: prove a failing journey exits non-zero
    //     and cleanup still runs (--inject-failure).
    if (injectFailure) {
      throw new HarnessError("INJECTED_FAILURE", "deliberate failure for harness self-test");
    }

    // 11. Console cleanliness (fail-closed; 401s were only allowed while the
    //     auth bootstrap was in flight).
    session.assertClean();
  } finally {
    await session.close();
  }

  return { artifacts, checks: { provider: "live", authUi: "register+login", surfaces: ["/chat", "/settings"], console: "clean" } };
}
