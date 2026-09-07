import {
  ApiError,
  api,
  setSession,
  getUser,
  apiText,
  agentsApi,
  automationsApi,
  chatsApi,
  connectorsApi,
  formatApiError,
  knowledgeApi,
  librariesApi,
  modelsApi,
  openProtected,
  parseConnectorListPayload,
  parseConnectorSyncListPayload,
  parseSourceListPayload,
  preferencesApi,
  reportsApi,
  researchActiveRunId,
  researchApi,
  researchUnreadySourceIds,
  settingsApi,
  sourcesApi,
  streamAgentChat,
  type SourceScopeInput,
} from "@/lib/api";

describe("typed API contracts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("leaves a stale authenticated hash route even when pathname is already login", async () => {
    const location = { pathname: "/login", hash: "#/settings", href: "/login#/settings" };
    vi.stubGlobal("location", location);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Sign in again", code: "SESSION_ACCOUNT_UNAVAILABLE" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    setSession("expired-test-session", { id: "removed-user", email: "removed@example.test" });
    await expect(api("/api/models")).rejects.toMatchObject({ status: 401 });
    expect(getUser()).toBeNull();
    expect(location.href).toBe("/login");
  });

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
      embedding_dimension: 768,
      managed_by_env: {
        llm_base_url: false,
        llm_api_key: false,
        lm_studio_base_url: false,
        default_chat_model: false,
        default_embed_model: false,
        embedding_dimension: false,
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
      embedding_dimension: 768,
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
      embedding_dimension: 768,
    });
  });

  it("uses the explicit qualification and embedding-migration contracts", async () => {
    const status = {
      phase: "idle",
      target_model: null,
      target_dimension: null,
      source_count: 0,
      chunk_count: 0,
      indexed_count: 0,
      error_code: null,
      restart_required: false,
      can_cancel: false,
      can_retry: false,
      can_apply: false,
    };
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          chat: { qualified: true, reason_code: "qualified", latency_ms: 4 },
          embedding: { qualified: true, reason_code: "qualified", dimension: 384, latency_ms: 6 },
        }),
      )
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response({ ...status, phase: "building" }))
      .mockResolvedValueOnce(response({ ...status, phase: "building" }))
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response({ ...status, phase: "apply_pending", restart_required: true }));
    vi.stubGlobal("fetch", fetchMock);

    await modelsApi.qualify({
      llm_base_url: "https://models.example.test",
      default_chat_model: "chat-v2",
      default_embed_model: "embed-v2",
      embedding_dimension: 384,
      expected_dimension: 384,
      remote_egress_ack_origin: "https://models.example.test",
    });
    await modelsApi.embeddingMigrationStatus();
    await modelsApi.startEmbeddingMigration({ target_embed_model: "embed-v2", target_dimension: 384 });
    await modelsApi.retryEmbeddingMigration();
    await modelsApi.cancelEmbeddingMigration();
    await modelsApi.applyEmbeddingMigration();

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/models/qualify",
      "/api/models/embedding-migration",
      "/api/models/embedding-migration/start",
      "/api/models/embedding-migration/retry",
      "/api/models/embedding-migration/cancel",
      "/api/models/embedding-migration/apply",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      llm_base_url: "https://models.example.test",
      default_chat_model: "chat-v2",
      default_embed_model: "embed-v2",
      embedding_dimension: 384,
      expected_dimension: 384,
      remote_egress_ack_origin: "https://models.example.test",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toEqual({
      target_embed_model: "embed-v2",
      target_dimension: 384,
    });
    for (const call of fetchMock.mock.calls.slice(3)) expect(call[1].body).toBeUndefined();
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

  it("preserves invalid explicit catalog cursors and requires the one envelope shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], next_cursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await agentsApi.list({ cursor: "", limit: 50 });
    await expect(agentsApi.list()).rejects.toThrow("invalid catalog response");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/agents?cursor=&limit=50");
  });

  it("validates exact catalog-status coverage and serializes the bounded UUID request", async () => {
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: sourceId,
                name: "scan",
                display_name: "Scan.pdf",
                kind: "document",
                status: "index",
                mime: "application/pdf",
                created_at: "2026-09-01T00:00:00.000Z",
              },
            ],
            missing_ids: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], missing_ids: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sourcesApi.status([sourceId])).resolves.toMatchObject({
      items: [expect.objectContaining({ id: sourceId, status: "index" })],
      missing_ids: [],
    });
    const [requestPath, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestPath).toBe("/api/sources/status");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ ids: [sourceId] });
    await expect(sourcesApi.status([sourceId])).rejects.toThrow("invalid catalog status response");
  });

  it("forwards create-mutation abort ownership for chats, automations, and libraries", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const chatAbort = new AbortController();
    const automationAbort = new AbortController();
    const libraryAbort = new AbortController();

    await chatsApi.create(
      undefined,
      { source_mode: "selected", source_ids: ["source-1"] },
      undefined,
      chatAbort.signal,
    );
    await automationsApi.create(
      {
        name: "Weekly sync",
        kind: "connector_sync",
        target_id: "connector-1",
        schedule_minutes: 60,
      },
      automationAbort.signal,
    );
    await librariesApi.create("Finance room", libraryAbort.signal);

    expect(fetchMock.mock.calls[0][1].signal).toBe(chatAbort.signal);
    expect(fetchMock.mock.calls[1][1].signal).toBe(automationAbort.signal);
    expect(fetchMock.mock.calls[2][1].signal).toBe(libraryAbort.signal);
  });

  it("forwards preference and row-mutation abort ownership", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const preferenceLoadAbort = new AbortController();
    const preferenceSaveAbort = new AbortController();
    const automationUpdateAbort = new AbortController();
    const automationDeleteAbort = new AbortController();
    const reportDeleteAbort = new AbortController();

    await preferencesApi.get(preferenceLoadAbort.signal);
    await preferencesApi.set("analysis-large", preferenceSaveAbort.signal);
    await automationsApi.update("automation-1", { state: "paused" }, automationUpdateAbort.signal);
    await automationsApi.remove("automation-1", automationDeleteAbort.signal);
    await reportsApi.remove("report-1", reportDeleteAbort.signal);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/preferences",
      "/api/preferences",
      "/api/automations/automation-1",
      "/api/automations/automation-1",
      "/api/reports/report-1",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init.signal)).toEqual([
      preferenceLoadAbort.signal,
      preferenceSaveAbort.signal,
      automationUpdateAbort.signal,
      automationDeleteAbort.signal,
      reportDeleteAbort.signal,
    ]);
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
    expect(formatApiError(failure, "fallback")).toBe("fallback");
    expect(
      formatApiError(new ApiError(500, "Internal Server Error", undefined, "audit-ref"), "Could not load history."),
    ).toBe("Could not load history. (reference: audit-ref)");
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

describe("M14 living-library typed clients", () => {
  afterEach(() => vi.unstubAllGlobals());

  function json(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("creates a folder connection from the opaque grant only", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({ id: "kc-1", name: "Notes", kind: "desktop_folder", revision: 1, label: "Research notes" }, 201),
      );
    vi.stubGlobal("fetch", fetchMock);
    await knowledgeApi.create({
      name: "Notes",
      kind: "desktop_folder",
      library_id: "library-1",
      grant_id: "a".repeat(64),
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/knowledge-connections");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Notes",
      kind: "desktop_folder",
      library_id: "library-1",
      grant_id: "a".repeat(64),
    });
  });

  it("sends the WebDAV password only on the create/patch body", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ id: "kc-2", kind: "webdav", revision: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await knowledgeApi.create({
      name: "DAV",
      kind: "webdav",
      library_id: "library-1",
      config: { url: "https://dav.example.test/c", username: "ada", password: "secret-pw" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).config.password).toBe("secret-pw");
    await knowledgeApi.update("kc-2", { expected_revision: 1, credentials: { password: "rotated" } });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).credentials.password).toBe("rotated");
    await knowledgeApi.update("kc-2", { expected_revision: 2, credentials: null });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).credentials).toBeNull();
  });

  it("echoes selection tokens and the exact revision on apply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ preview: { id: "p1", revision: 2 }, items: [], refresh_id: "r1" }));
    vi.stubGlobal("fetch", fetchMock);
    await knowledgeApi.applyPreview("p1", {
      expected_revision: 2,
      selections: [{ entry_id: "e1", selection_token: "b".repeat(64) }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/knowledge-previews/p1/apply");
    expect(JSON.parse(String(init.body))).toEqual({
      expected_revision: 2,
      selections: [{ entry_id: "e1", selection_token: "b".repeat(64) }],
    });
  });

  it("reads previews, refresh detail, and the durable cancellation", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ preview: { id: "p1" }, entries: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await knowledgeApi.getPreview("p1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/knowledge-previews/p1");
    fetchMock.mockImplementation(async () =>
      json({ refresh: { id: "r1", status: "cancelled" }, counts: {}, items: [] }),
    );
    const detail = await knowledgeApi.getRefresh("r1");
    expect(detail.refresh.status).toBe("cancelled");
    fetchMock.mockImplementation(async () => json({ ok: true, cancel_requested: true, status: "active" }));
    await knowledgeApi.cancelRefresh("r1");
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });

  it("posts library search modes/filters and reads the passage route", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      json({
        mode: "semantic",
        query_truncated: false,
        captured_scope: [],
        ignored_source_ids: [],
        hits: [],
        returned_char_count: 0,
        truncated: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await librariesApi.search("lib-1", { query: "cashflow", mode: "semantic", source_ids: ["s1"], kind: "document" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/libraries/lib-1/search");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      query: "cashflow",
      mode: "semantic",
      source_ids: ["s1"],
      kind: "document",
    });
    fetchMock.mockImplementation(async () =>
      json({
        source: { id: "s1", label: "memo.pdf", status: "ready", ready_generation: 2 },
        chunk: {
          chunk_id: "c1",
          source_id: "s1",
          generation: 2,
          seq: 0,
          content: "text",
          locators: [{ kind: "pdf_page", page: 3, ocr: false, char_start: 10, char_len: 4 }],
        },
        neighbors: { before: null, after: null },
      }),
    );
    const passage = await sourcesApi.passage("s1", "c1");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sources/s1/passages/c1");
    expect(passage.chunk.locators?.[0]?.kind).toBe("pdf_page");
  });
});

describe("M15 research typed client", () => {
  afterEach(() => vi.unstubAllGlobals());

  function json(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const definitionPayload = {
    id: "d1",
    title: "Supplier terms",
    question: "Compare renewal terms",
    output_kind: "memo",
    current_revision: 2,
    source_ids: ["s1"],
    library_ids: [],
    chat_model: "chat-model",
    columns: [],
    plan: { steps: [] },
    sources: [{ source_id: "s1", availability: "ready", ready_generation: 3 }],
    active_run: null,
    revision_created_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("lists definitions through the keyset envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        items: [
          {
            id: "d1",
            title: "t",
            output_kind: "memo",
            current_revision: 1,
            source_count: 2,
            created_at: "",
            updated_at: "",
          },
        ],
        next_cursor: "abc_-1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await researchApi.list({ cursor: "c1", limit: 25 });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/research?cursor=c1&limit=25");
    expect(page.items[0]?.id).toBe("d1");
    expect(page.next_cursor).toBe("abc_-1");
  });

  it("rejects a malformed catalog envelope instead of widening the page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ items: [], next_cursor: "bad cursor!" })));
    await expect(researchApi.list()).rejects.toThrow("invalid catalog response");
  });

  it("sends the create and CAS-patch bodies exactly", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json(definitionPayload, 201));
    vi.stubGlobal("fetch", fetchMock);
    await researchApi.create({
      title: "Supplier terms",
      question: "Compare renewal terms",
      output_kind: "comparison",
      source_ids: ["s1"],
      library_ids: ["l1"],
      chat_model: "chat-model",
      columns: [{ id: "c1", label: "Price", question: "price?", type: "number", unit: "USD", choices: null }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/research");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({
      output_kind: "comparison",
      source_ids: ["s1"],
    });

    await researchApi.update("d1", { expected_revision: 2, title: "Renamed" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/research/d1");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ expected_revision: 2, title: "Renamed" });
  });

  it("sends the plan-proposal revision guard and never implies a start", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        definition_id: "d1",
        base_revision: 2,
        model: "m",
        model_used: true,
        fallback: false,
        error_code: null,
        plan: { steps: [] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await researchApi.proposePlan("d1", 2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/research/d1/plan");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ expected_revision: 2 });
    expect(proposal.fallback).toBe(false);
  });

  it("starts pinned rerun runs and carries the rerun selection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: "r1", status: "queued", definition_id: "d1" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await researchApi.start("d1", {
      expected_revision: 3,
      definition_revision: 3,
      rerun_of: "r0",
      rerun_selection: { row_source_ids: ["s1"], column_ids: ["c1"] },
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/research/d1/runs");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      expected_revision: 3,
      definition_revision: 3,
      rerun_of: "r0",
      rerun_selection: { row_source_ids: ["s1"], column_ids: ["c1"] },
    });
  });

  it("builds table view options and the diff target into the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        run_id: "r1",
        columns: [],
        items: [],
        next_cursor: null,
        limit_state: { serialized_bytes: 0, limit_bytes: 1048576, at_limit: false },
        view_state: {
          sort_applied: true,
          filter_applied: false,
          basis: "row_source_id_keyset",
          sort_column_id: "c1",
          sort_dir: "asc",
          sort_view: "machine",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = await researchApi.getTable("r1", {
      sortColumn: "c1",
      sortDir: "asc",
      sortView: "machine",
      filterStatus: "not_found",
      filterText: "cash",
      against: "r0",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/research-runs/r1/table?sort_column=c1&sort_dir=asc&sort_view=machine&filter_status=not_found&filter_text=cash&against=r0",
    );
    expect(view.view_state.sort_applied).toBe(true);
  });

  it("reviews with a CAS revision and creates artifacts without a payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ review_revision: 4, ops_applied: 1, run: { id: "r1", status: "running" } }))
      .mockResolvedValueOnce(
        json(
          {
            run_id: "r1",
            document_id: "doc-1",
            document_revision_id: "rev-1",
            document_revision: 1,
            projection: { labels: ["comparison"], omitted: { rows: [], claims: 0, gaps: 0, evidence: 0 } },
          },
          201,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await researchApi.review("r1", {
      expected_revision: 3,
      ops: [{ op: "accept_claim", claim_id: "cl1" }],
    });
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      expected_revision: 3,
      ops: [{ op: "accept_claim", claim_id: "cl1" }],
    });
    expect(result.review_revision).toBe(4);
    await researchApi.createArtifact("r1");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/research-runs/r1/artifacts");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({});
    expect(researchApi.exportPath("r1", "csv")).toBe("/api/research-runs/r1/export?format=csv");
  });

  it("surfaces the active-run identity and precise readiness ids from conflicts", async () => {
    const active = new ApiError(409, "active", { code: "RESEARCH_ACTIVE_RUN", existing_run_id: "r9" });
    expect(researchActiveRunId(active)).toBe("r9");
    expect(researchActiveRunId(new ApiError(409, "x", { code: "RESEARCH_QUEUE_FULL" }))).toBeNull();
    const ready = new ApiError(409, "not ready", { code: "RESEARCH_INPUTS_NOT_READY", unready_source_ids: ["s1", 5] });
    expect(researchUnreadySourceIds(ready)).toEqual(["s1"]);
  });
});
