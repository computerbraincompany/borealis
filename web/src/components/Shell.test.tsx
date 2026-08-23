import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  getUser: () => ({ id: "u1", email: "user@example.test" }),
  clearSession: vi.fn(),
}));

vi.mock("@/components/ThemeMenu", () => ({ ThemeMenu: () => null }));

import { Shell } from "@/components/Shell";

describe("Shell", () => {
  it("turns the global New chat action into an explicit creation route", () => {
    window.location.hash = "/sources";
    render(<Shell>content</Shell>);

    fireEvent.click(screen.getByRole("button", { name: /New chat/i }));
    expect(window.location.hash).toMatch(/^#\/chat\/new\?request=\d+$/);
  });
});
