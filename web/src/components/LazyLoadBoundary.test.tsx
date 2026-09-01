import { lazy, Suspense } from "react";
import { render, screen } from "@testing-library/react";

import { LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { failOnReactActWarning } from "@/test/console";

describe("LazyLoadBoundary", () => {
  it("contains a rejected lazy import behind fixed recovery UI", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => failOnReactActWarning(args));
    const RejectedChunk = lazy(async () => {
      throw new Error("private chunk URL");
    });

    render(
      <LazyLoadBoundary label="Reports" resetKey="reports">
        <Suspense fallback={<div>Loading reports</div>}>
          <RejectedChunk />
        </Suspense>
      </LazyLoadBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Reports could not be loaded.");
    expect(screen.getByRole("button", { name: "Reload Borealis" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("private chunk URL");
    consoleError.mockRestore();
  });
});
