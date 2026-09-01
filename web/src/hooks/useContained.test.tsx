import { act, renderHook, waitFor } from "@testing-library/react";
import { useContained } from "@/hooks/useContained";
import { containedApi, type ContainedConfig, type ContainedResponse } from "@/lib/api";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const engineOff: ContainedResponse["engine"] = {
  state: "off",
  model: null,
  endpoint_host: null,
  endpoint_managed_by_env: false,
  pid: null,
  started_at: null,
  error: null,
};

const savedConfig: ContainedResponse["config"] = {
  enabled: true,
  binary_path: "/opt/homebrew/bin/llama-server",
  model_path: "/Users/operator/Models/tinyllama.gguf",
  extra_args: [],
};

const payload: ContainedResponse = { config: null, engine: engineOff, downloads: [] };

function responseWith(overrides: Partial<ContainedResponse>): ContainedResponse {
  return { ...payload, ...overrides };
}

describe("useContained", () => {
  it("loads config, engine state, and downloads with an abortable request", async () => {
    const full = responseWith({ config: savedConfig, downloads: [] });
    const get = vi.spyOn(containedApi, "get").mockResolvedValue(full);
    const { result } = renderHook(() => useContained(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(get).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(result.current.config).toEqual(savedConfig);
    expect(result.current.engine).toEqual(engineOff);
    expect(result.current.downloads).toEqual([]);
    expect(result.current.loadError).toBeNull();
  });

  it("does not poll while disabled", async () => {
    const get = vi.spyOn(containedApi, "get").mockResolvedValue(payload);
    const { result } = renderHook(() => useContained(false));

    await act(async () => undefined);
    expect(get).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.engine).toBeNull();
  });

  it("ignores a stale poll response after a newer request wins", async () => {
    const older = deferred<ContainedResponse>();
    const newer = deferred<ContainedResponse>();
    const get = vi.spyOn(containedApi, "get").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useContained(true));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const olderSignal = get.mock.calls[0][0] as AbortSignal;

    let refreshed!: Promise<ContainedResponse | null>;
    act(() => {
      refreshed = result.current.refresh();
    });
    expect(olderSignal.aborted).toBe(true);

    const fresh = responseWith({ engine: { ...engineOff, state: "starting" } });
    await act(async () => newer.resolve(fresh));
    await act(async () => refreshed);
    expect(result.current.engine?.state).toBe("starting");
    expect(result.current.loading).toBe(false);

    await act(async () => older.resolve(responseWith({ engine: { ...engineOff, state: "crashed" } })));

    expect(result.current.engine?.state).toBe("starting");
    expect(result.current.loadError).toBeNull();
  });

  it("aborts polling on unmount and drops the late response", async () => {
    const pending = deferred<ContainedResponse>();
    const get = vi.spyOn(containedApi, "get").mockReturnValue(pending.promise);
    const view = renderHook(() => useContained(true));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const signal = get.mock.calls[0][0] as AbortSignal;

    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(responseWith({ config: savedConfig })));
  });

  it("stops owning an in-flight load when the panel target closes before unmount", async () => {
    const pending = deferred<ContainedResponse>();
    const get = vi.spyOn(containedApi, "get").mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useContained(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const signal = get.mock.calls[0][0] as AbortSignal;

    rerender({ enabled: false });
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(responseWith({ engine: { ...engineOff, state: "healthy" } })));
    expect(result.current.engine).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("saves the configuration draft and applies the stored result", async () => {
    vi.spyOn(containedApi, "get").mockResolvedValue(payload);
    const save = vi.spyOn(containedApi, "saveConfig").mockResolvedValue(savedConfig);
    const { result } = renderHook(() => useContained(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current.saveConfig({
        enabled: true,
        binary_path: savedConfig.binary_path,
        model_path: savedConfig.model_path,
      });
    });

    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledWith(
      { enabled: true, binary_path: savedConfig.binary_path, model_path: savedConfig.model_path },
      expect.any(AbortSignal),
    );
    expect(result.current.config).toEqual(savedConfig);
    expect(result.current.feedback).toEqual({ kind: "success", message: "Contained configuration saved." });
  });

  it("rejects an overlapping mutation while one owns the action slot", async () => {
    vi.spyOn(containedApi, "get").mockResolvedValue(payload);
    const pendingSave = deferred<ContainedConfig>();
    const save = vi.spyOn(containedApi, "saveConfig").mockReturnValue(pendingSave.promise);
    const start = vi.spyOn(containedApi, "startEngine").mockResolvedValue(engineOff);
    const { result } = renderHook(() => useContained(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let first!: Promise<boolean>;
    await act(async () => {
      first = result.current.saveConfig({ enabled: false });
    });
    expect(result.current.action).toBe("saving-config");

    let second = false;
    await act(async () => {
      second = await result.current.startEngine();
    });
    expect(second).toBe(false);
    expect(start).not.toHaveBeenCalled();

    await act(async () => pendingSave.resolve(savedConfig));
    expect(await first).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.action).toBeNull();
  });

  it("surfaces a bounded action failure without reflecting runtime details", async () => {
    vi.spyOn(containedApi, "get").mockResolvedValue(payload);
    vi.spyOn(containedApi, "saveConfig").mockRejectedValue(
      new Error("secret settings path /private/var/contained.json"),
    );
    const { result } = renderHook(() => useContained(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.saveConfig({ enabled: false });
    });

    expect(ok).toBe(false);
    expect(result.current.feedback).toEqual({
      kind: "error",
      message: "The contained configuration could not be saved.",
    });
    expect(result.current.action).toBeNull();
  });

  it("applies engine start and stop responses to the live state", async () => {
    vi.spyOn(containedApi, "get").mockResolvedValue(payload);
    const starting = { ...engineOff, state: "starting" as const, model: "tinyllama.gguf", pid: 4242 };
    const start = vi.spyOn(containedApi, "startEngine").mockResolvedValue(starting);
    const stopped = { ...engineOff, state: "stopped" as const };
    const stop = vi.spyOn(containedApi, "stopEngine").mockResolvedValue(stopped);
    const { result } = renderHook(() => useContained(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startEngine();
    });
    expect(start).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(result.current.engine).toEqual(starting);

    await act(async () => {
      await result.current.stopEngine();
    });
    expect(stop).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(result.current.engine).toEqual(stopped);
    expect(result.current.feedback?.kind).toBe("success");
  });

  it("records a started download and a canceled one", async () => {
    vi.spyOn(containedApi, "get").mockResolvedValue(payload);
    const download = {
      filename: "tinyllama.gguf",
      url_host: "model.example.test",
      state: "downloading" as const,
      bytes_received: 1024,
      total_bytes: 4096,
      error: undefined,
    };
    const startDownload = vi.spyOn(containedApi, "startDownload").mockResolvedValue(download);
    const cancel = vi.spyOn(containedApi, "cancelDownload").mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useContained(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.startDownload({
        url: "https://model.example.test/tinyllama.gguf",
        filename: "tinyllama.gguf",
        sha256: "a".repeat(64),
      });
    });
    expect(startDownload).toHaveBeenCalledWith(
      { url: "https://model.example.test/tinyllama.gguf", filename: "tinyllama.gguf", sha256: "a".repeat(64) },
      expect.any(AbortSignal),
    );
    expect(result.current.downloads).toEqual([download]);

    await act(async () => {
      await result.current.cancelDownload("tinyllama.gguf");
    });
    expect(cancel).toHaveBeenCalledWith("tinyllama.gguf", expect.any(AbortSignal));
    expect(result.current.downloads[0]?.state).toBe("canceled");
  });

  it("keeps the newer state when a superseded mutation settles late", async () => {
    vi.spyOn(containedApi, "get").mockResolvedValue(payload);
    const pendingSave = deferred<ContainedConfig>();
    const save = vi.spyOn(containedApi, "saveConfig").mockReturnValue(pendingSave.promise);
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useContained(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      void result.current.saveConfig({ enabled: false });
    });
    const signal = save.mock.calls[0][1] as AbortSignal;

    rerender({ enabled: false });
    expect(signal.aborted).toBe(true);
    await act(async () => pendingSave.resolve({ ...savedConfig, enabled: false }));

    expect(result.current.config).toBeNull();
    expect(result.current.action).toBeNull();
    expect(result.current.feedback).toBeNull();
  });
});
