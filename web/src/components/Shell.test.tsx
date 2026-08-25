import { fireEvent, render, screen } from "@testing-library/react";

const apiMocks = vi.hoisted(() => ({
  clearSession: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getUser: () => ({ id: "u1", email: "user@example.test" }),
  clearSession: apiMocks.clearSession,
}));

vi.mock("@/components/ThemeMenu", () => ({ ThemeMenu: () => null }));

import { Shell } from "@/components/Shell";

describe("Shell", () => {
  beforeEach(() => {
    apiMocks.clearSession.mockReset();
    window.location.hash = "/reports";
  });

  it("renders the cleaned navigation with one truthful active destination", () => {
    const { container } = render(<Shell>content</Shell>);

    expect(screen.getByText("AI data workspace")).toBeInTheDocument();
    expect(screen.queryByText("ask your data · open source")).not.toBeInTheDocument();
    expect(screen.queryByText("Local instance")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New chat/i })).not.toBeInTheDocument();
    expect(container.querySelector(".aurora-top")).not.toBeInTheDocument();

    const reports = screen.getByRole("link", { name: "Reports" });
    expect(reports).toHaveAttribute("aria-current", "page");
    expect(reports.querySelector("span")).toBeNull();
    expect(screen.getByRole("link", { name: "Chat" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#/settings");
  });

  it("keeps the account controls and signs out to the login route", () => {
    render(<Shell>content</Shell>);

    const email = screen.getByText("user@example.test");
    expect(email).toBeInTheDocument();
    expect(email).toHaveClass("break-words");
    expect(email).not.toHaveClass("truncate");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(apiMocks.clearSession).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("#/login");
  });
});
