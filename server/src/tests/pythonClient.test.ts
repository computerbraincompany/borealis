import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { boundedRequestSignal, py, PythonServiceError } from "../pythonClient.js";
import { runWithRequestContext } from "../requestContext.js";

afterEach(() => vi.unstubAllGlobals());

describe("Python service boundary", () => {
  it("authenticates every non-health request and propagates a correlation id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await py.listDatasets("account-1");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${config.pythonServiceToken}`,
      "X-Request-ID": expect.stringMatching(/^[A-Za-z0-9._-]{1,128}$/),
    });
  });

  it("propagates the exact normalized request id from Node to Python", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runWithRequestContext("request.from-node_42", () => py.listDatasetSummaries("account-1"));

    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      "X-Request-ID": "request.from-node_42",
    });
    expect(fetchMock.mock.calls[0][0]).toContain("view=summary");
  });

  it("keeps health public", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(py.health()).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it("does not copy Python traceback or response details into errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"detail":"secret traceback /private/path"}', { status: 500 }))
    );

    const error = await py.query("account", "SELECT 1", []).catch((value) => value);
    expect(error).toBeInstanceOf(PythonServiceError);
    expect(String(error)).not.toContain("traceback");
    expect(String(error)).not.toContain("/private/path");
  });

  it("composes caller cancellation with a total request timeout", async () => {
    const caller = new AbortController();
    const cancelled = boundedRequestSignal(caller.signal, 10_000);
    caller.abort();
    expect(cancelled.aborted).toBe(true);

    const timedOut = boundedRequestSignal(undefined, 5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(timedOut.aborted).toBe(true);
  });

  it("preserves caller cancellation as AbortError across the Python boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
        });
      })
    );
    const controller = new AbortController();
    const pending = py.query("account", "SELECT 1", [], controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
