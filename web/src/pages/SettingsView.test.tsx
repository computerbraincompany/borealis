import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, type ModelsResponse, type ProviderSettingsResponse, type SystemHealthResponse } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  clearSession: vi.fn(),
  modelCatalog: vi.fn(),
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

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: mocks.theme,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getUser: () => ({ id: "u1", email: "analyst@example.test" }),
    clearSession: mocks.clearSession,
    settingsApi: {
      get: mocks.settingsGet,
      update: mocks.settingsUpdate,
      testConnection: mocks.settingsTest,
    },
  };
});

import { SettingsView } from "@/pages/SettingsView";

const liveCatalog: ModelsResponse = {
  default_model: "qwen-chat",
  discovery: "live",
  models: [{ id: "qwen-chat", owned_by: "LM Studio" }, { id: "analysis-large" }],
};

const providerSettings: ProviderSettingsResponse = {
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
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("SettingsView", () => {
  beforeEach(() => {
    mocks.clearSession.mockReset();
    delete window.borealisDesktop;
    mocks.refresh.mockReset();
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
    mocks.theme.mockReturnValue({ theme: "light", resolvedTheme: "light", setTheme: mocks.setTheme });
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

  it("explains unavailable and empty discovery states", () => {
    mocks.modelCatalog.mockReturnValue({
      catalog: { default_model: "qwen-chat", discovery: "unavailable", models: [] },
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
      catalog: { default_model: "qwen-chat", discovery: "live", models: [] },
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

    await waitFor(() => expect(mocks.settingsUpdate).toHaveBeenCalledWith({ default_chat_model: "analysis-large" }));
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

    await waitFor(() => expect(mocks.settingsUpdate).toHaveBeenCalledWith({ llm_api_key: "sk-new-secret" }));
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

    expect(mocks.settingsUpdate).toHaveBeenCalledWith({ llm_api_key: null });
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
      expect(mocks.settingsTest).toHaveBeenCalledWith({
        llm_base_url: "https://api.example.test",
        lm_studio_base_url: "http://127.0.0.1:1234",
        default_chat_model: "qwen-chat",
        default_embed_model: "nomic-embed",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Connection ready in 43 ms.");
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
      },
    };
    mocks.settingsGet.mockResolvedValue(managedSettings);
    mocks.settingsTest.mockResolvedValue({ ok: true, latency_ms: 8 });
    render(<SettingsView />);
    selectSettingsSection("Models");

    expect(await screen.findByLabelText("Chat endpoint URL")).toBeDisabled();
    for (const label of ["API key", "LM Studio URL (optional)", "Default chat model", "Embedding model"]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getAllByText("Managed by environment")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "Clear saved key" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(mocks.settingsTest).toHaveBeenCalledWith({}));
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
