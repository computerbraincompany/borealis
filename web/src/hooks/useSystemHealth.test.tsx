import { act, renderHook, waitFor } from "@testing-library/react";
import { useSystemHealth } from "@/hooks/useSystemHealth";
import { systemApi, type SystemHealthResponse } from "@/lib/api";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const healthySystem: SystemHealthResponse = {
  status: "operational",
  checked_at: "2026-08-26T09:30:00.000Z",
  services: [],
};

describe("useSystemHealth", () => {
  it("checks immediately and supports an explicit refresh", async () => {
    const health = vi.spyOn(systemApi, "health").mockResolvedValue(healthySystem);
    const { result } = renderHook(() => useSystemHealth());

    await waitFor(() => expect(result.current.health).toEqual(healthySystem));
    expect(health).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });
    expect(health).toHaveBeenCalledTimes(2);
    expect(result.current.checking).toBe(false);
  });

  it("keeps the last completed check when a refresh fails", async () => {
    vi.spyOn(systemApi, "health")
      .mockResolvedValueOnce(healthySystem)
      .mockRejectedValueOnce(new Error("untrusted service trace"));
    const { result } = renderHook(() => useSystemHealth());
    await waitFor(() => expect(result.current.health).toEqual(healthySystem));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.health).toEqual(healthySystem);
    expect(result.current.error).toBe("System status is temporarily unavailable.");
  });

  it("does not apply a completed response after unmount", async () => {
    const pending = deferred<SystemHealthResponse>();
    vi.spyOn(systemApi, "health").mockReturnValue(pending.promise);
    const view = renderHook(() => useSystemHealth());

    view.unmount();
    await act(async () => pending.resolve(healthySystem));

    expect(systemApi.health).toHaveBeenCalledOnce();
  });
});
