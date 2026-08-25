import { render, screen } from "@testing-library/react";

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
vi.mock("@/pages/SettingsView", () => ({ SettingsView: () => <div>Settings page</div> }));

import App from "@/App";

describe("App routing", () => {
  it("renders the Settings hub at its public hash route", () => {
    window.location.hash = "/settings";
    render(<App />);

    expect(screen.getByTestId("shell")).toContainElement(screen.getByText("Settings page"));
  });
});
