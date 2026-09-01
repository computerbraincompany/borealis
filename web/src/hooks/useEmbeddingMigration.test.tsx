import { act, renderHook } from "@testing-library/react";
import { useEmbeddingMigration } from "@/hooks/useEmbeddingMigration";
import { modelsApi, type EmbeddingMigrationStatus } from "@/lib/api";

const building: EmbeddingMigrationStatus = {
  phase: "building",
  target_model: "embed-v2",
  target_dimension: 384,
  source_count: 2,
  chunk_count: 10,
  indexed_count: 3,
  error_code: null,
  restart_required: false,
  can_cancel: true,
  can_retry: false,
  can_apply: false,
};

describe("useEmbeddingMigration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls an active build and stops once the staged index is ready", async () => {
    vi.useFakeTimers();
    const ready: EmbeddingMigrationStatus = {
      ...building,
      phase: "ready_to_apply",
      indexed_count: 10,
      can_apply: true,
    };
    const status = vi
      .spyOn(modelsApi, "embeddingMigrationStatus")
      .mockResolvedValueOnce(building)
      .mockResolvedValueOnce(ready);

    const { result } = renderHook(() => useEmbeddingMigration(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status?.phase).toBe("building");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(status).toHaveBeenCalledTimes(2);
    expect(result.current.status?.phase).toBe("ready_to_apply");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("does not poll before the Models settings section is enabled", async () => {
    const status = vi.spyOn(modelsApi, "embeddingMigrationStatus").mockResolvedValue(building);
    const { rerender } = renderHook(({ enabled }) => useEmbeddingMigration(enabled), {
      initialProps: { enabled: false },
    });
    await act(async () => Promise.resolve());
    expect(status).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(status).toHaveBeenCalledOnce();
  });
});
