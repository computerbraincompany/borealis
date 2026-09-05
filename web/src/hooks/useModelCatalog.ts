import { useEffect, useSyncExternalStore } from "react";
import { formatApiError, modelsApi, type ModelsResponse } from "@/lib/api";

export interface ModelCatalogState {
  catalog: ModelsResponse | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: ModelCatalogState = {
  catalog: null,
  loading: true,
  error: null,
};

let state = INITIAL_STATE;
let requestId = 0;
let inFlight: Promise<ModelsResponse | null> | null = null;
let releaseId = 0;
const listeners = new Set<() => void>();

function publish(next: ModelCatalogState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  releaseId += 1;
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;

    const pendingRelease = ++releaseId;
    queueMicrotask(() => {
      if (listeners.size > 0 || pendingRelease !== releaseId) return;
      requestId += 1;
      inFlight = null;
      state = INITIAL_STATE;
    });
  };
}

function getSnapshot() {
  return state;
}

/**
 * Load the shared chat-model catalog. A forced refresh owns the result over any
 * older request, and clears the previous catalog immediately so a changed provider never shows
 * models from the old endpoint, including when discovery fails.
 */
async function loadModelCatalog(force = false): Promise<ModelsResponse | null> {
  if (!force && state.catalog) return state.catalog;
  if (!force && inFlight) return inFlight;

  const ownedRequestId = ++requestId;
  publish({ ...state, ...(force ? { catalog: null } : {}), loading: true, error: null });

  const request = (async () => {
    try {
      const catalog = await modelsApi.list(force);
      if (ownedRequestId !== requestId) return null;
      publish({ catalog, loading: false, error: null });
      return catalog;
    } catch (failure: unknown) {
      if (ownedRequestId !== requestId) return null;
      publish({
        ...state,
        loading: false,
        error: formatApiError(failure, "The model catalog is temporarily unavailable."),
      });
      return null;
    } finally {
      if (ownedRequestId === requestId) inFlight = null;
    }
  })();

  inFlight = request;
  return request;
}

export function useModelCatalog() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void loadModelCatalog();
  }, []);

  return { ...snapshot, refresh: loadModelCatalog };
}

/** Clear the module store between isolated tests without exposing reset controls in the UI. */
export function resetModelCatalogStoreForTests() {
  requestId += 1;
  releaseId += 1;
  inFlight = null;
  publish(INITIAL_STATE);
}
