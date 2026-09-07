import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

async function fixture(t) {
  const child = spawn(
    process.execPath,
    [new URL("./openai-provider.mjs", import.meta.url).pathname],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      assert.equal(stderrBytes, 0);
    } finally {
      clearTimeout(timeout);
      lines.close();
    }
  };
  t.after(stop);
  const [line] = await once(lines, "line");
  const { origin } = JSON.parse(line);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const control = (body) =>
    fetch(`${origin}/fixture/embedding-delay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const state = async () => (await fetch(`${origin}/fixture/state`)).json();
  const embedding = (signal) =>
    fetch(`${origin}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "synthetic held embedding",
        encoding_format: "float",
      }),
      signal,
    }).then(
      async (response) => ({
        status: response.status,
        body: await response.json(),
      }),
      (error) => ({ error }),
    );
  const until = async (predicate) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const value = await state();
      if (predicate(value)) return value;
      await delay(5);
    }
    assert.fail("fixture state did not reach expected condition");
  };
  return { control, state, embedding, until, stop };
}

test(
  "explicit embedding hold validates control and releases all requests only on command",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    for (const invalid of [
      null,
      [],
      {},
      { embedding_hold: "true" },
      { embedding_hold: true, extra: 1 },
      { embedding_hold: true, hold_timeout_ms: 0 },
      { embedding_hold: true, hold_timeout_ms: 30001 },
      { embedding_hold: true, hold_timeout_ms: 1.5 },
      { embedding_hold: false, hold_timeout_ms: 10 },
      { hold_timeout_ms: 500 },
      { delay_ms: -1 },
      { delay_ms: 10001 },
    ]) {
      assert.equal((await f.control(invalid)).status, 400);
    }
    assert.equal((await f.control({ delay_ms: 8000 })).status, 200);
    assert.equal(
      (await f.control({ delay_ms: 0, embedding_hold: true })).status,
      200,
    );
    let completed = false;
    const pending = Promise.all([f.embedding(), f.embedding()]).then(
      (result) => {
        completed = true;
        return result;
      },
    );
    await f.until((s) => s.embedding_active === 2 && s.embedding_held === 2);
    await delay(40);
    assert.equal(completed, false);
    assert.equal((await f.state()).embedding_hold, true);
    assert.equal((await f.control({ embedding_hold: false })).status, 200);
    for (const response of await pending) {
      assert.equal(response.status, 200);
      assert.equal(response.body.data[0].embedding.length, 64);
    }
    await f.until(
      (s) =>
        s.embedding_active === 0 && s.embedding_held === 0 && !s.embedding_hold,
    );
    assert.equal((await f.embedding()).status, 200);
    assert.equal((await f.state()).embedding_hold_expired, 0);
  },
);

test(
  "client abort and rearm remove holders without an accidental successful response",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.control({ embedding_hold: true });
    const controller = new AbortController();
    const aborted = f.embedding(controller.signal);
    await f.until((s) => s.embedding_active === 1 && s.embedding_held === 1);
    controller.abort();
    assert.equal((await aborted).error?.name, "AbortError");
    await f.until((s) => s.embedding_active === 0 && s.embedding_held === 0);
    const previous = f.embedding();
    await f.until((s) => s.embedding_held === 1);
    await f.control({ embedding_hold: true });
    const reset = await previous;
    assert.equal(reset.status, 503);
    assert.equal(reset.body.error.code, "FIXTURE_EMBEDDING_HOLD_REARMED");
    await f.until(
      (s) =>
        s.embedding_active === 0 && s.embedding_held === 0 && s.embedding_hold,
    );
    const next = f.embedding();
    await f.until((s) => s.embedding_held === 1);
    await f.control({ embedding_hold: false });
    assert.equal((await next).status, 200);
    await f.until((s) => s.embedding_active === 0 && s.embedding_held === 0);
  },
);

test(
  "hold deadline fails explicitly and remains observable after release",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal(
      (await f.control({ embedding_hold: true, hold_timeout_ms: 500 })).status,
      200,
    );
    const pending = f.embedding();
    await f.until((s) => s.embedding_held === 1);
    const failed = await pending;
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, "FIXTURE_EMBEDDING_HOLD_TIMEOUT");
    assert.equal(failed.body.data, undefined);
    await f.until(
      (s) =>
        s.embedding_active === 0 &&
        s.embedding_held === 0 &&
        s.embedding_hold_expired === 1,
    );
    await f.control({ embedding_hold: false });
    assert.equal((await f.embedding()).status, 200);
    assert.equal((await f.state()).embedding_hold_expired, 1);
  },
);

test(
  "SIGTERM closes held sockets and exits cleanly without waiting for hold deadlines",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.control({ embedding_hold: true, hold_timeout_ms: 30000 });
    const pending = f.embedding();
    await f.until((s) => s.embedding_active === 1 && s.embedding_held === 1);
    await f.stop();
    assert.ok((await pending).error);
  },
);
