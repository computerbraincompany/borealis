import { act, renderHook, waitFor } from "@testing-library/react";
import { connectionsApi, type ConnectionDetailDto, type ConnectionDto } from "@/lib/api";
import { useConnections } from "@/hooks/useConnections";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function connectionRow(overrides: Partial<ConnectionDto> = {}): ConnectionDto {
  return {
    id: "conn-1",
    name: "Ops tools",
    kind: "mcp_http",
    revision: 3,
    discovery_revision: 0,
    enabled: true,
    status: "untested",
    status_code: null,
    config: { kind: "mcp_http", url: "https://mcp.example.test/mcp" },
    credential_state: "none",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function detailRow(overrides: Partial<ConnectionDetailDto> = {}): ConnectionDetailDto {
  return { ...connectionRow(), tools: [], ...overrides };
}

describe("useConnections", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the catalog with an abortable request", async () => {
    const list = vi.spyOn(connectionsApi, "list").mockResolvedValue({
      items: [connectionRow()],
      next_cursor: null,
    });
    const { result } = renderHook(() => useConnections(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.current.connections.map((row) => row.id)).toEqual(["conn-1"]);
    expect(result.current.loadError).toBeNull();
  });

  it("ignores a stale catalog response after a newer refresh wins", async () => {
    const older = deferred<Awaited<ReturnType<typeof connectionsApi.list>>>();
    const newer = deferred<Awaited<ReturnType<typeof connectionsApi.list>>>();
    const list = vi.spyOn(connectionsApi, "list").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useConnections(true));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    act(() => {
      void result.current.refresh();
    });
    await act(async () => newer.resolve({ items: [], next_cursor: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connections).toEqual([]);

    // The superseded page resolves late; it must not replace the newer state.
    await act(async () => older.resolve({ items: [connectionRow({ id: "stale" })], next_cursor: null }));
    expect(result.current.connections.map((row) => row.id)).not.toContain("stale");
  });

  it("aborts catalog loading on unmount and drops the late response", async () => {
    const pending = deferred<Awaited<ReturnType<typeof connectionsApi.list>>>();
    const list = vi.spyOn(connectionsApi, "list").mockReturnValue(pending.promise);
    const view = renderHook(() => useConnections(true));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const signal = (list.mock.calls[0] as [{ signal?: AbortSignal }])[0].signal!;

    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ items: [connectionRow()], next_cursor: null }));
  });

  it("keeps a deleted row gone even when an in-flight list response arrives afterwards", async () => {
    const stalePage = deferred<Awaited<ReturnType<typeof connectionsApi.list>>>();
    const list = vi.spyOn(connectionsApi, "list").mockReturnValueOnce(stalePage.promise);
    const remove = vi.spyOn(connectionsApi, "remove").mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useConnections(true));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // Start a second (stale) traversal while the delete resolves first.
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => {
      await result.current.remove("conn-1");
    });
    expect(result.current.connections).toEqual([]);

    // The older page still contains the deleted row; the generation bump
    // (AgentsView rule) must prevent it from resurrecting.
    await act(async () => stalePage.resolve({ items: [connectionRow()], next_cursor: null }));
    expect(result.current.connections.map((row) => row.id)).not.toContain("conn-1");
    void remove;
  });

  it("applies a test result to its exact connection and reports the bounded failure", async () => {
    vi.spyOn(connectionsApi, "list").mockResolvedValue({ items: [connectionRow()], next_cursor: null });
    const test = vi
      .spyOn(connectionsApi, "test")
      .mockResolvedValue(connectionRow({ id: "conn-1", status: "ready", revision: 3 }));
    const { result } = renderHook(() => useConnections(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.test("conn-1");
    });
    await waitFor(() => expect(connectionsApi.test).toHaveBeenCalledWith("conn-1", expect.any(AbortSignal)));
    expect(result.current.connections[0]?.status).toBe("ready");
    expect(result.current.feedback?.kind).toBe("success");

    test.mockRejectedValue(new Error("boom"));
    await act(async () => {
      await result.current.test("conn-1");
    });
    expect(result.current.feedback?.kind).toBe("error");
  });

  it("rejects an overlapping mutation while one owns the action slot", async () => {
    vi.spyOn(connectionsApi, "list").mockResolvedValue({ items: [connectionRow()], next_cursor: null });
    const pending = deferred<ConnectionDto>();
    const test = vi.spyOn(connectionsApi, "test").mockReturnValue(pending.promise);
    const discover = vi.spyOn(connectionsApi, "discover");
    const { result } = renderHook(() => useConnections(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      void result.current.test("conn-1");
    });
    let second = true;
    await act(async () => {
      second = await result.current.discover("conn-1");
    });
    expect(second).toBe(false);
    expect(discover).not.toHaveBeenCalled();

    await act(async () => pending.resolve(connectionRow({ status: "ready" })));
    expect(test).toHaveBeenCalledTimes(1);
    expect(result.current.action).toBeNull();
  });

  it("starts a sign-in session and polls the row to a terminal success", async () => {
    vi.spyOn(connectionsApi, "list").mockResolvedValue({ items: [connectionRow()], next_cursor: null });
    const authorize = vi.spyOn(connectionsApi, "authorize").mockResolvedValue({
      authorize_url: "https://idp.example.test/authorize?x=1",
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      desktop_open_token: "token-value",
    });
    const get = vi
      .spyOn(connectionsApi, "get")
      .mockResolvedValue(detailRow({ status: "ready", credential_state: "stored", status_code: null }));
    const { result } = renderHook(() => useConnections(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.useFakeTimers();
    try {
      await act(async () => {
        await result.current.authorize("conn-1");
      });
      expect(authorize).toHaveBeenCalledWith("conn-1", expect.any(AbortSignal));
      expect(result.current.authSession).toMatchObject({
        connectionId: "conn-1",
        authorizeUrl: "https://idp.example.test/authorize?x=1",
        desktopOpenToken: "token-value",
      });

      // The poll owns a 3-second timer; drive it deterministically. waitFor is
      // not usable under fake timers, so assertions run after the advance.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(get).toHaveBeenCalledWith("conn-1", expect.any(AbortSignal));
    expect(result.current.authSession).toBeNull();
    expect(result.current.feedback?.kind).toBe("success");
    expect(result.current.connections[0]?.status).toBe("ready");
  });

  it("surfaces a terminal sign-in failure code from the poll", async () => {
    vi.spyOn(connectionsApi, "list").mockResolvedValue({ items: [connectionRow()], next_cursor: null });
    vi.spyOn(connectionsApi, "authorize").mockResolvedValue({
      authorize_url: "https://idp.example.test/authorize",
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    });
    vi.spyOn(connectionsApi, "get").mockResolvedValue(
      detailRow({ status: "disconnected", status_code: "CONNECTION_AUTH_DENIED", credential_state: "none" }),
    );
    const { result } = renderHook(() => useConnections(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.useFakeTimers();
    try {
      await act(async () => {
        await result.current.authorize("conn-1");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(result.current.authSession).toBeNull();
    expect(result.current.feedback?.kind).toBe("error");
    expect(result.current.feedback?.message).toMatch(/declined/i);
  });

  it("clears an active sign-in session when the connection is revoked or deleted", async () => {
    vi.spyOn(connectionsApi, "list").mockResolvedValue({ items: [connectionRow()], next_cursor: null });
    vi.spyOn(connectionsApi, "authorize").mockResolvedValue({
      authorize_url: "https://idp.example.test/authorize",
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    });
    vi.spyOn(connectionsApi, "get").mockResolvedValue(detailRow());
    vi.spyOn(connectionsApi, "revoke").mockResolvedValue(connectionRow({ credential_state: "none" }));
    const { result } = renderHook(() => useConnections(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.authorize("conn-1");
    });
    expect(result.current.authSession).not.toBeNull();

    await act(async () => {
      await result.current.revoke("conn-1");
    });
    expect(result.current.authSession).toBeNull();
  });

  it("sends credentials exactly once and stores no copy of them", async () => {
    vi.spyOn(connectionsApi, "list").mockResolvedValue({ items: [], next_cursor: null });
    const create = vi.spyOn(connectionsApi, "create").mockResolvedValue(detailRow({ credential_state: "stored" }));
    const { result } = renderHook(() => useConnections(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create({
        name: "Ops tools",
        kind: "mcp_http",
        config: { url: "https://mcp.example.test/mcp" },
        credentials: { headers: { authorization: "Bearer s3cr3t" } },
      });
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].credentials).toEqual({ headers: { authorization: "Bearer s3cr3t" } });
    // The row is the server's redacted DTO; the hook never echoes secrets.
    expect(JSON.stringify(result.current.connections)).not.toContain("s3cr3t");
  });
});
