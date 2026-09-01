import { act, renderHook, waitFor } from "@testing-library/react";
import { useEgressAudit } from "@/hooks/useEgressAudit";
import { auditApi, type EgressEvent } from "@/lib/api";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const firstEvent: EgressEvent = {
  id: 1,
  kind: "remote_turn",
  endpoint_host: "models.example.test",
  created_at: "2026-08-31T00:00:00.000Z",
};

describe("useEgressAudit", () => {
  it("loads the bounded audit page", async () => {
    const egress = vi.spyOn(auditApi, "egress").mockResolvedValue([firstEvent]);
    const { result } = renderHook(() => useEgressAudit());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.events).toEqual([firstEvent]);
    expect(egress).toHaveBeenCalledWith(50, expect.any(AbortSignal));
  });

  it("aborts and ignores an older refresh after a newer request wins", async () => {
    const initial = deferred<EgressEvent[]>();
    const newer = deferred<EgressEvent[]>();
    const egress = vi.spyOn(auditApi, "egress").mockReturnValueOnce(initial.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useEgressAudit());
    await waitFor(() => expect(egress).toHaveBeenCalledTimes(1));
    const initialSignal = egress.mock.calls[0][1] as AbortSignal;

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    expect(initialSignal.aborted).toBe(true);

    const newestEvent = { ...firstEvent, id: 2 };
    await act(async () => newer.resolve([newestEvent]));
    await refresh;
    await act(async () => initial.resolve([firstEvent]));

    expect(result.current.events).toEqual([newestEvent]);
  });

  it("aborts an in-flight request when the final consumer unmounts", async () => {
    const pending = deferred<EgressEvent[]>();
    const egress = vi.spyOn(auditApi, "egress").mockReturnValue(pending.promise);
    const view = renderHook(() => useEgressAudit());
    await waitFor(() => expect(egress).toHaveBeenCalledTimes(1));
    const signal = egress.mock.calls[0][1] as AbortSignal;

    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve([firstEvent]));
  });
});
