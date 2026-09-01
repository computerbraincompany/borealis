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
const page = (items: Connector[], next_cursor: string | null = null) => ({ items, next_cursor });

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
      .mockResolvedValueOnce(page([connector("syncing")]))
      .mockResolvedValueOnce(page([connector("idle")]));
    vi.spyOn(connectorsApi, "status").mockResolvedValue({ items: [connector("idle")], missing_ids: [] });
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

  it("loads an older connector page without dropping the first page", async () => {
    const older = { ...connector("idle"), id: "connector-older", name: "Archive feed" };
    const list = vi
      .spyOn(connectorsApi, "list")
      .mockResolvedValueOnce(page([connector("idle")], "connectors-page-2"))
      .mockResolvedValueOnce(page([older]));
    const { result } = renderHook(() => useConnectorCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.loadMore());

    expect(result.current.connectors.map((item) => item.id)).toEqual(["connector-1", "connector-older"]);
    expect(result.current.hasMore).toBe(false);
    expect(list).toHaveBeenNthCalledWith(2, { cursor: "connectors-page-2" });
  });

  it("retains a refreshed continuation after the previous traversal completed", async () => {
    const newest = connector("idle");
    const refreshed = { ...newest, name: "Ledger refreshed" };
    const older = { ...newest, id: "connector-older", name: "Archive feed" };
    const refreshedOlder = {
      ...older,
      sync_status: "error" as const,
      sync_error: "Connector sync failed.",
      last_sync: "2026-01-02T00:00:00Z",
    };
    const inserted = { ...newest, id: "connector-inserted", name: "Inserted feed" };
    const list = vi
      .spyOn(connectorsApi, "list")
      .mockResolvedValueOnce(page([newest], "old-page-2"))
      .mockResolvedValueOnce(page([older]))
      .mockResolvedValueOnce(page([refreshed], "fresh-page-2"))
      .mockResolvedValueOnce(page([inserted, refreshedOlder]));
    const { result } = renderHook(() => useConnectorCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.loadMore());
    expect(result.current.hasMore).toBe(false);

    await act(async () => result.current.refresh());
    expect(result.current.hasMore).toBe(true);
    await act(async () => result.current.loadMore());

    expect(result.current.connectors.map((item) => item.id)).toEqual([
      "connector-1",
      "connector-older",
      "connector-inserted",
    ]);
    expect(new Set(result.current.connectors.map((item) => item.id)).size).toBe(result.current.connectors.length);
    expect(result.current.connectors.find((item) => item.id === older.id)).toEqual(refreshedOlder);
    expect(list).toHaveBeenLastCalledWith({ cursor: "fresh-page-2" });
  });

  it("polls a transitioning connector through its previously loaded continuation page", async () => {
    const newest = connector("idle");
    const older = { ...newest, id: "connector-older", name: "Archive feed" };
    const transitioning = { ...older, sync_status: "syncing" as const };
    const completed = { ...older, last_sync: "2026-01-02T00:00:00Z" };
    const list = vi
      .spyOn(connectorsApi, "list")
      .mockResolvedValueOnce(page([newest], "older-page"))
      .mockResolvedValueOnce(page([older]))
      .mockResolvedValueOnce(page([newest], "fresh-older-page"));
    const status = vi.spyOn(connectorsApi, "status").mockResolvedValue({ items: [completed], missing_ids: [] });
    const { result } = renderHook(() => useConnectorCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.loadMore());
    act(() => result.current.applyOne(transitioning));
    expect(result.current.connectors.find((item) => item.id === older.id)?.sync_status).toBe("syncing");

    await act(async () => result.current.refresh());

    expect(result.current.connectors.find((item) => item.id === older.id)).toEqual(completed);
    expect(list).toHaveBeenLastCalledWith();
    expect(status).toHaveBeenCalledWith([older.id]);
  });

  it("refreshes a transitioning head row after newer rows displace it beyond page one", async () => {
    const transitioning = { ...connector("syncing"), id: "connector-displaced" };
    const completed = { ...transitioning, sync_status: "idle" as const, last_sync: "2026-01-02T00:00:00Z" };
    const newer = Array.from({ length: 50 }, (_, index) => ({
      ...connector("idle"),
      id: `connector-newer-${index}`,
      name: `Newer ${index}`,
    }));
    const list = vi
      .spyOn(connectorsApi, "list")
      .mockResolvedValueOnce(page([transitioning]))
      .mockResolvedValueOnce(page(newer, "page-2"));
    const status = vi.spyOn(connectorsApi, "status").mockResolvedValue({ items: [completed], missing_ids: [] });
    const { result } = renderHook(() => useConnectorCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.refresh());

    expect(result.current.connectors.find((item) => item.id === transitioning.id)).toEqual(completed);
    expect(status).toHaveBeenCalledWith([transitioning.id]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("applies an exact transition result when the concurrent head refresh fails", async () => {
    const transitioning = connector("syncing");
    const completed = connector("idle");
    vi.spyOn(connectorsApi, "list")
      .mockResolvedValueOnce(page([transitioning]))
      .mockRejectedValueOnce(new Error("head failed"));
    vi.spyOn(connectorsApi, "status").mockResolvedValue({ items: [completed], missing_ids: [] });
    const { result } = renderHook(() => useConnectorCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.refresh());

    expect(result.current.connectors).toEqual([completed]);
    expect(result.current.error).toContain("Some connector statuses");
  });
});
