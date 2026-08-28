import { closeElectronRenderPort, configureElectronRenderPort, type ElectronParentPort } from "./electronRender.js";
import { createDeferredServiceLifecycle } from "./desktopLifecycle.js";
import { startBorealisServer, type RunningBorealisServer } from "./serverApp.js";

interface UtilityParentPort extends ElectronParentPort {
  postMessage(message: unknown): void;
  close?(): void;
}

interface UtilityProcess extends Omit<NodeJS.Process, "parentPort"> {
  readonly parentPort?: UtilityParentPort;
}

function messageData(message: unknown): unknown {
  return message && typeof message === "object" && "data" in message
    ? (message as { readonly data?: unknown }).data
    : message;
}

const discoveredParentPort = (process as UtilityProcess).parentPort;
if (!discoveredParentPort) throw new Error("desktop host requires an Electron utility parent port");
const parentPort: UtilityParentPort = discoveredParentPort;
configureElectronRenderPort(parentPort);

const lifecycle = createDeferredServiceLifecycle<RunningBorealisServer>({
  start: () => startBorealisServer({ desktop: true }),
  close: (server) => server.close(),
  onStopped: () => {
    closeElectronRenderPort();
    parentPort.postMessage({ type: "stopped" });
    parentPort.close?.();
  },
});

parentPort.on("message", (event) => {
  const message = messageData(event);
  if (message && typeof message === "object" && (message as { type?: unknown }).type === "shutdown") {
    void lifecycle.stop().catch(() => {
      process.exitCode = 1;
    });
  }
});
process.once("SIGTERM", () => void lifecycle.stop());
process.once("SIGINT", () => void lifecycle.stop());

try {
  const running = await lifecycle.start();
  if (!running) {
    // Shutdown was requested while the embedded server was still starting.
    await lifecycle.stop();
  } else {
    if (!running.bootstrap) throw new Error("desktop bootstrap was not created");
    parentPort.postMessage({
      type: "ready",
      port: running.port,
      bootstrap: running.bootstrap,
    });
  }
} catch {
  if (!lifecycle.stopRequested) {
    closeElectronRenderPort();
    parentPort.postMessage({ type: "fatal" });
    process.exitCode = 1;
  }
}
