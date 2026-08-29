import {
  ApiError,
  apiText,
  chatsApi,
  connectorsApi,
  formatApiError,
  openProtected,
  parseConnectorListPayload,
  parseConnectorSyncListPayload,
  parseSourceListPayload,
  settingsApi,
  streamAgentChat,
  type SourceScopeInput,
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

  it("uses the redacted provider-settings contract and serializes draft probes without adding a key", async () => {
    const settings = {
      llm_base_url: "http://127.0.0.1:1234",
      llm_api_key_configured: true,
      lm_studio_base_url: null,
      default_chat_model: "qwen-chat",
      default_embed_model: "nomic-embed",
      managed_by_env: {
        llm_base_url: false,
        llm_api_key: false,
        lm_studio_base_url: false,
        default_chat_model: false,
        default_embed_model: false,
      },
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(settings))
      .mockResolvedValueOnce(json({ ...settings, default_chat_model: "analysis-large" }))
      .mockResolvedValueOnce(json({ ok: true, latency_ms: 12 }));
    vi.stubGlobal("fetch", fetchMock);

    await settingsApi.get();
    await settingsApi.update({ default_chat_model: "analysis-large" });
    await settingsApi.testConnection({
      llm_base_url: "https://models.example.test",
      default_chat_model: "analysis-large",
      default_embed_model: "nomic-embed",
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/settings");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/settings");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ default_chat_model: "analysis-large" }),
    });
    expect(fetchMock.mock.calls[2][0]).toBe("/api/settings/test");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toEqual({
      llm_base_url: "https://models.example.test",
      default_chat_model: "analysis-large",
      default_embed_model: "nomic-embed",
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

  const chatCreateCases: Array<[string, string | undefined, SourceScopeInput | undefined, Record<string, unknown>]> = [
    ["the selected-empty default", undefined, undefined, { source_mode: "selected", source_ids: [] }],
    ["an all-sources scope", "All data", { source_mode: "all" }, { title: "All data", source_mode: "all" }],
    [
      "an explicit selected-source scope",
      undefined,
      { source_mode: "selected", source_ids: ["11111111-1111-4111-8111-111111111111"] },
      { source_mode: "selected", source_ids: ["11111111-1111-4111-8111-111111111111"] },
    ],
  ];

  it.each(chatCreateCases)("serializes %s exactly when creating a chat", async (_label, title, scope, expectedBody) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    if (scope === undefined) {
      await chatsApi.create();
    } else {
      await chatsApi.create(title, scope);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/chats");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(expectedBody);
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

  it("bounds structured source failure details from the catalog", () => {
    const [source] = parseSourceListPayload([
      {
        id: "source-1",
        name: "ledger",
        display_name: "Ledger.csv",
        kind: "tabular",
        status: "error",
        mime: "text/csv",
        created_at: "2026-08-25T21:34:12.000Z",
        meta: {
          error: "The embedding service was unavailable.",
          error_code: "EMBEDDING_UNAVAILABLE",
          error_detail: "x".repeat(800),
          error_stage: "embedding",
        },
        ingestion: { attempts: 3.9, updated_at: "2026-08-25T21:34:47.000Z" },
      },
    ]);

    expect(source.meta).toEqual({
      error: "The embedding service was unavailable.",
      error_code: "EMBEDDING_UNAVAILABLE",
      error_detail: "x".repeat(500),
      error_stage: "embedding",
    });
    expect(source.ingestion).toEqual({ attempts: 3, updated_at: "2026-08-25T21:34:47.000Z" });
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

    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
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

  it("parses the derived schedule surface and degrades malformed schedules to unscheduled", () => {
    const base = {
      id: "connector-1",
      name: "Ledger",
      type: "url_csv",
      config: { url: "https://example.test/data.csv" },
      target_table: "ledger",
      sync_status: "idle",
      last_sync: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const rows = parseConnectorListPayload([
      {
        ...base,
        schedule: {
          automation_id: "auto-1",
          schedule_minutes: 60,
          state: "active",
          next_run_at: "2026-01-02T00:00:00Z",
          last_run_at: "2026-01-01T12:00:00Z",
        },
      },
      { ...base, id: "broken", schedule: { automation_id: "auto-2", schedule_minutes: -5, state: "active" } },
      { ...base, id: "unscheduled", schedule: null },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0].schedule).toEqual({
      automation_id: "auto-1",
      schedule_minutes: 60,
      state: "active",
      next_run_at: "2026-01-02T00:00:00Z",
      last_run_at: "2026-01-01T12:00:00Z",
    });
    expect(rows[1].schedule).toBeNull();
    expect(rows[2].schedule).toBeNull();
  });

  it("schedules a connector through the contract route and removes it with null", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "connector-1",
            name: "Ledger",
            type: "url_csv",
            config: { url: "https://example.test/data.csv" },
            target_table: "ledger",
            sync_status: "idle",
            last_sync: null,
            created_at: "2026-01-01T00:00:00Z",
            schedule: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await connectorsApi.updateConnectorSchedule("connector-1", 360);
    expect(updated?.schedule).toBeNull();

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/connectors/connector-1/schedule");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ schedule_minutes: 360 });

    await connectorsApi.updateConnectorSchedule("connector-1", null);
    const [, removeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(removeInit.body))).toEqual({ schedule_minutes: null });
  });

  it("loads bounded sync history and drops rows outside the recorded trigger/outcome contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          syncs: [
            {
              id: 2,
              trigger: "scheduled",
              outcome: "skipped",
              detail: "the connector is already transitioning",
              started_at: "2026-01-02T00:00:00Z",
              finished_at: "2026-01-02T00:00:01Z",
            },
            { id: 3, trigger: "cron", outcome: "succeeded", detail: null, started_at: "2026-01-03T00:00:00Z" },
            { id: "bad", trigger: "manual", outcome: "failed", detail: null, started_at: "2026-01-04T00:00:00Z" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const syncs = await connectorsApi.listConnectorSyncs("connector-1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/connectors/connector-1/syncs?limit=50");
    expect(syncs).toEqual([
      {
        id: 2,
        trigger: "scheduled",
        outcome: "skipped",
        detail: "the connector is already transitioning",
        started_at: "2026-01-02T00:00:00Z",
        finished_at: "2026-01-02T00:00:01Z",
      },
    ]);
    expect(parseConnectorSyncListPayload({ syncs: [] })).toEqual([]);
  });
});
