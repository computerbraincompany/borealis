import { act, renderHook } from "@testing-library/react";
import { parseSourceListPayload, type AttachedSource, type Source } from "@/lib/api";
import { shouldPollSources, sourcePollDelay, usePendingSourcePolling } from "@/lib/sourcePolling";
import { reconcileAttachedSources } from "@/lib/sourceScope";

const readySource: Source = {
  id: "s1",
  name: "source_one",
  display_name: "Source one",
  kind: "tabular",
  mime: "text/csv",
  status: "ready",
  created_at: "2026-01-01T00:00:00Z",
};

describe("source catalog decisions", () => {
  it("polls only while server or locally-created sources are pending and backs off", () => {
    expect(shouldPollSources([readySource])).toBe(false);
    expect(shouldPollSources([{ status: "error" }])).toBe(false);
    expect(shouldPollSources([{ status: "index" }])).toBe(true);
    expect(shouldPollSources([], true)).toBe(true);
    expect([0, 1, 2, 3, 4, 20].map(sourcePollDelay)).toEqual([2_000, 4_000, 8_000, 15_000, 30_000, 30_000]);
  });

  it("preserves selected-empty as deny-all while all mode follows the catalog", () => {
    expect(reconcileAttachedSources("selected", [], [readySource])).toEqual([]);
    expect(reconcileAttachedSources("all", [], [readySource])).toHaveLength(1);

    const attached: AttachedSource = { ...readySource };
    const renamed = { ...readySource, display_name: "Updated name" };
    expect(reconcileAttachedSources("selected", [attached], [renamed])).toEqual([
      expect.objectContaining({ id: "s1", display_name: "Updated name" }),
    ]);
  });

  it("accepts compact source rows defensively and drops malformed entries", () => {
    expect(
      parseSourceListPayload([
        { ...readySource, mime: undefined, created_at: undefined },
        { id: "broken", status: "ready" },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "s1",
        mime: "application/octet-stream",
        created_at: "",
      }),
    ]);
  });

  it("does not schedule another polling cycle after unmounting an in-flight refresh", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { unmount } = renderHook(() => usePendingSourcePolling([{ status: "index" }], refresh));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => finish());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
