import assert from "node:assert/strict";
import test from "node:test";

import {
  appOrigin,
  hasPdfMagic,
  hasPngMagic,
  isAllowedPreviewWindowUrl,
  isAllowedRenderResourceUrl,
  isTrustedAppUrl,
} from "./policies.js";

test("the application origin is exact loopback and rejects arbitrary navigation", () => {
  const origin = appOrigin(41_337);
  assert.equal(origin, "http://127.0.0.1:41337");
  assert.equal(
    isTrustedAppUrl(`${origin}/chat/one?tab=files#latest`, origin),
    true,
  );
  assert.equal(isTrustedAppUrl("http://localhost:41337/", origin), false);
  assert.equal(isTrustedAppUrl("http://127.0.0.1:41338/", origin), false);
  assert.equal(isTrustedAppUrl("https://127.0.0.1:41337/", origin), false);
  assert.equal(isTrustedAppUrl(`http://user@127.0.0.1:41337/`, origin), false);
  assert.equal(isTrustedAppUrl("file:///tmp/report.html", origin), false);
  assert.equal(isTrustedAppUrl("about:blank", origin), false);
  assert.throws(() => appOrigin(0));
});

test("preview window policy permits only exact about:blank", () => {
  assert.equal(isAllowedPreviewWindowUrl("about:blank"), true);
  assert.equal(isAllowedPreviewWindowUrl("about:blank#fragment"), false);
  assert.equal(isAllowedPreviewWindowUrl("blob:http://127.0.0.1/value"), false);
  assert.equal(isAllowedPreviewWindowUrl("https://example.test/report"), false);
});

test("hidden renderer denies network and file loads", () => {
  const denied = [
    "http://127.0.0.1:3000/report",
    "https://example.test/image.png",
    "file:///etc/passwd",
    "ws://127.0.0.1/socket",
    "wss://example.test/socket",
    "data:text/html,hello",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "blob:null/value",
    "about:srcdoc",
  ];
  assert.equal(isAllowedRenderResourceUrl("about:blank"), true);
  assert.equal(
    isAllowedRenderResourceUrl("data:image/png;base64,iVBORw0KGgo="),
    true,
  );
  for (const url of denied)
    assert.equal(isAllowedRenderResourceUrl(url), false, url);
});

test("render magic validation is exact", () => {
  assert.equal(hasPdfMagic(Buffer.from("%PDF-1.7\n")), true);
  assert.equal(hasPdfMagic(Buffer.from("PDF-1.7\n")), false);
  assert.equal(
    hasPngMagic(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    ),
    true,
  );
  assert.equal(hasPngMagic(Buffer.from("not a png")), false);
});
