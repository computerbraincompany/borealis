import { act, renderHook } from "@testing-library/react";
import { sourcesApi, type Source } from "@/lib/api";
import { useSourceCatalog } from "@/hooks/useSourceCatalog";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const pendingSource: Source = {
  id: "source-new",
  name: "source_new",
  display_name: "New source",
  kind: "document",
  mime: "text/plain",
  status: "index",
  created_at: "2026-01-01T00:00:00Z",
};

describe("useSourceCatalog", () => {
  it("preserves an upload across a stale in-flight list response, then bounds a missing ghost", async () => {
    const staleList = deferred<{ items: Source[]; next_cursor: string | null }>();
    const list = vi
      .spyOn(sourcesApi, "list")
      .mockReturnValueOnce(staleList.promise)
      .mockResolvedValueOnce({ items: [], next_cursor: null });
    const status = vi.spyOn(sourcesApi, "status").mockResolvedValue({ items: [], missing_ids: [pendingSource.id] });
    const { result } = renderHook(() => useSourceCatalog());

    let staleRefresh!: Promise<void>;
    act(() => {
      staleRefresh = result.current.refresh();
    });
    act(() => result.current.addPending(pendingSource));
    expect(result.current.sources).toEqual([pendingSource]);

    await act(async () => staleList.resolve({ items: [], next_cursor: null }));
    await staleRefresh;
    expect(result.current.sources).toEqual([pendingSource]);

    await act(async () => result.current.refresh());
    expect(result.current.sources).toEqual([]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledWith([pendingSource.id]);
  });

  it("keeps accepted older pages while page-one polling refreshes newer rows", async () => {
    const newest = { ...pendingSource, id: "source-newest", display_name: "Newest", status: "ready" as const };
    const refreshed = { ...newest, status: "ready" as const };
    const older = { ...pendingSource, id: "source-older", display_name: "Older", status: "ready" as const };
    const list = vi
      .spyOn(sourcesApi, "list")
      .mockResolvedValueOnce({ items: [newest], next_cursor: "page-2" })
      .mockResolvedValueOnce({ items: [older], next_cursor: null })
      .mockResolvedValueOnce({ items: [refreshed], next_cursor: null });
    const { result } = renderHook(() => useSourceCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.loadMore());
    await act(async () => result.current.refresh());

    expect(result.current.sources).toEqual([refreshed, older]);
    expect(result.current.hasMore).toBe(false);
    expect(list.mock.calls).toEqual([[], [{ cursor: "page-2" }], []]);
  });

  it("starts a fresh traversal after a completed catalog later grows beyond page one", async () => {
    const newest = { ...pendingSource, id: "source-newest", display_name: "Newest", status: "ready" as const };
    const refreshed = { ...newest, status: "ready" as const };
    const older = { ...pendingSource, id: "source-older", display_name: "Older", status: "ready" as const };
    const refreshedOlder = { ...older, display_name: "Older refreshed", status: "ready" as const };
    const inserted = { ...pendingSource, id: "source-inserted", display_name: "Inserted", status: "ready" as const };
    const list = vi
      .spyOn(sourcesApi, "list")
      .mockResolvedValueOnce({ items: [newest], next_cursor: "old-page-2" })
      .mockResolvedValueOnce({ items: [older], next_cursor: null })
      .mockResolvedValueOnce({ items: [refreshed], next_cursor: "fresh-page-2" })
      .mockResolvedValueOnce({ items: [inserted, refreshedOlder], next_cursor: null });
    const { result } = renderHook(() => useSourceCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.loadMore());
    expect(result.current.hasMore).toBe(false);

    await act(async () => result.current.refresh());
    expect(result.current.hasMore).toBe(true);
    await act(async () => result.current.loadMore());

    expect(result.current.sources.map((source) => source.id)).toEqual([
      "source-newest",
      "source-older",
      "source-inserted",
    ]);
    expect(new Set(result.current.sources.map((source) => source.id)).size).toBe(result.current.sources.length);
    expect(result.current.sources.find((source) => source.id === older.id)).toEqual(refreshedOlder);
    expect(list.mock.calls).toEqual([[], [{ cursor: "old-page-2" }], [], [{ cursor: "fresh-page-2" }]]);
  });

  it("refreshes a transitioning source through its previously loaded continuation page", async () => {
    const newest = { ...pendingSource, id: "source-newest", display_name: "Newest", status: "ready" as const };
    const older = { ...pendingSource, id: "source-older", display_name: "Older", status: "ready" as const };
    const queuedOlder = { ...older, status: "index" as const };
    const refreshedOlder = { ...older, display_name: "Older ready again" };
    const list = vi
      .spyOn(sourcesApi, "list")
      .mockResolvedValueOnce({ items: [newest], next_cursor: "older-page" })
      .mockResolvedValueOnce({ items: [older], next_cursor: null })
      .mockResolvedValueOnce({ items: [newest], next_cursor: "fresh-older-page" });
    const status = vi.spyOn(sourcesApi, "status").mockResolvedValue({ items: [refreshedOlder], missing_ids: [] });
    const { result } = renderHook(() => useSourceCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.loadMore());
    act(() => result.current.applyOne(queuedOlder));
    expect(result.current.sources.find((source) => source.id === older.id)?.status).toBe("index");

    await act(async () => result.current.refresh());

    expect(result.current.sources.find((source) => source.id === older.id)).toEqual(refreshedOlder);
    expect(list).toHaveBeenLastCalledWith();
    expect(status).toHaveBeenCalledWith([older.id]);
  });

  it("refreshes a transitioning head row after newer rows displace it beyond page one", async () => {
    const transitioning = { ...pendingSource, id: "source-displaced", display_name: "Displaced" };
    const completed = { ...transitioning, status: "ready" as const };
    const newer = Array.from({ length: 50 }, (_, index) => ({
      ...pendingSource,
      id: `source-newer-${index}`,
      display_name: `Newer ${index}`,
      status: "ready" as const,
    }));
    const list = vi
      .spyOn(sourcesApi, "list")
      .mockResolvedValueOnce({ items: [transitioning], next_cursor: null })
      .mockResolvedValueOnce({ items: newer, next_cursor: "page-2" });
    const status = vi.spyOn(sourcesApi, "status").mockResolvedValue({ items: [completed], missing_ids: [] });
    const { result } = renderHook(() => useSourceCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.refresh());

    expect(result.current.sources.find((source) => source.id === transitioning.id)).toEqual(completed);
    expect(status).toHaveBeenCalledWith([transitioning.id]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("applies an exact transition result when the concurrent head refresh fails", async () => {
    const transitioning = { ...pendingSource, id: "source-exact", display_name: "Exact" };
    const completed = { ...transitioning, status: "ready" as const };
    vi.spyOn(sourcesApi, "list")
      .mockResolvedValueOnce({ items: [transitioning], next_cursor: null })
      .mockRejectedValueOnce(new Error("head failed"));
    vi.spyOn(sourcesApi, "status").mockResolvedValue({ items: [completed], missing_ids: [] });
    const { result } = renderHook(() => useSourceCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.refresh());

    expect(result.current.sources).toEqual([completed]);
    expect(result.current.error).toContain("Some source statuses");
  });

  it("rotates a failed bounded status batch so later transitions are not starved", async () => {
    const transitioning = Array.from({ length: 60 }, (_, index) => ({
      ...pendingSource,
      id: `source-transition-${index}`,
      display_name: `Transition ${index}`,
    }));
    vi.spyOn(sourcesApi, "list").mockResolvedValue({ items: transitioning, next_cursor: null });
    const status = vi
      .spyOn(sourcesApi, "status")
      .mockRejectedValueOnce(new Error("status unavailable"))
      .mockImplementation(async (ids) => ({
        items: transitioning.filter((source) => ids.includes(source.id)),
        missing_ids: [],
      }));
    const { result } = renderHook(() => useSourceCatalog());

    await act(async () => result.current.refresh());
    await act(async () => result.current.refresh());
    await act(async () => result.current.refresh());

    expect(status.mock.calls[0]?.[0]).toHaveLength(50);
    expect(status.mock.calls[1]?.[0]).toContain("source-transition-50");
  });

  it("rejects a stale load-more page after page-one refresh takes ownership", async () => {
    const olderPage = deferred<{ items: Source[]; next_cursor: string | null }>();
    const newest = { ...pendingSource, id: "source-newest", display_name: "Newest", status: "ready" as const };
    const refreshed = { ...newest, status: "ready" as const };
    vi.spyOn(sourcesApi, "list")
      .mockResolvedValueOnce({ items: [newest], next_cursor: "old-cursor" })
      .mockReturnValueOnce(olderPage.promise)
      .mockResolvedValueOnce({ items: [refreshed], next_cursor: "fresh-cursor" });
    const { result } = renderHook(() => useSourceCatalog());

    await act(async () => result.current.refresh());
    let staleLoad!: Promise<void>;
    act(() => {
      staleLoad = result.current.loadMore();
    });
    await act(async () => result.current.refresh());
    await act(async () => olderPage.resolve({ items: [{ ...pendingSource, id: "stale" }], next_cursor: null }));
    await staleLoad;

    expect(result.current.sources).toEqual([refreshed]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loadingMore).toBe(false);
  });
});
