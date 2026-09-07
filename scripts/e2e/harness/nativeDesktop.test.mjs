import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkNativeState,
  validateNativeResponse,
  nativePublicationFile,
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
