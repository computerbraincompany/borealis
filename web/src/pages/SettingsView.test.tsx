import { fireEvent, render, screen } from "@testing-library/react";
import type { ModelsResponse, SystemHealthResponse } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  clearSession: vi.fn(),
  modelCatalog: vi.fn(),
  refresh: vi.fn(),
  setTheme: vi.fn(),
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
  };
});

import { SettingsView } from "@/pages/SettingsView";

const liveCatalog: ModelsResponse = {
  default_model: "qwen-chat",
  discovery: "live",
  models: [{ id: "qwen-chat", owned_by: "LM Studio" }, { id: "analysis-large" }],
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
      name: "LiteLLM gateway",
      description: "Model requests can reach the configured gateway.",
      status: "operational",
      latency_ms: 8,
    },
    {
      id: "model_runtime",
      name: "LM Studio runtime",
      description: "The local model runtime is responding.",
      status: "operational",
      latency_ms: 13,
    },
  ],
};

function selectSettingsTab(name: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });
}

describe("SettingsView", () => {
  beforeEach(() => {
    mocks.clearSession.mockReset();
    mocks.refresh.mockReset();
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
    window.location.hash = "/settings";
  });

  it("shows the configured default, advertised models, providers, and forced refresh", () => {
    render(<SettingsView />);
    selectSettingsTab("Models");

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

    expect(screen.getByRole("tab", { name: /System.*ready/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "All systems ready" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Service dependency status" })).toBeInTheDocument();
    for (const name of ["Borealis API", "Database", "Data service", "LiteLLM gateway", "LM Studio runtime"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.queryByText("The application server is accepting requests.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Ready")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(mocks.systemRefresh).toHaveBeenCalledOnce();
  });

  it("makes degraded dependencies actionable without exposing raw errors", () => {
    mocks.systemHealth.mockReturnValue({
      health: {
        ...healthySystem,
        status: "degraded",
        services: healthySystem.services.map((service) =>
          service.id === "model_runtime"
            ? {
                ...service,
                status: "unavailable" as const,
                description: "LiteLLM cannot complete model work until LM Studio is available.",
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
    expect(screen.getByText("LiteLLM cannot complete model work until LM Studio is available.")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("changes the persisted appearance and exposes the signed-in account controls", () => {
    render(<SettingsView />);

    expect(screen.queryByRole("heading", { name: "Appearance" })).not.toBeInTheDocument();
    selectSettingsTab("Appearance");
    expect(screen.getByRole("button", { name: /Light Always use the light theme/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Dark Always use the dark theme/i }));
    expect(mocks.setTheme).toHaveBeenCalledWith("dark");

    expect(screen.queryByText("analyst@example.test")).not.toBeInTheDocument();
    selectSettingsTab("Account");
    expect(screen.getByText("analyst@example.test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mocks.clearSession).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("#/login");
  });

  it("explains unavailable and empty discovery states", () => {
    mocks.modelCatalog.mockReturnValue({
      catalog: { default_model: "qwen-chat", discovery: "unavailable", models: [] },
      loading: false,
      error: null,
      refresh: mocks.refresh,
    });
    const { unmount } = render(<SettingsView />);
    selectSettingsTab("Models");
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
    selectSettingsTab("Models");
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
    selectSettingsTab("Models");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Showing the last available catalog. The model catalog is temporarily unavailable.",
    );
    expect(screen.getByText("analysis-large")).toBeInTheDocument();
  });
});
