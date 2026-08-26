import { startBorealisServer } from "./serverApp.js";

try {
  const running = await startBorealisServer();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): void => {
    shutdownPromise ??= running.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  // Startup failures are intentionally generic: configuration and storage
  // errors can contain credentials or local paths.
  process.stderr.write("Borealis server failed to start.\n");
  process.exitCode = 1;
}
