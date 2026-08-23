import { cancelRunThenAbort } from "@/lib/chatRun";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("cancelRunThenAbort", () => {
  it("waits for server cancellation before aborting the local stream", async () => {
    const response = deferred<void>();
    const controller = new AbortController();
    const cancel = vi.fn(() => response.promise);

    const stopping = cancelRunThenAbort({
      chatId: "chat-1",
      runId: "run-1",
      controller,
      cancel,
      isCurrent: () => true,
    });

    expect(cancel).toHaveBeenCalledWith("chat-1", "run-1");
    expect(controller.signal.aborted).toBe(false);
    response.resolve();
    await expect(stopping).resolves.toBe("cancelling");
    expect(controller.signal.aborted).toBe(true);
  });

  it("leaves the stream connected when cancellation fails", async () => {
    const controller = new AbortController();
    await expect(
      cancelRunThenAbort({
        chatId: "chat-1",
        runId: "run-1",
        controller,
        cancel: async () => Promise.reject(new Error("unavailable")),
        isCurrent: () => true,
      }),
    ).rejects.toThrow("unavailable");
    expect(controller.signal.aborted).toBe(false);
  });

  it("keeps a pre-id stream connected so run-started can still be cancelled", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();

    await expect(
      cancelRunThenAbort({
        chatId: "chat-1",
        runId: null,
        controller,
        cancel,
        isCurrent: () => true,
      }),
    ).resolves.toBe("awaiting-run-id");

    expect(cancel).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });

  it.each(["completed", "failed"] as const)("does not relabel or disconnect an already-%s run", async (status) => {
    const controller = new AbortController();
    const onCancelled = vi.fn();

    await expect(
      cancelRunThenAbort({
        chatId: "chat-1",
        runId: "run-1",
        controller,
        cancel: async () => ({ ok: true, run_id: "run-1", status }),
        isCurrent: () => true,
        onCancelled,
      }),
    ).resolves.toBe(status);

    expect(onCancelled).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });
});
