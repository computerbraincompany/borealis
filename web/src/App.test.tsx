import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  getUser: () => ({ id: "u1", email: "user@example.test" }),
}));

vi.mock("@/components/Shell", () => ({
  Shell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock("@/pages/AuthPage", () => ({ AuthPage: () => <div>Auth page</div> }));
vi.mock("@/pages/ChatView", () => ({ ChatView: () => <div>Chat page</div> }));
vi.mock("@/pages/SourcesView", () => ({ SourcesView: () => <div>Sources page</div> }));
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

describe("App routing", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
  });

  it("renders direct Settings links as a modal over the chat workspace", () => {
    window.location.hash = "/settings";
    render(<App />);

    expect(screen.getByTestId("shell")).toContainElement(screen.getByText("Chat page"));
    expect(screen.getByText("Settings modal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(window.location.hash).toBe("#/chat");
  });

  it("preserves the originating workspace behind Settings and restores it on close", () => {
    window.location.hash = "/sources";
    render(<App />);
    expect(screen.getByText("Sources page")).toBeInTheDocument();

    act(() => {
      window.location.hash = "/settings";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(screen.getByText("Sources page")).toBeInTheDocument();
    expect(screen.getByText("Settings modal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(window.location.hash).toBe("#/sources");
  });
});
