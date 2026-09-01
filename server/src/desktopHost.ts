import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { closeElectronRenderPort, configureElectronRenderPort, type ElectronParentPort } from "./electronRender.js";
import { extractPdfText } from "./ingestSupport.js";
import { buildRasterOnlyOcrSmokePdf } from "./ocrSmokePdf.js";
import { createDeferredServiceLifecycle } from "./desktopLifecycle.js";
import { startBorealisServer, type RunningBorealisServer } from "./serverApp.js";

const PACKAGED_NATIVE_SMOKE_ARGUMENT = "--borealis-packaged-native-smoke-utility";

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

function assertNativeSmokeEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if ((name.startsWith("NODE_") && name !== "NODE_ENV") || name.startsWith("ELECTRON_") || name.startsWith("DYLD_")) {
      throw new Error("desktop utility environment is not sanitized");
    }
  }
}

async function exerciseNativeEngines(): Promise<void> {
  assertNativeSmokeEnvironment();
  const root = process.env.BOREALIS_DATA_DIR;
  if (!root) throw new Error("desktop storage root is unavailable");
  const temporaryDirectory = await mkdtemp(path.join(root, ".native-smoke-"));
  try {
    const { default: Database } = await import("better-sqlite3");
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec("CREATE TABLE smoke (value INTEGER NOT NULL)");
      sqlite.prepare("INSERT INTO smoke (value) VALUES (?)").run(1);
      const row = sqlite.prepare("SELECT value FROM smoke").get() as { value?: unknown } | undefined;
      if (row?.value !== 1) {
        throw new Error("SQLite native smoke failed");
      }
    } finally {
      sqlite.close();
    }

    const lancedb = await import("@lancedb/lancedb");
    const lance = await lancedb.connect(path.join(temporaryDirectory, "lancedb"));
    let table;
    try {
      table = await lance.createTable("smoke", [{ id: "row", vector: [1, 0, 0] }]);
      const rows = await table.vectorSearch([1, 0, 0]).limit(1).toArray();
      if (rows[0]?.id !== "row") throw new Error("LanceDB native smoke failed");
    } finally {
      table?.close();
      lance.close();
    }

    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run("SELECT 1");
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    const pdf = path.join(temporaryDirectory, "ocr-smoke.pdf");
    const pdfBytes = buildRasterOnlyOcrSmokePdf();
    await writeFile(pdf, pdfBytes);
    const recognized = await extractPdfText(pdf, pdfBytes);
    if (
      !recognized
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .includes("BOREALISOCR")
    ) {
      throw new Error("packaged local OCR smoke failed");
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv.includes(PACKAGED_NATIVE_SMOKE_ARGUMENT)) {
  process.noDeprecation = true;
  try {
    await exerciseNativeEngines();
    parentPort.postMessage({ type: "native-smoke", ok: true });
  } catch {
    parentPort.postMessage({ type: "fatal", error_code: "NATIVE_SMOKE_FAILED" });
    process.exitCode = 1;
  } finally {
    parentPort.close?.();
  }
} else {
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
}
