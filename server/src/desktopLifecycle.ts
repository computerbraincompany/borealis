export interface DeferredServiceLifecycle<T> {
  readonly stopRequested: boolean;
  start(): Promise<T | undefined>;
  stop(): Promise<void>;
}

export interface DeferredServiceLifecycleOptions<T> {
  readonly start: () => Promise<T>;
  readonly close: (service: T) => Promise<void>;
  readonly onStopped: () => void;
}

/**
 * Couple an asynchronous utility-process startup to idempotent teardown.
 *
 * A stop requested while start() is pending waits for the resulting service,
 * closes it, and only then acknowledges shutdown. start() returns undefined in
 * that case so callers cannot publish a stale ready message.
 */
export function createDeferredServiceLifecycle<T>(
  options: DeferredServiceLifecycleOptions<T>
): DeferredServiceLifecycle<T> {
  let service: T | undefined;
  let startup: Promise<T> | undefined;
  let stopping: Promise<void> | undefined;
  let stopRequested = false;

  const lifecycle: DeferredServiceLifecycle<T> = {
    get stopRequested() {
      return stopRequested;
    },
    async start() {
      if (stopRequested) {
        await lifecycle.stop();
        return undefined;
      }
      startup ??= options.start();
      const started = await startup;
      service = started;
      if (stopRequested) {
        await lifecycle.stop();
        return undefined;
      }
      return started;
    },
    stop() {
      stopRequested = true;
      stopping ??= (async () => {
        const active = service ?? (await startup?.catch(() => undefined));
        if (active !== undefined) await options.close(active);
        options.onStopped();
      })();
      return stopping;
    },
  };
  return lifecycle;
}
