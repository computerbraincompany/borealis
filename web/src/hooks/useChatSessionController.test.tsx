import { StrictMode, useEffect } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { useChatSessionController } from "@/hooks/useChatSessionController";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("useChatSessionController", () => {
  it("gives only the latest detail request for the selected chat ownership", () => {
    const { result } = renderHook(() => useChatSessionController());

    const selected = result.current.selectChat("chat-a");
    const pagination = result.current.beginDetailRequest("chat-a");

    expect(result.current.ownsDetailRequest(selected)).toBe(false);
    expect(result.current.ownsDetailRequest(pagination)).toBe(true);

    result.current.selectChat("chat-b");
    expect(result.current.ownsDetailRequest(pagination)).toBe(false);
  });

  it("deduplicates creation and never navigates after a newer selection", async () => {
    const pending = deferred<{ id: string }>();
    const create = vi.fn(() => pending.promise);
    const onCreated = vi.fn();
    const { result } = renderHook(() => useChatSessionController());

    let first!: Promise<{ id: string }>;
    let second!: Promise<{ id: string }>;
    await act(async () => {
      first = result.current.createChat(create, onCreated);
      second = result.current.createChat(create, onCreated);
    });
    expect(create).toHaveBeenCalledTimes(1);

    act(() => result.current.selectChat("existing"));
    await act(async () => pending.resolve({ id: "new" }));

    await expect(first).resolves.toEqual({ id: "new" });
    await expect(second).resolves.toEqual({ id: "new" });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("invalidates deferred work when unmounted", async () => {
    const pending = deferred<{ id: string }>();
    const onCreated = vi.fn();
    const { result, unmount } = renderHook(() => useChatSessionController());
    let request!: Promise<{ id: string }>;
    act(() => {
      request = result.current.createChat(() => pending.promise, onCreated);
    });

    unmount();
    await act(async () => {
      pending.resolve({ id: "new" });
      await request;
    });

    expect(onCreated).not.toHaveBeenCalled();
  });

  it("keeps a single creation owner across StrictMode's effect replay", async () => {
    const pending = deferred<{ id: string }>();
    const create = vi.fn(() => pending.promise);
    const onCreated = vi.fn();

    function Harness() {
      const { createChat } = useChatSessionController();
      useEffect(() => {
        void createChat(create, onCreated);
      }, [createChat]);
      return null;
    }

    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    expect(create).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve({ id: "new" }));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
});
