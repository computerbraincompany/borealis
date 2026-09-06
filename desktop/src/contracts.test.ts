import assert from "node:assert/strict";
import test from "node:test";

import {
  FOLDER_PICKER_CANCELLED,
  MAX_RENDER_HTML_BYTES,
  asTransferableBytes,
  buildFolderGrantMessage,
  narrowFolderPickerResult,
  parseBackendMessage,
  parseMainMessage,
  rejectedRenderRequestId,
} from "./contracts.js";

const bootstrap = {
  token: "header.payload.signature",
  user: {
    id: "2dd99440-37ca-4a0b-adcf-9a50e9b6ba27",
    email: "local@borealis.invalid",
  },
};

test("accepts and narrows the backend ready contract", () => {
  assert.deepEqual(
    parseBackendMessage({
      type: "ready",
      port: 43_219,
      bootstrap,
      ignored: "not forwarded",
    }),
    { type: "ready", port: 43_219, bootstrap },
  );
});

test("rejects unsafe backend ready messages", () => {
  assert.equal(
    parseBackendMessage({ type: "ready", port: 0, bootstrap }),
    undefined,
  );
  assert.equal(
    parseBackendMessage({ type: "ready", port: 65_536, bootstrap }),
    undefined,
  );
  assert.equal(
    parseBackendMessage({
      type: "ready",
      port: 3000,
      bootstrap: { ...bootstrap, token: "" },
    }),
    undefined,
  );
  assert.equal(
    parseBackendMessage({ type: "ready", port: 3000, bootstrap: null }),
    undefined,
  );
});

test("accepts only bounded PNG and PDF render requests", () => {
  assert.deepEqual(
    parseBackendMessage({
      type: "render-request",
      request_id: "request_1",
      kind: "png",
      html: "<html></html>",
    }),
    {
      type: "render-request",
      request_id: "request_1",
      kind: "png",
      html: "<html></html>",
    },
  );
  assert.equal(
    parseBackendMessage({
      type: "render-request",
      request_id: "request 1",
      kind: "png",
      html: "<html></html>",
    }),
    undefined,
  );
  assert.equal(
    parseBackendMessage({
      type: "render-request",
      request_id: "request_1",
      kind: "svg",
      html: "<html></html>",
    }),
    undefined,
  );
  assert.equal(
    parseBackendMessage({
      type: "render-request",
      request_id: "request_1",
      kind: "pdf",
      html: "x".repeat(MAX_RENDER_HTML_BYTES + 1),
    }),
    undefined,
  );
});

test("recognizes a safe request id when a render payload must be rejected", () => {
  const invalid = {
    type: "render-request",
    request_id: "request_2",
    kind: "svg",
    html: "<svg></svg>",
  };
  assert.equal(parseBackendMessage(invalid), undefined);
  assert.equal(rejectedRenderRequestId(invalid), "request_2");
  assert.equal(
    rejectedRenderRequestId({ ...invalid, request_id: "unsafe id" }),
    undefined,
  );
  assert.equal(
    rejectedRenderRequestId({
      type: "render-request",
      request_id: "request_2",
      kind: "png",
      html: "<p>ok</p>",
    }),
    undefined,
  );
});

test("accepts stopped and sanitizes fatal messages", () => {
  assert.deepEqual(
    parseBackendMessage({ type: "stopped", details: "discarded" }),
    { type: "stopped" },
  );
  assert.deepEqual(
    parseBackendMessage({ type: "fatal", error_code: "STARTUP_FAILED" }),
    {
      type: "fatal",
      error_code: "STARTUP_FAILED",
    },
  );
  assert.deepEqual(
    parseBackendMessage({ type: "fatal", error_code: "secret value" }),
    { type: "fatal" },
  );
});

test("accepts only the fixed native-smoke success marker", () => {
  assert.deepEqual(
    parseBackendMessage({
      type: "native-smoke",
      ok: true,
      details: "discarded",
    }),
    {
      type: "native-smoke",
      ok: true,
    },
  );
  assert.equal(
    parseBackendMessage({ type: "native-smoke", ok: false }),
    undefined,
  );
  assert.equal(
    parseBackendMessage({ type: "native-smoke", ok: "true" }),
    undefined,
  );
});

test("copies render bytes into a plain transferable Uint8Array", () => {
  const source = Buffer.from([1, 2, 3]);
  const result = asTransferableBytes(source);
  source.fill(0);
  assert.deepEqual([...result], [1, 2, 3]);
  assert.equal(result.constructor, Uint8Array);
});

// ------------------------------------------------------- M14 folder chooser

const GRANT_ID = "a".repeat(64);

test("parseMainMessage recognizes shutdown and render responses", () => {
  assert.deepEqual(parseMainMessage({ type: "shutdown" }), {
    type: "shutdown",
  });
  assert.equal(parseMainMessage({ type: "shutdown", extra: "x" }), undefined);
  assert.deepEqual(
    parseMainMessage({ type: "render-response", request_id: "r1", ok: false }),
    {
      type: "render-response",
      request_id: "r1",
      ok: false,
    },
  );
  const okMessage = parseMainMessage({
    type: "render-response",
    request_id: "r1",
    ok: true,
    data: Uint8Array.from([1, 2, 3]),
  });
  assert.ok(
    okMessage && okMessage.type === "render-response" && okMessage.ok === true,
  );
  // A Node Buffer (which the transferable contract rejects) is not accepted.
  assert.equal(
    parseMainMessage({
      type: "render-response",
      request_id: "r1",
      ok: true,
      data: Buffer.from([1]),
    }),
    undefined,
  );
});

test("parseMainMessage narrows only the exact folder-grant handoff", () => {
  const valid = {
    type: "folder-grant",
    grant_id: GRANT_ID,
    root_path: "/Users/ada/notes",
    display_label: "notes",
  };
  assert.deepEqual(parseMainMessage(valid), valid);
  assert.deepEqual(
    parseMainMessage({ ...valid, unexpected: "discarded" }),
    undefined,
  );
  assert.equal(
    parseMainMessage({ ...valid, grant_id: "a".repeat(63) }),
    undefined,
  );
  assert.equal(
    parseMainMessage({ ...valid, grant_id: "a".repeat(65) }),
    undefined,
  );
  assert.equal(
    parseMainMessage({ ...valid, root_path: "notes/relative" }),
    undefined,
  );
  assert.equal(
    parseMainMessage({ ...valid, root_path: "/" + "x".repeat(5_000) }),
    undefined,
  );
  assert.equal(
    parseMainMessage({ ...valid, root_path: "/Users/ada\nnotes" }),
    undefined,
  );
  assert.equal(parseMainMessage({ ...valid, display_label: "" }), undefined);
  assert.equal(parseMainMessage({ type: "unknown" }), undefined);
});

test("buildFolderGrantMessage enforces the bounded handoff contract", () => {
  assert.deepEqual(
    buildFolderGrantMessage({
      grantId: GRANT_ID,
      rootPath: "/tmp/x",
      label: "x",
    }),
    {
      type: "folder-grant",
      grant_id: GRANT_ID,
      root_path: "/tmp/x",
      display_label: "x",
    },
  );
  assert.throws(() =>
    buildFolderGrantMessage({ grantId: "zz", rootPath: "/tmp/x", label: "x" }),
  );
  assert.throws(() =>
    buildFolderGrantMessage({
      grantId: GRANT_ID,
      rootPath: "relative",
      label: "x",
    }),
  );
  assert.throws(() =>
    buildFolderGrantMessage({
      grantId: GRANT_ID,
      rootPath: "/tmp/x",
      label: "\r\n",
    }),
  );
});

test("the picker result carries only the opaque grant, label, and preview", () => {
  const ok = narrowFolderPickerResult({
    grantId: GRANT_ID,
    label: "notes",
    entries: 12,
    truncated: false,
  });
  assert.deepEqual(ok, {
    cancelled: false,
    grant_id: GRANT_ID,
    label: "notes",
    preview: { entry_count: 12, truncated: false },
  });
  assert.equal(
    narrowFolderPickerResult({
      grantId: "nope",
      label: "n",
      entries: 1,
      truncated: false,
    }),
    FOLDER_PICKER_CANCELLED,
  );
  assert.equal(
    narrowFolderPickerResult({
      grantId: GRANT_ID,
      label: "x".repeat(200),
      entries: 1,
      truncated: false,
    }),
    FOLDER_PICKER_CANCELLED,
  );
  const bounded = narrowFolderPickerResult({
    grantId: GRANT_ID,
    label: "n",
    entries: 501,
    truncated: true,
  });
  assert.ok(
    !bounded.cancelled &&
      bounded.preview.entry_count === 500 &&
      bounded.preview.truncated,
  );
  assert.deepEqual(FOLDER_PICKER_CANCELLED, { cancelled: true });
});
