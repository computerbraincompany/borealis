import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeElectronRenderPort,
  configureElectronRenderPort,
  requestElectronRender,
  type ElectronParentPort,
} from "../electronRender.js";

class FakeParentPort extends EventEmitter implements ElectronParentPort {
  readonly sent: unknown[] = [];
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
}

function renderRequest(port: FakeParentPort, index = 0) {
  return port.sent[index] as {
    type: string;
    request_id: string;
    kind: string;
    html: string;
  };
}

beforeEach(() => closeElectronRenderPort());
afterEach(() => {
  closeElectronRenderPort();
  vi.useRealTimers();
});

describe("Electron utility-process render broker", () => {
  it("fails closed when no authenticated parent channel is attached", async () => {
    await expect(requestElectronRender("png", "<html></html>")).rejects.toThrow("Electron rendering failed");
  });

  it("sends a correlated request and accepts MessageEvent-shaped replies", async () => {
    const port = new FakeParentPort();
    configureElectronRenderPort(port);

    const pngPending = requestElectronRender("png", "<html>chart</html>");
    const pngRequest = renderRequest(port);
    expect(pngRequest).toMatchObject({ type: "render-request", kind: "png", html: "<html>chart</html>" });
    expect(pngRequest.request_id).toMatch(/^[0-9a-f-]{36}$/i);
    port.emit("message", {
      data: {
        type: "render-response",
        request_id: pngRequest.request_id,
        ok: true,
        data: new Uint8Array([1, 2, 3]),
      },
    });
    await expect(pngPending).resolves.toEqual(Buffer.from([1, 2, 3]));

    const pdfPending = requestElectronRender("pdf", "<html>report</html>");
    const pdfRequest = renderRequest(port, 1);
    port.emit("message", {
      data: {
        type: "render-response",
        request_id: pdfRequest.request_id,
        ok: true,
        data: new Uint8Array(Buffer.from("%PDF-1.7")),
      },
    });
    await expect(pdfPending).resolves.toEqual(Buffer.from("%PDF-1.7"));
  });

  it("ignores malformed and uncorrelated messages, then rejects opaque failures", async () => {
    const port = new FakeParentPort();
    configureElectronRenderPort(port);
    const pending = requestElectronRender("png", "safe");
    const request = renderRequest(port);

    port.emit("message", null);
    port.emit("message", {
      data: { type: "render-response", request_id: "other", ok: true, data: new Uint8Array([1]) },
    });
    port.emit("message", {
      data: { type: "render-response", request_id: request.request_id, ok: true, data: "not-bytes" },
    });
    await expect(pending).rejects.toThrow("Electron rendering failed");
  });

  it("preserves AbortError before and during a render without accepting a late reply", async () => {
    const port = new FakeParentPort();
    configureElectronRenderPort(port);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(requestElectronRender("png", "unused", alreadyAborted.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(port.sent).toEqual([]);

    const controller = new AbortController();
    const pending = requestElectronRender("pdf", "report", controller.signal);
    const request = renderRequest(port);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    port.emit("message", {
      type: "render-response",
      request_id: request.request_id,
      ok: true,
      data: new Uint8Array([9]),
    });
  });

  it("rejects every in-flight render when the port closes or is replaced", async () => {
    const first = new FakeParentPort();
    const second = new FakeParentPort();
    configureElectronRenderPort(first);
    const closed = requestElectronRender("png", "first");
    closeElectronRenderPort();
    await expect(closed).rejects.toThrow("Electron rendering failed");

    configureElectronRenderPort(first);
    const replaced = requestElectronRender("pdf", "second");
    configureElectronRenderPort(second);
    await expect(replaced).rejects.toThrow("Electron rendering failed");
    expect(first.listenerCount("message")).toBe(0);
    expect(second.listenerCount("message")).toBe(1);
  });

  it("times out with an opaque error and removes the pending correlation", async () => {
    vi.useFakeTimers();
    const port = new FakeParentPort();
    configureElectronRenderPort(port);
    const pending = requestElectronRender("png", "slow");
    const request = renderRequest(port);
    const rejected = expect(pending).rejects.toThrow("Electron rendering failed");
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;

    port.emit("message", {
      type: "render-response",
      request_id: request.request_id,
      ok: true,
      data: new Uint8Array([1]),
    });
  });
});
