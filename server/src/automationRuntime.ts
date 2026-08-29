import { AutomationStore } from "./automationStore.js";
import { createAutomationRunner } from "./automationRunner.js";
import { storageRuntime } from "./storageRuntime.js";
import { syncConnector } from "./routes/connectors.js";

/**
 * Lazily constructed automation runner over the shared ledger-backed store.
 * Construction must wait for the storage runtime, and the scheduler is
 * best-effort and unref'd: it never keeps the process alive and never blocks
 * shutdown.
 */
let runtime: { store: AutomationStore; runner: ReturnType<typeof createAutomationRunner> } | undefined;

function automationRuntime() {
  runtime ??= {
    store: new AutomationStore(storageRuntime().ledger),
    runner: createAutomationRunner({
      store: new AutomationStore(storageRuntime().ledger),
      syncConnector: (accountId, connectorId) => syncConnector(accountId, undefined, connectorId),
    }),
  };
  return runtime;
}

export function automationStore(): AutomationStore {
  return automationRuntime().store;
}

export function automationRunner(): ReturnType<typeof createAutomationRunner> {
  return automationRuntime().runner;
}
