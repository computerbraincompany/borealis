import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/Shell", () => ({
  Shell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock("@/pages/AuthPage", () => ({ AuthPage: () => <div>Auth page</div> }));
vi.mock("@/pages/ChatView", () => ({ ChatView: () => <div>Chat page</div> }));
vi.mock("@/pages/SourcesView", () => ({ SourcesView: () => <div>Sources page</div> }));
vi.mock("@/pages/LibrariesView", () => ({ LibrariesView: () => <div>Libraries page</div> }));
vi.mock("@/pages/AgentsView", () => ({ AgentsView: () => <div>Agents page</div> }));
vi.mock("@/pages/AutomationsView", () => ({ AutomationsView: () => <div>Automations page</div> }));
vi.mock("@/pages/ConnectorsView", () => ({ ConnectorsView: () => <div>Connectors page</div> }));
vi.mock("@/pages/ReportsView", () => ({ ReportsView: () => <div>Reports page</div> }));
vi.mock("@/pages/SettingsView", () => ({
  SettingsView: ({ onClose }: { onClose: () => void }) => (
    <div>
      Settings modal <button onClick={onClose}>Close settings</button>
    </div>
  ),
}));

import App from "@/App";
import { setSession } from "@/lib/api";

describe("App routing", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete window.borealisDesktop;
    setSession("browser-jwt", { id: "u1", email: "user@example.test" });
    window.location.hash = "/chat";
    window.scrollTo = vi.fn();
  });

  it("renders direct Settings links as a modal over the chat workspace", async () => {
    window.location.hash = "/settings";
    render(<App />);

    expect(screen.getByTestId("shell")).toContainElement(screen.getByText("Chat page"));
    expect(await screen.findByText("Settings modal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(window.location.hash).toBe("#/chat");
  });

  it("preserves the originating workspace behind Settings and restores it on close", async () => {
    window.location.hash = "/sources";
    render(<App />);
    expect(await screen.findByText("Sources page")).toBeInTheDocument();

    act(() => {
      window.location.hash = "/settings";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(screen.getByText("Sources page")).toBeInTheDocument();
    expect(await screen.findByText("Settings modal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(window.location.hash).toBe("#/sources");
  });

  it("waits for the desktop bootstrap before mounting workspace pages", async () => {
    window.localStorage.clear();
    let resolveBootstrap!: (value: { token: string; user: { id: string; email: string } }) => void;
    window.borealisDesktop = {
      consumeBootstrap: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveBootstrap = resolve;
        }),
      ),
    };

    const { container } = render(<App />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Auth page")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat page")).not.toBeInTheDocument();

    act(() => {
      resolveBootstrap({ token: "desktop-jwt", user: { id: "desktop-user", email: "local@borealis.test" } });
    });

    expect(await screen.findByText("Chat page")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("borealis_token")).toBe("desktop-jwt");
    expect(window.localStorage.getItem("borealis_token")).toBeNull();
    expect(document.body).not.toHaveTextContent("desktop-jwt");
  });

  it("falls back to the browser login page when the desktop bootstrap is null", async () => {
    window.localStorage.clear();
    window.borealisDesktop = { consumeBootstrap: vi.fn().mockResolvedValue(null) };

    render(<App />);

    await waitFor(() => expect(screen.getByText("Auth page")).toBeInTheDocument());
    expect(window.borealisDesktop.consumeBootstrap).toHaveBeenCalledTimes(1);
  });

  it("uses normal browser routing immediately when the bridge is absent", () => {
    render(<App />);

    expect(screen.getByText("Chat page")).toBeInTheDocument();
  });

  it.each([
    ["/sources", "Sources page"],
    ["/libraries", "Libraries page"],
    ["/agents", "Agents page"],
    ["/automations", "Automations page"],
    ["/connectors", "Connectors page"],
    ["/reports", "Reports page"],
  ])("lazy-loads a direct %s route", async (route, label) => {
    window.location.hash = route;
    render(<App />);

    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});
