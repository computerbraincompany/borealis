import { describe, expect, it } from "vitest";
import { sourceStatusPresentation } from "./sourceStatus";

describe("sourceStatusPresentation", () => {
  it("maps every server status to one shared label and tone", () => {
    expect(sourceStatusPresentation("ready")).toEqual({ label: "Ready", tone: "success" });
    expect(sourceStatusPresentation("index")).toEqual({ label: "Processing", tone: "pending" });
    expect(sourceStatusPresentation("error")).toEqual({ label: "Needs attention", tone: "destructive" });
  });

  it("keeps unknown future statuses visible and fail-loud instead of blank", () => {
    expect(sourceStatusPresentation("quarantined")).toEqual({ label: "quarantined", tone: "destructive" });
  });
});
