import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, type ModelsResponse, type ProviderSettingsResponse, type SystemHealthResponse } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  clearSession: vi.fn(),
  egressAudit: vi.fn(),
  migrationApply: vi.fn(),
  migrationCancel: vi.fn(),
  migrationRetry: vi.fn(),
  migrationStart: vi.fn(),
  migrationStatus: vi.fn(),
  modelCatalog: vi.fn(),
  modelsQualify: vi.fn(),
  preferencesGet: vi.fn(),
  preferencesSet: vi.fn(),
  refresh: vi.fn(),
  setTheme: vi.fn(),
  settingsGet: vi.fn(),
  settingsTest: vi.fn(),
  settingsUpdate: vi.fn(),
  systemHealth: vi.fn(),
  systemRefresh: vi.fn(),
  theme: vi.fn(),
}));

vi.mock("@/hooks/useModelCatalog", () => ({
  useModelCatalog: mocks.modelCatalog,
}));

vi.mock("@/hooks/useSystemHealth", () => ({
  useSystemHealth: mocks.systemHealth,
}));

vi.mock("@/hooks/useEgressAudit", () => ({
  useEgressAudit: mocks.egressAudit,
}));

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: mocks.theme,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getUser: () => ({ id: "u1", email: "analyst@example.test" }),
    clearSession: mocks.clearSession,
    modelsApi: {
      ...actual.modelsApi,
      qualify: mocks.modelsQualify,
      embeddingMigrationStatus: mocks.migrationStatus,
      startEmbeddingMigration: mocks.migrationStart,
      retryEmbeddingMigration: mocks.migrationRetry,
      cancelEmbeddingMigration: mocks.migrationCancel,
      applyEmbeddingMigration: mocks.migrationApply,
    },
    settingsApi: {
      get: mocks.settingsGet,
      update: mocks.settingsUpdate,
      testConnection: mocks.settingsTest,
    },
    preferencesApi: {
      get: mocks.preferencesGet,
      set: mocks.preferencesSet,
    },
  };
});

import { SettingsView } from "@/pages/SettingsView";

const liveCatalog: ModelsResponse = {
  default_model: "qwen-chat",
  account_default_model: null,
  discovery: "live",
  models: [{ id: "qwen-chat", owned_by: "LM Studio" }, { id: "analysis-large" }],
};

const providerSettings: ProviderSettingsResponse = {
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

const idleMigration = {
  phase: "idle" as const,
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

const qualifiedPair = {
  chat: { qualified: true, reason_code: "qualified" as const, latency_ms: 17 },
  embedding: { qualified: true, reason_code: "qualified" as const, dimension: 384, latency_ms: 19 },
};

const healthySystem: SystemHealthResponse = {
  status: "operational",
  checked_at: "2026-08-26T09:30:00.000Z",
  services: [
    {
      id: "api",
      name: "Borealis API",
      description: "The application server is accepting requests.",
      status: "operational",
      latency_ms: 1,
    },
    {
      id: "database",
      name: "Database",
      description: "Chats, sources, and reports can be stored.",
      status: "operational",
      latency_ms: 3,
    },
    {
      id: "data_service",
      name: "Data service",
      description: "Dataset queries, charts, and reports are available.",
      status: "operational",
      latency_ms: 5,
    },
    {
      id: "model_gateway",
      name: "Model endpoint",
      description: "Model requests can reach the configured endpoint.",
      status: "operational",
      latency_ms: 8,
    },
  ],
};

function selectSettingsSection(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("SettingsView", () => {
  beforeEach(() => {
    mocks.clearSession.mockReset();
    mocks.egressAudit.mockReset();
    mocks.migrationApply.mockReset();
    mocks.migrationCancel.mockReset();
    mocks.migrationRetry.mockReset();
    mocks.migrationStart.mockReset();
    mocks.migrationStatus.mockReset();
    mocks.modelsQualify.mockReset();
    delete window.borealisDesktop;
    mocks.refresh.mockReset();
    mocks.preferencesGet.mockReset();
    mocks.preferencesSet.mockReset();
    // Most legacy Settings tests exercise a different section. Keeping this
    // request pending prevents unrelated assertions from racing a form update.
    mocks.preferencesGet.mockReturnValue(new Promise(() => undefined));
    mocks.settingsGet.mockReset();
    mocks.settingsTest.mockReset();
    mocks.settingsUpdate.mockReset();
    mocks.systemRefresh.mockReset();
    mocks.setTheme.mockReset();
    mocks.modelCatalog.mockReturnValue({ catalog: liveCatalog, loading: false, error: null, refresh: mocks.refresh });
    mocks.systemHealth.mockReturnValue({
      health: healthySystem,
      checking: false,
      error: null,
      refresh: mocks.systemRefresh,
    });
    mocks.egressAudit.mockReturnValue({ events: [], loading: false, refresh: vi.fn() });
    mocks.theme.mockReturnValue({ theme: "light", resolvedTheme: "light", setTheme: mocks.setTheme });
    mocks.migrationStatus.mockReturnValue(new Promise(() => undefined));
    mocks.modelsQualify.mockResolvedValue(qualifiedPair);
    // Most legacy Settings tests exercise a different section. Keeping this
    // request pending prevents unrelated assertions from racing a form update.
    mocks.settingsGet.mockReturnValue(new Promise(() => undefined));
    window.location.hash = "/settings";
  });

  it("shows the configured default, advertised models, providers, and forced refresh", () => {
    render(<SettingsView />);
    selectSettingsSection("Models");

    expect(screen.getAllByText("qwen-chat")).toHaveLength(2);
    expect(screen.getByText("analysis-large")).toBeInTheDocument();
    expect(screen.getByText("Provider: LM Studio")).toBeInTheDocument();
    expect(screen.getByText("2 models")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(mocks.refresh).toHaveBeenCalledWith(true);
  });

  it("shows the dependency request path and refreshes it independently", () => {
    render(<SettingsView />);

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    const systemSection = screen.getByRole("button", { name: /System.*ready/ });
    expect(systemSection).toHaveAttribute("aria-current", "page");
    expect(systemSection).toHaveClass("rounded-lg", "bg-accent", "font-semibold");
    expect(systemSection).not.toHaveClass("border-l-2", "border-primary");
    expect(screen.getByRole("heading", { name: "All systems ready" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Service dependency status" })).toBeInTheDocument();
    for (const name of ["Borealis API", "Database", "Data service", "Model endpoint"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.queryByText("The application server is accepting requests.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Ready")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(mocks.systemRefresh).toHaveBeenCalledOnce();
  });

  it("makes degraded dependencies actionable without exposing raw errors", () => {
    mocks.systemHealth.mockReturnValue({
      health: {
        ...healthySystem,
        status: "degraded",
        services: healthySystem.services.map((service) =>
          service.id === "model_gateway"
            ? {
                ...service,
                status: "unavailable" as const,
                description: "Chat and embedding requests cannot reach the configured endpoint.",
              }
            : service,
        ),
      },
      checking: false,
      error: null,
      refresh: mocks.systemRefresh,
    });
    render(<SettingsView />);

    expect(screen.getByRole("heading", { name: "Service attention required" })).toBeInTheDocument();
    expect(
      screen.getByText("1 dependency is unavailable. Follow the affected service below to restore full operation."),
    ).toBeInTheDocument();
    expect(screen.getByText("Chat and embedding requests cannot reach the configured endpoint.")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("changes the persisted appearance and exposes the signed-in account controls", () => {
    render(<SettingsView />);

    expect(screen.queryByRole("heading", { name: "Appearance" })).not.toBeInTheDocument();
    selectSettingsSection("Appearance");
    expect(screen.getByRole("button", { name: /Light Always use the light theme/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Dark Always use the dark theme/i }));
    expect(mocks.setTheme).toHaveBeenCalledWith("dark");

    expect(screen.queryByText("analyst@example.test")).not.toBeInTheDocument();
    selectSettingsSection("Account");
    expect(screen.getByText("analyst@example.test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mocks.clearSession).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("#/login");
  });

  it("explains renewal instead of offering desktop local-profile sign out", () => {
    window.borealisDesktop = { consumeBootstrap: vi.fn().mockResolvedValue(null) };
    render(<SettingsView />);

    selectSettingsSection("Account");

    expect(screen.getByText(/Reopen Borealis to renew this session/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("renders the saved personal default and saves a catalog model on change", async () => {
    mocks.preferencesGet.mockResolvedValue({ default_chat_model: "analysis-large" });
    mocks.preferencesSet.mockResolvedValue({ default_chat_model: "qwen-chat" });
    render(<SettingsView />);
    selectSettingsSection("Account");

    const select = await screen.findByLabelText("Personal default model");
    expect(select).toHaveValue("analysis-large");
    expect(select).toBeEnabled();

    fireEvent.change(select, { target: { value: "qwen-chat" } });
    await waitFor(() => expect(mocks.preferencesSet).toHaveBeenCalledWith("qwen-chat", expect.any(AbortSignal)));
    expect(await screen.findByRole("status")).toHaveTextContent("Personal default model saved.");
    expect(screen.getByLabelText("Personal default model")).toHaveValue("qwen-chat");
  });

  it("sends null when the personal default is cleared to the workspace default", async () => {
    mocks.preferencesGet.mockResolvedValue({ default_chat_model: "qwen-chat" });
    mocks.preferencesSet.mockResolvedValue({ default_chat_model: null });
    render(<SettingsView />);
    selectSettingsSection("Account");

    fireEvent.change(await screen.findByLabelText("Personal default model"), { target: { value: "" } });
    await waitFor(() => expect(mocks.preferencesSet).toHaveBeenCalledWith(null, expect.any(AbortSignal)));
    expect(await screen.findByRole("status")).toHaveTextContent("Personal default cleared.");
    expect(screen.getByLabelText("Personal default model")).toHaveValue("");
  });

  it("surfaces a bounded save error and keeps the previous personal default", async () => {
    mocks.preferencesGet.mockResolvedValue({ default_chat_model: "qwen-chat" });
    mocks.preferencesSet.mockRejectedValue(new Error("untrusted provider detail"));
    render(<SettingsView />);
    selectSettingsSection("Account");

    const select = await screen.findByLabelText("Personal default model");
    fireEvent.change(select, { target: { value: "analysis-large" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("The personal default model could not be saved.");
    expect(screen.queryByText(/untrusted provider detail/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Personal default model")).toHaveValue("qwen-chat");
  });

  it("offers a retry when the personal default cannot be loaded", async () => {
    mocks.preferencesGet
      .mockRejectedValueOnce(new ApiError(503, "Preferences unavailable.", undefined, "preferences-request-3"))
      .mockResolvedValueOnce({ default_chat_model: "qwen-chat" });
    render(<SettingsView />);
    selectSettingsSection("Account");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Preferences unavailable. (reference: preferences-request-3)",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Personal default model")).toHaveValue("qwen-chat");
  });

  it.each(["resolve", "reject"] as const)(
    "keeps a re-entered Account load owned when the prior request later %ss",
    async (settlement) => {
      const older = deferred<{ default_chat_model: string | null }>();
      const newer = deferred<{ default_chat_model: string | null }>();
      mocks.preferencesGet.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      render(<SettingsView />);

      selectSettingsSection("Account");
      await waitFor(() => expect(mocks.preferencesGet).toHaveBeenCalledTimes(1));
      const olderSignal = mocks.preferencesGet.mock.calls[0][0] as AbortSignal;
      selectSettingsSection(/System/);
      expect(olderSignal.aborted).toBe(true);
      selectSettingsSection("Account");
      await waitFor(() => expect(mocks.preferencesGet).toHaveBeenCalledTimes(2));

      await act(async () => {
        if (settlement === "resolve") older.resolve({ default_chat_model: "stale-model" });
        else older.reject(new Error("stale load failed"));
      });

      expect(screen.getByLabelText("Loading personal default model")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => newer.resolve({ default_chat_model: "analysis-large" }));
      expect(await screen.findByLabelText("Personal default model")).toHaveValue("analysis-large");
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores a personal-default save after leaving Account when it later %ss",
    async (settlement) => {
      const pending = deferred<{ default_chat_model: string | null }>();
      mocks.preferencesGet
        .mockResolvedValueOnce({ default_chat_model: "qwen-chat" })
        .mockResolvedValueOnce({ default_chat_model: "analysis-large" });
      mocks.preferencesSet.mockReturnValue(pending.promise);
      render(<SettingsView />);

      selectSettingsSection("Account");
      fireEvent.change(await screen.findByLabelText("Personal default model"), {
        target: { value: "analysis-large" },
      });
      await waitFor(() => expect(mocks.preferencesSet).toHaveBeenCalledTimes(1));
      const signal = mocks.preferencesSet.mock.calls[0][1] as AbortSignal;
      selectSettingsSection(/System/);
      expect(signal.aborted).toBe(true);

      await act(async () => {
        if (settlement === "resolve") pending.resolve({ default_chat_model: "stale-model" });
        else pending.reject(new Error("stale save failed"));
      });
      selectSettingsSection("Account");

      expect(await screen.findByLabelText("Personal default model")).toHaveValue("analysis-large");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("suppresses overlapping personal-default saves while the first request owns the field", async () => {
    const pending = deferred<{ default_chat_model: string | null }>();
    mocks.preferencesGet.mockResolvedValue({ default_chat_model: "qwen-chat" });
    mocks.preferencesSet.mockReturnValue(pending.promise);
    render(<SettingsView />);

    selectSettingsSection("Account");
    const select = await screen.findByLabelText("Personal default model");
    fireEvent.change(select, { target: { value: "analysis-large" } });
    fireEvent.change(select, { target: { value: "" } });

    await waitFor(() => expect(mocks.preferencesSet).toHaveBeenCalledTimes(1));
    expect(mocks.preferencesSet).toHaveBeenCalledWith("analysis-large", expect.any(AbortSignal));
    expect(select).toBeDisabled();
    await act(async () => pending.resolve({ default_chat_model: "analysis-large" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Personal default model saved.");
  });

  it("aborts pending personal-default loads and saves on unmount", async () => {
    const pendingLoad = deferred<{ default_chat_model: string | null }>();
    mocks.preferencesGet.mockReturnValue(pendingLoad.promise);
    const loadingView = render(<SettingsView />);

    selectSettingsSection("Account");
    await waitFor(() => expect(mocks.preferencesGet).toHaveBeenCalledTimes(1));
    const loadSignal = mocks.preferencesGet.mock.calls[0][0] as AbortSignal;
    loadingView.unmount();
    expect(loadSignal.aborted).toBe(true);
    await act(async () => pendingLoad.resolve({ default_chat_model: "late-model" }));

    const pendingSave = deferred<{ default_chat_model: string | null }>();
    mocks.preferencesGet.mockReset().mockResolvedValue({ default_chat_model: "qwen-chat" });
    mocks.preferencesSet.mockReturnValue(pendingSave.promise);
    const savingView = render(<SettingsView />);
    selectSettingsSection("Account");
    fireEvent.change(await screen.findByLabelText("Personal default model"), {
      target: { value: "analysis-large" },
    });
    await waitFor(() => expect(mocks.preferencesSet).toHaveBeenCalledTimes(1));
    const saveSignal = mocks.preferencesSet.mock.calls[0][1] as AbortSignal;
    savingView.unmount();
    expect(saveSignal.aborted).toBe(true);
    await act(async () => pendingSave.reject(new Error("late save failed")));
  });

  it("explains unavailable and empty discovery states", () => {
    mocks.modelCatalog.mockReturnValue({
      catalog: { default_model: "qwen-chat", account_default_model: null, discovery: "unavailable", models: [] },
      loading: false,
      error: null,
      refresh: mocks.refresh,
    });
    const { unmount } = render(<SettingsView />);
    selectSettingsSection("Models");
    expect(
      screen.getByText("Model discovery is unavailable. New chats can still use the configured default."),
    ).toBeInTheDocument();
    unmount();

    mocks.modelCatalog.mockReturnValue({
      catalog: { default_model: "qwen-chat", account_default_model: null, discovery: "live", models: [] },
      loading: false,
      error: null,
      refresh: mocks.refresh,
    });
    render(<SettingsView />);
    selectSettingsSection("Models");
    expect(screen.getByText("No chat models advertised.")).toBeInTheDocument();
  });

  it("keeps stale models visible while surfacing a bounded refresh error", () => {
    mocks.modelCatalog.mockReturnValue({
      catalog: liveCatalog,
      loading: false,
      error: "The model catalog is temporarily unavailable.",
      refresh: mocks.refresh,
    });
    render(<SettingsView />);
    selectSettingsSection("Models");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Showing the last available catalog. The model catalog is temporarily unavailable.",
    );
    expect(screen.getByText("analysis-large")).toBeInTheDocument();
  });

  it("loads redacted provider settings without ever receiving the stored key", async () => {
    mocks.settingsGet.mockResolvedValue(providerSettings);
    render(<SettingsView />);
    selectSettingsSection("Models");

    expect(await screen.findByLabelText("Chat endpoint URL")).toHaveValue("http://127.0.0.1:1234");
    expect(screen.getByLabelText("Default chat model")).toHaveValue("qwen-chat");
    expect(screen.getByLabelText("Embedding model")).toHaveValue("nomic-embed");
    expect(screen.getByLabelText("Embedding dimension")).toHaveValue(768);
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "Configured — leave blank to keep it");
    expect(screen.getByRole("button", { name: "Clear saved key" })).toBeEnabled();
    expect(screen.queryByLabelText("LM Studio URL (optional)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("saves changed fields while a blank secret preserves the configured API key", async () => {
    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.settingsUpdate.mockImplementation(async (patch) => ({
      ...providerSettings,
      default_chat_model: patch.default_chat_model ?? providerSettings.default_chat_model,
    }));
    render(<SettingsView />);
    selectSettingsSection("Models");

    const chatModel = await screen.findByLabelText("Default chat model");
    fireEvent.change(chatModel, { target: { value: "analysis-large" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(mocks.settingsUpdate).toHaveBeenCalledWith(
        { default_chat_model: "analysis-large" },
        expect.any(AbortSignal),
      ),
    );
    expect(mocks.settingsUpdate.mock.calls[0][0]).not.toHaveProperty("llm_api_key");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Settings saved. New model requests will use this connection.",
    );
    expect(screen.getByLabelText("API key")).toHaveValue("");
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith(true));
  });

  it("sends a newly entered key once, then clears it from the form", async () => {
    mocks.settingsGet.mockResolvedValue({ ...providerSettings, llm_api_key_configured: false });
    mocks.settingsUpdate.mockResolvedValue(providerSettings);
    render(<SettingsView />);
    selectSettingsSection("Models");

    const key = await screen.findByLabelText("API key");
    fireEvent.change(key, { target: { value: "sk-new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(mocks.settingsUpdate).toHaveBeenCalledWith({ llm_api_key: "sk-new-secret" }, expect.any(AbortSignal)),
    );
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.queryByDisplayValue("sk-new-secret")).not.toBeInTheDocument();
  });

  it("clears a configured key explicitly while preserving other unsaved edits", async () => {
    const cleared = deferred<ProviderSettingsResponse>();
    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.settingsUpdate.mockReturnValue(cleared.promise);
    render(<SettingsView />);
    selectSettingsSection("Models");

    const key = await screen.findByLabelText("API key");
    fireEvent.change(screen.getByLabelText("Default chat model"), { target: { value: "analysis-draft" } });
    fireEvent.change(key, { target: { value: "replacement-not-saved" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear saved key" }));

    expect(mocks.settingsUpdate).toHaveBeenCalledWith({ llm_api_key: null }, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Clearing…" })).toBeDisabled();
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    await act(async () => {
      cleared.resolve({ ...providerSettings, llm_api_key_configured: false });
      await cleared.promise;
    });

    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByLabelText("Default chat model")).toHaveValue("analysis-draft");
    expect(screen.queryByRole("button", { name: "Clear saved key" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Saved API key cleared.");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(mocks.refresh).toHaveBeenCalledWith(true);
  });

  it("keeps the configured key state and draft when clearing fails safely", async () => {
    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.settingsUpdate.mockRejectedValue(new Error("secret filesystem path /private/settings.json"));
    render(<SettingsView />);
    selectSettingsSection("Models");

    const key = await screen.findByLabelText("API key");
    fireEvent.change(key, { target: { value: "replacement-not-saved" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear saved key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Saved API key could not be cleared.");
    expect(screen.queryByText(/secret filesystem path/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveValue("replacement-not-saved");
    expect(screen.getByRole("button", { name: "Clear saved key" })).toBeEnabled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("aborts every in-flight provider action when Settings unmounts", async () => {
    const pending = () => new Promise<never>(() => undefined);

    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.settingsUpdate.mockReturnValue(pending());
    let view = render(<SettingsView />);
    selectSettingsSection("Models");
    fireEvent.change(await screen.findByLabelText("Default chat model"), { target: { value: "chat-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.settingsUpdate).toHaveBeenCalled());
    let signal = mocks.settingsUpdate.mock.calls[0][1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);

    mocks.settingsGet.mockReset().mockResolvedValue(providerSettings);
    mocks.settingsTest.mockReturnValue(pending());
    view = render(<SettingsView />);
    selectSettingsSection("Models");
    await screen.findByLabelText("Chat endpoint URL");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(mocks.settingsTest).toHaveBeenCalled());
    signal = mocks.settingsTest.mock.calls[0][1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);

    mocks.settingsGet.mockReset().mockResolvedValue(providerSettings);
    mocks.modelsQualify.mockReturnValue(pending());
    view = render(<SettingsView />);
    selectSettingsSection("Models");
    await screen.findByLabelText("Chat endpoint URL");
    fireEvent.click(screen.getByRole("button", { name: "Qualify model pair" }));
    await waitFor(() => expect(mocks.modelsQualify).toHaveBeenCalled());
    signal = mocks.modelsQualify.mock.calls[0][1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);

    mocks.settingsGet.mockReset().mockResolvedValue(providerSettings);
    mocks.settingsUpdate.mockReset().mockReturnValue(pending());
    view = render(<SettingsView />);
    selectSettingsSection("Models");
    await screen.findByLabelText("Chat endpoint URL");
    fireEvent.click(screen.getByRole("button", { name: "Clear saved key" }));
    await waitFor(() => expect(mocks.settingsUpdate).toHaveBeenCalled());
    signal = mocks.settingsUpdate.mock.calls[0][1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("tests an unsaved remote connection and explains its data boundary", async () => {
    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.settingsTest.mockResolvedValue({ ok: true, latency_ms: 42.6 });
    render(<SettingsView />);
    selectSettingsSection("Models");

    const endpoint = await screen.findByLabelText("Chat endpoint URL");
    fireEvent.change(endpoint, { target: { value: "https://api.example.test" } });
    expect(
      screen.getByText(/Remote providers receive your prompts and any retrieved document or data context/i),
    ).toBeInTheDocument();

    const lmStudio = screen.getByLabelText("LM Studio URL (optional)");
    fireEvent.change(lmStudio, { target: { value: "http://127.0.0.1:1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(mocks.settingsTest).toHaveBeenCalledWith(
        {
          llm_base_url: "https://api.example.test",
          lm_studio_base_url: "http://127.0.0.1:1234",
          default_chat_model: "qwen-chat",
          default_embed_model: "nomic-embed",
          embedding_dimension: 768,
        },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Connection ready in 43 ms.");
  });

  it("qualifies the exact local model draft and invalidates the result on every draft change", async () => {
    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.migrationStatus.mockResolvedValue(idleMigration);
    mocks.modelsQualify.mockResolvedValue({
      ...qualifiedPair,
      embedding: { ...qualifiedPair.embedding, dimension: 384 },
    });
    render(<SettingsView />);
    selectSettingsSection("Models");

    fireEvent.change(await screen.findByLabelText("Embedding model"), { target: { value: "embed-v2" } });
    fireEvent.change(screen.getByLabelText("Embedding dimension"), { target: { value: "384" } });
    fireEvent.click(screen.getByRole("button", { name: "Qualify model pair" }));

    await waitFor(() =>
      expect(mocks.modelsQualify).toHaveBeenCalledWith(
        {
          llm_base_url: "http://127.0.0.1:1234",
          default_chat_model: "qwen-chat",
          default_embed_model: "embed-v2",
          embedding_dimension: 384,
          expected_dimension: 384,
        },
        expect.any(AbortSignal),
      ),
    );
    const results = await screen.findByLabelText("Model qualification results");
    expect(results).toHaveTextContent("Chat tools");
    expect(results).toHaveTextContent("Qualified · 17 ms");
    expect(results).toHaveTextContent("384 dimensions");
    expect(screen.getByRole("button", { name: "Start migration" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Embedding dimension"), { target: { value: "512" } });
    expect(screen.queryByLabelText("Model qualification results")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start migration" })).toBeDisabled();
  });

  it("does not start a migration from a qualification that includes unsaved provider changes", async () => {
    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.migrationStatus.mockResolvedValue(idleMigration);
    mocks.modelsQualify.mockResolvedValue({
      ...qualifiedPair,
      embedding: { ...qualifiedPair.embedding, dimension: 384 },
    });
    render(<SettingsView />);
    selectSettingsSection("Models");

    fireEvent.change(await screen.findByLabelText("Default chat model"), { target: { value: "chat-v2" } });
    fireEvent.change(screen.getByLabelText("Embedding model"), { target: { value: "embed-v2" } });
    fireEvent.change(screen.getByLabelText("Embedding dimension"), { target: { value: "384" } });
    fireEvent.click(screen.getByRole("button", { name: "Qualify model pair" }));

    await waitFor(() =>
      expect(mocks.modelsQualify).toHaveBeenCalledWith(
        {
          llm_base_url: "http://127.0.0.1:1234",
          default_chat_model: "chat-v2",
          default_embed_model: "embed-v2",
          embedding_dimension: 384,
          expected_dimension: 384,
        },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByLabelText("Model qualification results")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start migration" })).toBeDisabled();
    expect(screen.getByText(/Save or revert endpoint, API key, chat-model, and health-probe changes/i)).toBeVisible();
  });

  it("requires draft-specific acknowledgement of the canonical remote origin before qualification", async () => {
    mocks.settingsGet.mockResolvedValue(providerSettings);
    render(<SettingsView />);
    selectSettingsSection("Models");

    fireEvent.change(await screen.findByLabelText("Chat endpoint URL"), {
      target: { value: "https://MODELS.Example.test:443/" },
    });
    const acknowledge = screen.getByRole("checkbox", { name: /https:\/\/models\.example\.test/i });
    expect(screen.getByRole("button", { name: "Qualify model pair" })).toBeDisabled();

    fireEvent.click(acknowledge);
    fireEvent.click(screen.getByRole("button", { name: "Qualify model pair" }));

    await waitFor(() =>
      expect(mocks.modelsQualify).toHaveBeenCalledWith(
        {
          llm_base_url: "https://MODELS.Example.test:443/",
          default_chat_model: "qwen-chat",
          default_embed_model: "nomic-embed",
          embedding_dimension: 768,
          expected_dimension: 768,
          remote_egress_ack_origin: "https://models.example.test",
        },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByLabelText("Model qualification results")).toBeInTheDocument();
  });

  it("validates embedding dimensions before any provider request", async () => {
    mocks.settingsGet.mockResolvedValue(providerSettings);
    render(<SettingsView />);
    selectSettingsSection("Models");

    fireEvent.change(await screen.findByLabelText("Embedding dimension"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Qualify model pair" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Embedding dimension must be a whole number from 1 to 16,384.",
    );
    expect(mocks.modelsQualify).not.toHaveBeenCalled();
  });

  it("starts only a qualified exact target, exposes progress, and stages apply for restart", async () => {
    const building = {
      phase: "building" as const,
      target_model: "embed-v2",
      target_dimension: 384,
      source_count: 3,
      chunk_count: 20,
      indexed_count: 5,
      error_code: null,
      restart_required: false,
      can_cancel: true,
      can_retry: false,
      can_apply: false,
    };
    const ready = {
      ...building,
      phase: "ready_to_apply" as const,
      indexed_count: 20,
      can_cancel: true,
      can_apply: true,
    };
    const pending = {
      ...ready,
      phase: "apply_pending" as const,
      restart_required: true,
      can_cancel: false,
      can_apply: false,
    };
    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.migrationStatus.mockResolvedValue(idleMigration);
    mocks.modelsQualify.mockResolvedValue({
      ...qualifiedPair,
      embedding: { ...qualifiedPair.embedding, dimension: 384 },
    });
    mocks.migrationStart.mockResolvedValue(building);
    mocks.migrationApply.mockResolvedValue(pending);
    render(<SettingsView />);
    selectSettingsSection("Models");

    fireEvent.change(await screen.findByLabelText("Embedding model"), { target: { value: "embed-v2" } });
    fireEvent.change(screen.getByLabelText("Embedding dimension"), { target: { value: "384" } });
    expect(await screen.findByRole("button", { name: "Start migration" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Qualify model pair" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start migration" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start migration" }));

    await waitFor(() =>
      expect(mocks.migrationStart).toHaveBeenCalledWith({ target_embed_model: "embed-v2", target_dimension: 384 }),
    );
    expect(await screen.findByText("Building replacement index")).toBeInTheDocument();
    expect(screen.getByLabelText("Embedding migration progress")).toHaveAttribute("value", "5");
    expect(screen.getByText("5 of 20 chunks")).toBeInTheDocument();
    expect(screen.getByLabelText("Embedding model")).toBeDisabled();

    mocks.migrationStatus.mockResolvedValueOnce(ready);
    fireEvent.click(screen.getByRole("button", { name: "Refresh embedding migration status" }));
    expect(await screen.findByRole("button", { name: "Apply on restart" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Apply on restart" }));

    await waitFor(() => expect(mocks.migrationApply).toHaveBeenCalledOnce());
    expect(await screen.findByText("Restart required")).toBeInTheDocument();
    expect(screen.getByText(/Quit and reopen Borealis/)).toBeInTheDocument();
  });

  it("offers retry and cancel for a failed migration without exposing raw failure details", async () => {
    const failed = {
      phase: "failed" as const,
      target_model: "embed-v2",
      target_dimension: 384,
      source_count: 2,
      chunk_count: 12,
      indexed_count: 4,
      error_code: "EMBEDDING_UNAVAILABLE",
      restart_required: false,
      can_cancel: true,
      can_retry: true,
      can_apply: false,
    };
    const resumed = {
      ...failed,
      phase: "building" as const,
      error_code: null,
      can_retry: false,
    };
    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.migrationStatus.mockResolvedValue(failed);
    mocks.migrationRetry.mockResolvedValue(resumed);
    mocks.migrationCancel.mockResolvedValue(idleMigration);
    render(<SettingsView />);
    selectSettingsSection("Models");

    expect(await screen.findByRole("alert")).toHaveTextContent("The embedding provider was unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry migration" }));
    await waitFor(() => expect(mocks.migrationRetry).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "Cancel migration" }));
    await waitFor(() => expect(mocks.migrationCancel).toHaveBeenCalledOnce());
    expect(await screen.findByText("No migration active")).toBeInTheDocument();
  });

  it("keeps environment-managed settings disabled and tests only the effective server configuration", async () => {
    const managedSettings: ProviderSettingsResponse = {
      ...providerSettings,
      llm_base_url: "https://models.example.test",
      lm_studio_base_url: "http://127.0.0.1:1234",
      managed_by_env: {
        llm_base_url: true,
        llm_api_key: true,
        lm_studio_base_url: true,
        default_chat_model: true,
        default_embed_model: true,
        embedding_dimension: true,
      },
    };
    mocks.settingsGet.mockResolvedValue(managedSettings);
    mocks.settingsTest.mockResolvedValue({ ok: true, latency_ms: 8 });
    render(<SettingsView />);
    selectSettingsSection("Models");

    expect(await screen.findByLabelText("Chat endpoint URL")).toBeDisabled();
    for (const label of [
      "API key",
      "LM Studio URL (optional)",
      "Default chat model",
      "Embedding model",
      "Embedding dimension",
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getAllByText("Managed by environment")).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "Clear saved key" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(mocks.settingsTest).toHaveBeenCalledWith({}, expect.any(AbortSignal)));
  });

  it("shows bounded provider errors without reflecting runtime details", async () => {
    mocks.settingsGet.mockResolvedValue(providerSettings);
    mocks.settingsTest.mockRejectedValue(new Error("secret upstream trace at https://private.invalid"));
    render(<SettingsView />);
    selectSettingsSection("Models");

    await screen.findByLabelText("Chat endpoint URL");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Connection test could not be completed.");
    expect(screen.queryByText(/secret upstream trace/i)).not.toBeInTheDocument();
  });

  it("surfaces a safe correlated load failure and offers a retry", async () => {
    mocks.settingsGet
      .mockRejectedValueOnce(new ApiError(503, "Provider settings unavailable.", undefined, "settings-request-7"))
      .mockResolvedValueOnce(providerSettings);
    render(<SettingsView />);
    selectSettingsSection("Models");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider settings unavailable. (reference: settings-request-7)",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Chat endpoint URL")).toHaveValue("http://127.0.0.1:1234");
    expect(mocks.settingsGet).toHaveBeenCalledTimes(2);
  });

  it("closes the modal through the shared dialog control", () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
