import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@/components/ThemeProvider";

const apiMocks = vi.hoisted(() => ({
  clearSession: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getUser: () => ({ id: "u1", email: "user@example.test" }),
  clearSession: apiMocks.clearSession,
}));

vi.mock("@/components/ThemeProvider", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useTheme: () => ({ theme: "system", resolvedTheme: "light", setTheme: apiMocks.setTheme }),
}));

vi.mock("@/components/WorkspaceStatus", () => ({
  WorkspaceStatus: () => <div data-testid="workspace-status" />,
}));

import { Shell } from "@/components/Shell";

function renderShell() {
  return render(
    <ThemeProvider>
      <Shell>content</Shell>
    </ThemeProvider>,
  );
}

describe("Shell", () => {
  beforeEach(() => {
    apiMocks.clearSession.mockReset();
    apiMocks.setTheme.mockReset();
    window.localStorage.clear();
    delete window.borealisDesktop;
    window.location.hash = "/reports";
  });

  it("does not offer an unusable sign-out action for the passwordless desktop profile", async () => {
    window.borealisDesktop = { consumeBootstrap: vi.fn().mockResolvedValue(null) };
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Account menu for user@example.test" }));

    expect(screen.queryByRole("menuitem", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("renders the cleaned navigation with one truthful active destination", () => {
    const { container } = renderShell();

    expect(screen.getByText("AI data workspace")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-status")).toBeInTheDocument();
    expect(screen.queryByText("ask your data · open source")).not.toBeInTheDocument();
    expect(screen.queryByText("Local instance")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New chat/i })).not.toBeInTheDocument();
    expect(container.querySelector(".aurora-top")).not.toBeInTheDocument();

    const reports = screen.getByRole("link", { name: "Reports" });
    expect(reports).toHaveAttribute("aria-current", "page");
    expect(reports).toHaveClass("rounded-lg", "bg-accent", "font-semibold");
    expect(reports).not.toHaveClass("border-l-2", "border-primary");
    expect(reports.querySelector("span")).toBeNull();
    expect(screen.getByRole("link", { name: "Chat" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("opens a compact account menu with the full email and signs out", async () => {
    const user = userEvent.setup();
    renderShell();

    const trigger = screen.getByRole("button", { name: "Account menu for user@example.test" });
    expect(trigger).toHaveAttribute("title", "user@example.test");
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).not.toBeInTheDocument();

    await user.click(trigger);

    expect(screen.getAllByText("user@example.test")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "#/settings");
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(apiMocks.clearSession).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("#/login");
  });

  it("offers appearance choices in a nested account submenu", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "Account menu for user@example.test" }));

    await user.hover(screen.getByRole("menuitem", { name: /Appearance System/ }));
    const dark = await screen.findByRole("menuitemradio", { name: /Dark Always use dark/ });
    const system = screen.getByRole("menuitemradio", { name: /System Match this device/ });
    expect(system).toHaveClass("bg-accent", "font-medium");
    expect(system).not.toHaveClass("border-l-2", "border-l-primary");
    fireEvent.click(dark);

    expect(apiMocks.setTheme).toHaveBeenCalledWith("dark");
  });
});
