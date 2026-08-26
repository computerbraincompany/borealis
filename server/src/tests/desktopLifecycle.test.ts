import { describe, expect, it, vi } from "vitest";

import { createDeferredServiceLifecycle } from "../desktopLifecycle.js";

describe("deferred desktop service lifecycle", () => {
  it("waits for pending startup, closes it, and suppresses ready publication", async () => {
    let resolveStartup!: (service: { id: string }) => void;
    const close = vi.fn(async () => undefined);
    const onStopped = vi.fn();
    const lifecycle = createDeferredServiceLifecycle({
      start: () =>
        new Promise<{ id: string }>((resolve) => {
          resolveStartup = resolve;
        }),
      close,
      onStopped,
    });

    const startup = lifecycle.start();
    const stopping = lifecycle.stop();
    expect(lifecycle.stopRequested).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(onStopped).not.toHaveBeenCalled();

    const service = { id: "started-after-stop" };
    resolveStartup(service);

    await expect(startup).resolves.toBeUndefined();
    await expect(stopping).resolves.toBeUndefined();
    await lifecycle.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(service);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("returns an ordinary started service and closes it once", async () => {
    const service = { id: "ready" };
    const close = vi.fn(async () => undefined);
    const onStopped = vi.fn();
    const lifecycle = createDeferredServiceLifecycle({
      start: async () => service,
      close,
      onStopped,
    });

    await expect(lifecycle.start()).resolves.toBe(service);
    await Promise.all([lifecycle.stop(), lifecycle.stop()]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("still acknowledges an early stop when startup fails", async () => {
    let rejectStartup!: (error: Error) => void;
    const onStopped = vi.fn();
    const lifecycle = createDeferredServiceLifecycle({
      start: () =>
        new Promise<never>((_resolve, reject) => {
          rejectStartup = reject;
        }),
      close: vi.fn(async () => undefined),
      onStopped,
    });

    const startup = lifecycle.start();
    const stopping = lifecycle.stop();
    rejectStartup(new Error("startup failed"));

    await expect(startup).rejects.toThrow("startup failed");
    await expect(stopping).resolves.toBeUndefined();
    expect(onStopped).toHaveBeenCalledTimes(1);
  });
});
