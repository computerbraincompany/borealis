import { failOnReactActWarning } from "@/test/console";

describe("React console policy", () => {
  it("fails recognized asynchronous act warnings", () => {
    expect(() =>
      failOnReactActWarning(["Warning: An update to ReportsView inside a test was not wrapped in act(...)."]),
    ).toThrow("unexpected React act warning");
  });

  it("allows expected error-boundary diagnostics to be suppressed by focused tests", () => {
    expect(() => failOnReactActWarning(["Error: expected lazy import failure"])).not.toThrow();
  });
});
