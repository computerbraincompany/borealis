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
    const staleList = deferred<Source[]>();
    const list = vi.spyOn(sourcesApi, "list").mockReturnValueOnce(staleList.promise).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useSourceCatalog());

    let staleRefresh!: Promise<void>;
    act(() => {
      staleRefresh = result.current.refresh();
    });
    act(() => result.current.addPending(pendingSource));
    expect(result.current.sources).toEqual([pendingSource]);

    await act(async () => staleList.resolve([]));
    await staleRefresh;
    expect(result.current.sources).toEqual([pendingSource]);

    await act(async () => result.current.refresh());
    expect(result.current.sources).toEqual([]);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
