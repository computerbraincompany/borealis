import {
  ApiError,
  apiText,
  chatsApi,
  connectorsApi,
  formatApiError,
  openProtected,
  parseConnectorListPayload,
  streamAgentChat,
} from "@/lib/api";

describe("typed API contracts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends explicit connector identity fields without hiding the table in config", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "connector-1",
          name: "Ledger",
          type: "url_csv",
          config: JSON.stringify({ url: "https://example.test/data.csv" }),
          target_table: "ledger",
          sync_status: "indexing",
          last_sync: null,
          created_at: "2026-01-01T00:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await connectorsApi.create({
      display_name: "Ledger",
      target_table: "ledger",
      type: "url_csv",
      config: { url: "https://example.test/data.csv" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      display_name: "Ledger",
      target_table: "ledger",
      type: "url_csv",
      config: { url: "https://example.test/data.csv" },
    });
  });

  it("encodes the optional older-message cursor while leaving the default URL unchanged", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ messages: [], sources: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await chatsApi.get("chat-1");
    await chatsApi.get("chat-1", { beforeMessageId: "42", limit: 50 });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/chats/chat-1");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/chats/chat-1?before_message_id=42&limit=50");
  });

  it.each([
    ["text", () => apiText("/api/reports/report-1/html")],
    ["json", () => connectorsApi.list()],
    ["sse", () => streamAgentChat("chat-1", "hello", vi.fn())],
  ])("retains structured errors and safe request references for %s requests", async (_kind, request) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "temporarily unavailable", request_id: "body-reference" }), {
          status: 503,
          headers: { "content-type": "application/json", "x-request-id": "header-reference" },
        }),
      ),
    );

    const failure = await request().catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 503,
      message: "temporarily unavailable",
      requestId: "header-reference",
      data: { error: "temporarily unavailable", request_id: "body-reference" },
    });
    expect(formatApiError(failure, "fallback")).toBe("temporarily unavailable (reference: header-reference)");
  });

  it("does not render an unvalidated request reference", () => {
    const failure = new ApiError(500, "internal server error", undefined, "<script>alert(1)</script>");
    expect(formatApiError(failure, "fallback")).toBe("internal server error");
    expect(formatApiError(new Error("secret provider trace"), "fallback")).toBe("fallback");
  });

  it("mounts report HTML only inside an opaque sandboxed preview", async () => {
    const reportHtml = '<script>window.parent.localStorage.getItem("borealis_token")</script>';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(reportHtml, { status: 200, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);

    const popupDocument = document.implementation.createHTMLDocument("");
    const close = vi.fn();
    const popup = {
      closed: false,
      close,
      document: popupDocument,
      opener: window,
    } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);

    await openProtected("html", "/api/reports/report-1/html", "Report.html");

    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(popup.opener).toBeNull();
    expect(popupDocument.body.children).toHaveLength(1);
    expect(popupDocument.querySelector("script")).toBeNull();
    const frame = popupDocument.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.hasAttribute("allow-same-origin")).toBe(false);
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.srcdoc).toBe(reportHtml);
    expect(close).not.toHaveBeenCalled();
  });

  it("normalizes connector JSONB and rejects statuses outside the canonical state machine", () => {
    const base = {
      id: "connector-1",
      name: "Ledger",
      type: "url_csv",
      config: JSON.stringify({ url: "https://example.test/data.csv" }),
      target_table: "ledger",
      last_sync: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(
      parseConnectorListPayload([
        { ...base, sync_status: "idle" },
        { ...base, id: "invalid", sync_status: "ready" },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "connector-1",
        config: { url: "https://example.test/data.csv" },
        sync_status: "idle",
      }),
    ]);
  });
});
