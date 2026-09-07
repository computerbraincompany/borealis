import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  checkNativeState,
  validateNativeResponse,
  nativePublicationFile,
  validateNativeWatchedQuit,
} from "./nativeDesktop.mjs";

const request = {
  nonce: "run-nonce",
  checkpoint: "D.watch",
  pid: 42,
  profile: "/private/tmp/owned-profile",
  package_sha256: "package-hash",
};
const response = {
  ...request,
  status: "pass",
  driver: "cua_repl",
  observations: [
    "Native source inspector shows the changed synthetic fixture after watch refresh.",
  ],
};

test("normal native quit requires a recently active scheduled watch and finalized stopped ledger", () => {
  const observation = { id: "owned-refresh", observedAt: 10_000 };
  const finalState = {
    id: "owned-refresh",
    requested_by: "scheduled",
    watch_enabled: 1,
    status: "cancelled",
    finished_at: "2026-09-07T15:00:00.000Z",
    active_refreshes: 0,
  };
  validateNativeWatchedQuit(observation, finalState, 12_000);
  assert.throws(
    () => validateNativeWatchedQuit(undefined, finalState, 12_000),
    /NOT_OBSERVED/,
  );
  for (const change of [
    { id: "other" },
    { requested_by: "manual" },
    { watch_enabled: 0 },
    { status: "active" },
    { status: "completed" },
    { finished_at: null },
    { active_refreshes: 1 },
  ])
    assert.throws(
      () =>
        validateNativeWatchedQuit(
          observation,
          { ...finalState, ...change },
          11_000,
        ),
      /NOT_FINALIZED/,
    );
  assert.throws(
    () => validateNativeWatchedQuit(observation, finalState, 41_000),
    /NOT_OBSERVED/,
  );
});

test(
  "fixture embedding delay exposes actual in-flight work and abort releases it",
  { timeout: 10_000 },
  async () => {
    const child = spawn(
      process.execPath,
      [new URL("../fixtures/openai-provider.mjs", import.meta.url).pathname],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const lines = createInterface({ input: child.stdout });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      const line = await new Promise((resolve) => lines.once("line", resolve));
      const { origin } = JSON.parse(line);
      const configure = (delay_ms) =>
        fetch(`${origin}/fixture/embedding-delay`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ delay_ms }),
        });
      assert.equal((await configure(-1)).status, 400);
      assert.equal((await configure(10_001)).status, 400);
      assert.equal((await configure(8000)).status, 200);
      const controller = new AbortController();
      const pending = fetch(`${origin}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "synthetic delay fixture" }),
        signal: controller.signal,
      }).catch((error) => error);
      const until = async (expected) => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const state = await (await fetch(`${origin}/fixture/state`)).json();
          if (state.embedding_active === expected) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail("embedding counter did not reach expected state");
      };
      await until(1);
      controller.abort();
      await pending;
      await until(0);
      assert.equal((await configure(0)).status, 200);
      const response = await fetch(`${origin}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "synthetic zero delay" }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.length, 1);
    } finally {
      lines.close();
      child.kill("SIGTERM");
      await exited;
    }
  },
);

test("native observations cannot be replayed across checkpoints, processes, profiles or packages", () => {
  validateNativeResponse(response, request);
  for (const key of [
    "nonce",
    "checkpoint",
    "pid",
    "profile",
    "package_sha256",
  ]) {
    assert.throws(
      () =>
        validateNativeResponse({ ...response, [key]: "different" }, request),
      /NATIVE_RESPONSE_IDENTITY_MISMATCH/,
    );
  }
});

test("native driver refusal and missing observations cannot count as a pass", () => {
  assert.throws(
    () => validateNativeResponse({ ...response, status: "blocked" }, request),
    /NATIVE_DRIVER_BLOCKED/,
  );
  assert.throws(
    () => validateNativeResponse({ ...response, observations: [] }, request),
    /NATIVE_RESPONSE_OBSERVATIONS_MISSING/,
  );
  assert.throws(
    () => validateNativeResponse({ ...response, driver: "" }, request),
    /NATIVE_RESPONSE_DRIVER_MISSING/,
  );
});

test("watch acceptance requires changed fixture content, not merely completed rescans", () => {
  assert.throws(
    () =>
      checkNativeState(
        "D.watch",
        { refreshes: 20, folder_changed: 0 },
        { refreshes: 1 },
      ),
    /NATIVE_STATE_UNVERIFIED/,
  );
  assert.throws(
    () =>
      checkNativeState(
        "D.watch",
        { refreshes: 1, folder_changed: 1 },
        { refreshes: 1 },
      ),
    /NATIVE_STATE_UNVERIFIED/,
  );
  checkNativeState(
    "D.watch",
    { refreshes: 2, folder_changed: 1 },
    { refreshes: 1 },
  );
});

test("native transports require OS custody and native reruns require a new result", () => {
  assert.throws(
    () =>
      checkNativeState(
        "A.connections",
        { stdio: 1, http: 1, custody: true, browser_custody_absent: false },
        {},
      ),
    /NATIVE_STATE_UNVERIFIED/,
  );
  assert.throws(
    () =>
      checkNativeState(
        "B.analysis",
        { analysis_runs: 2 },
        { analysis_runs: 2 },
      ),
    /NATIVE_STATE_UNVERIFIED/,
  );
  assert.throws(
    () => checkNativeState("unknown", {}, {}),
    /NATIVE_STATE_UNVERIFIED/,
  );
});

test("research rerun must inherit the corrected value and original-run provenance", () => {
  assert.throws(
    () =>
      checkNativeState(
        "E.rerun",
        { research_runs: 2, corrections: 99, inherited_corrections: 0 },
        { research_runs: 1, inherited_corrections: 0 },
      ),
    /NATIVE_STATE_UNVERIFIED/,
  );
  checkNativeState(
    "E.rerun",
    { research_runs: 2, corrections: 2, inherited_corrections: 1 },
    { research_runs: 1, inherited_corrections: 0 },
  );
});

test("publication reads reject symlinked account paths and another document namespace", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "borealis-native-path-test-")),
  );
  const account = "11111111-1111-4111-8111-111111111111";
  const document = "22222222-2222-4222-8222-222222222222";
  const attempt = "33333333-3333-4333-8333-333333333333";
  const dir = path.join(
    root,
    "reports",
    "documents",
    account,
    document,
    attempt,
  );
  const row = {
    account_id: account,
    document_id: document,
    html_path: path.join(dir, "document.html"),
    pdf_path: path.join(dir, "document.pdf"),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(row.html_path, "<!doctype html><p>synthetic</p>");
    assert.equal(nativePublicationFile(root, row, "html"), row.html_path);
    assert.throws(
      () =>
        nativePublicationFile(root, { ...row, document_id: attempt }, "html"),
      /NATIVE_PUBLICATION_PATH_INVALID/,
    );
    const accountDir = path.join(root, "reports", "documents", account);
    fs.renameSync(accountDir, path.join(root, "other-account"));
    fs.symlinkSync(path.join(root, "other-account"), accountDir);
    assert.throws(
      () => nativePublicationFile(root, row, "html"),
      /NATIVE_PUBLICATION_DIRECTORY_UNSAFE/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
