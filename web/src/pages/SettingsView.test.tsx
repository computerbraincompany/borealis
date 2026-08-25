import { fireEvent, render, screen } from "@testing-library/react";
import type { ModelsResponse } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  clearSession: vi.fn(),
  modelCatalog: vi.fn(),
  refresh: vi.fn(),
  setTheme: vi.fn(),
  theme: vi.fn(),
}));

vi.mock("@/hooks/useModelCatalog", () => ({
  useModelCatalog: mocks.modelCatalog,
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

describe("SettingsView", () => {
  beforeEach(() => {
    mocks.clearSession.mockReset();
    mocks.refresh.mockReset();
    mocks.setTheme.mockReset();
    mocks.modelCatalog.mockReturnValue({ catalog: liveCatalog, loading: false, error: null, refresh: mocks.refresh });
    mocks.theme.mockReturnValue({ theme: "light", resolvedTheme: "light", setTheme: mocks.setTheme });
    window.location.hash = "/settings";
  });

  it("shows the configured default, advertised models, providers, and forced refresh", () => {
    render(<SettingsView />);

    expect(screen.getAllByText("qwen-chat")).toHaveLength(2);
    expect(screen.getByText("analysis-large")).toBeInTheDocument();
    expect(screen.getByText("Provider: LM Studio")).toBeInTheDocument();
    expect(screen.getByText("2 models")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(mocks.refresh).toHaveBeenCalledWith(true);
  });

  it("changes the persisted appearance and exposes the signed-in account controls", () => {
    render(<SettingsView />);

    expect(screen.getByRole("button", { name: /Light Always use the light theme/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Dark Always use the dark theme/i }));
    expect(mocks.setTheme).toHaveBeenCalledWith("dark");

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

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Showing the last available catalog. The model catalog is temporarily unavailable.",
    );
    expect(screen.getByText("analysis-large")).toBeInTheDocument();
  });
});
