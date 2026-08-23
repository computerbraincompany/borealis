import { setSession, streamAgentChat } from "@/lib/api";
import { SseJsonParser } from "@/lib/sse";

describe("SseJsonParser", () => {
  it("parses chunked CRLF events, ignores malformed payloads, and flushes the final event", () => {
    const events: unknown[] = [];
    const parser = new SseJsonParser((event) => events.push(event));

    parser.push('data: {"type":"run-started","run_id":"r1"}\r');
    parser.push("\n\r\ndata: not-json\n\ndata: {\n");
    parser.push('data: "type":"delta",\n');
    parser.push('data: "text":"hello"}\n\ndata: {"type":"message"}');
    parser.finish();

    expect(events).toEqual([
      { type: "run-started", run_id: "r1" },
      { type: "delta", text: "hello" },
      { type: "message" },
    ]);
  });
});

describe("streamAgentChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("clears an expired session and reports a typed 401", async () => {
    window.history.replaceState(null, "", "/login");
    setSession("expired", { id: "u1", email: "user@example.test" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(streamAgentChat("c1", "hello", () => undefined)).rejects.toEqual(
      expect.objectContaining({ status: 401 }),
    );
    expect(window.localStorage.getItem("borealis_token")).toBeNull();
    expect(window.localStorage.getItem("borealis_user")).toBeNull();
  });

  it("passes the abort signal through without converting AbortError", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), {
            once: true,
          });
        });
      }),
    );

    const request = streamAgentChat("c1", "hello", () => undefined, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
