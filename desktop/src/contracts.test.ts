import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RENDER_HTML_BYTES,
  asTransferableBytes,
  parseBackendMessage,
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
