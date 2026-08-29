import { act, renderHook } from "@testing-library/react";
import { connectorsApi, type Connector } from "@/lib/api";
import { connectorPollDelay, isConnectorTransitioning, useConnectorCatalog } from "@/hooks/useConnectorCatalog";

const connector = (sync_status: Connector["sync_status"]): Connector => ({
  id: "connector-1",
  name: "Ledger",
  type: "url_csv",
  config: { url: "https://example.test/data.csv" },
  target_table: "ledger",
  sync_status,
  sync_error: sync_status === "error" ? "Connector sync failed." : null,
  last_sync: null,
  created_at: "2026-01-01T00:00:00Z",
  schedule: null,
});

describe("useConnectorCatalog", () => {
  it("recognizes only canonical transitional statuses and uses bounded backoff", () => {
    expect(isConnectorTransitioning(connector("syncing"))).toBe(true);
    expect(isConnectorTransitioning(connector("indexing"))).toBe(true);
    expect(isConnectorTransitioning(connector("idle"))).toBe(false);
    expect(isConnectorTransitioning(connector("error"))).toBe(false);
    expect([0, 1, 2, 3, 10].map(connectorPollDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
  });

  it("polls a mounted transitioning catalog and stops when it becomes idle", async () => {
    vi.useFakeTimers();
    const list = vi
      .spyOn(connectorsApi, "list")
      .mockResolvedValueOnce([connector("syncing")])
      .mockResolvedValueOnce([connector("idle")]);
    const { result } = renderHook(() => useConnectorCatalog());

    await act(async () => result.current.refresh());
    expect(result.current.connectors[0].sync_status).toBe("syncing");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.connectors[0].sync_status).toBe("idle");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(list).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
