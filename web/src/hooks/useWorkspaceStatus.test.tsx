import { act, renderHook, waitFor } from "@testing-library/react";
import { useWorkspaceStatus } from "@/hooks/useWorkspaceStatus";
import { systemApi, type WorkspaceStatusResponse } from "@/lib/api";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const localStatus: WorkspaceStatusResponse = {
  locality: "local",
  endpoint_reachable: true,
  lm_studio_reachable: null,
  chat_model: "qwen3-32b",
  embed_model: "bge-m3",
  contained: null,
  checked_at: "2026-08-29T10:00:00.000Z",
  latency_ms: 12,
};

describe("useWorkspaceStatus", () => {
  it("checks immediately and supports an explicit refresh", async () => {
    const status = vi.spyOn(systemApi, "workspaceStatus").mockResolvedValue(localStatus);
    const { result } = renderHook(() => useWorkspaceStatus());

    await waitFor(() => expect(result.current.status).toEqual(localStatus));
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });
    expect(status).toHaveBeenCalledTimes(2);
    expect(result.current.checking).toBe(false);
  });

  it("keeps the last completed snapshot when a refresh fails", async () => {
    vi.spyOn(systemApi, "workspaceStatus")
      .mockResolvedValueOnce(localStatus)
      .mockRejectedValueOnce(new Error("untrusted service trace"));
    const { result } = renderHook(() => useWorkspaceStatus());
    await waitFor(() => expect(result.current.status).toEqual(localStatus));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status).toEqual(localStatus);
    expect(result.current.error).toBe("Workspace status is temporarily unavailable.");
  });

  it("does not apply a completed response after unmount", async () => {
    const pending = deferred<WorkspaceStatusResponse>();
    vi.spyOn(systemApi, "workspaceStatus").mockReturnValue(pending.promise);
    const view = renderHook(() => useWorkspaceStatus());

    view.unmount();
    await act(async () => pending.resolve(localStatus));

    expect(systemApi.workspaceStatus).toHaveBeenCalledOnce();
  });
});
