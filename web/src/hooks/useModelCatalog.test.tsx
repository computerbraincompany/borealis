import { act, renderHook, waitFor } from "@testing-library/react";
import { useModelCatalog, resetModelCatalogStoreForTests } from "@/hooks/useModelCatalog";
import { modelsApi, type ModelsResponse } from "@/lib/api";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const liveCatalog: ModelsResponse = {
  default_model: "qwen-chat",
  account_default_model: null,
  discovery: "live",
  models: [{ id: "qwen-chat", owned_by: "local" }],
};

describe("useModelCatalog", () => {
  beforeEach(() => resetModelCatalogStoreForTests());

  it("shares one initial request between concurrent consumers", async () => {
    const list = vi.spyOn(modelsApi, "list").mockResolvedValue(liveCatalog);
    const { result } = renderHook(() => [useModelCatalog(), useModelCatalog()] as const);

    await waitFor(() => expect(result.current[0].catalog).toEqual(liveCatalog));

    expect(result.current[1].catalog).toEqual(liveCatalog);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(false);
  });

  it("forces endpoint refresh and retains the last catalog when refresh fails", async () => {
    const list = vi
      .spyOn(modelsApi, "list")
      .mockResolvedValueOnce(liveCatalog)
      .mockRejectedValueOnce(new Error("untrusted provider detail"));
    const { result } = renderHook(() => useModelCatalog());
    await waitFor(() => expect(result.current.catalog).toEqual(liveCatalog));

    await act(async () => {
      await result.current.refresh(true);
    });

    expect(list).toHaveBeenLastCalledWith(true);
    expect(result.current.catalog).toEqual(liveCatalog);
    expect(result.current.error).toBe("The model catalog is temporarily unavailable.");
    expect(result.current.loading).toBe(false);
  });

  it("ignores an older response after a newer forced refresh wins", async () => {
    const older = deferred<ModelsResponse>();
    const newer = deferred<ModelsResponse>();
    const newerCatalog: ModelsResponse = {
      default_model: "new-default",
      account_default_model: null,
      discovery: "live",
      models: [{ id: "new-default" }],
    };
    const olderCatalog: ModelsResponse = {
      default_model: "old-default",
      account_default_model: null,
      discovery: "live",
      models: [{ id: "old-default" }],
    };
    vi.spyOn(modelsApi, "list")
      .mockResolvedValueOnce(liveCatalog)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useModelCatalog());
    await waitFor(() => expect(result.current.catalog).toEqual(liveCatalog));

    let olderRefresh!: Promise<ModelsResponse | null>;
    let newerRefresh!: Promise<ModelsResponse | null>;
    act(() => {
      olderRefresh = result.current.refresh(true);
      newerRefresh = result.current.refresh(true);
    });
    await act(async () => newer.resolve(newerCatalog));
    await newerRefresh;
    await act(async () => older.resolve(olderCatalog));
    await olderRefresh;

    expect(result.current.catalog).toEqual(newerCatalog);
  });

  it("does not apply a response after the final consumer unmounts", async () => {
    const abandoned = deferred<ModelsResponse>();
    const list = vi.spyOn(modelsApi, "list").mockReturnValueOnce(abandoned.promise).mockResolvedValueOnce(liveCatalog);
    const first = renderHook(() => useModelCatalog());

    first.unmount();
    await act(async () => Promise.resolve());
    await act(async () => abandoned.resolve({ ...liveCatalog, default_model: "abandoned" }));

    const second = renderHook(() => useModelCatalog());
    await waitFor(() => expect(second.result.current.catalog).toEqual(liveCatalog));
    expect(list).toHaveBeenCalledTimes(2);
  });
});
