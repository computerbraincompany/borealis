import { useCallback, useEffect, useRef, useState } from "react";
import { formatApiError, systemApi, type WorkspaceStatusResponse } from "@/lib/api";

const REFRESH_INTERVAL_MS = 30_000;

export interface WorkspaceStatusState {
  status: WorkspaceStatusResponse | null;
  checking: boolean;
  error: string | null;
}

/** Keep the ambient locality strip current in the chrome without overlapping probes. */
export function useWorkspaceStatus(refreshIntervalMs = REFRESH_INTERVAL_MS) {
  const [state, setState] = useState<WorkspaceStatusState>({ status: null, checking: true, error: null });
  const mounted = useRef(false);
  const inFlight = useRef<Promise<WorkspaceStatusResponse | null> | null>(null);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<WorkspaceStatusResponse | null> => {
    if (inFlight.current) return inFlight.current;

    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    if (mounted.current) setState((current) => ({ ...current, checking: true, error: null }));

    const request = systemApi
      .workspaceStatus(requestController.signal)
      .then((status) => {
        if (!requestController.signal.aborted && mounted.current) {
          setState({ status, checking: false, error: null });
        }
        return status;
      })
      .catch((failure: unknown) => {
        if (!requestController.signal.aborted && mounted.current) {
          setState((current) => ({
            ...current,
            checking: false,
            error: formatApiError(failure, "Workspace status is temporarily unavailable."),
          }));
        }
        return null;
      });

    inFlight.current = request;
    void request.finally(() => {
      if (inFlight.current === request) inFlight.current = null;
    });
    return request;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, refreshIntervalMs);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      mounted.current = false;
      controller.current?.abort();
      inFlight.current = null;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh, refreshIntervalMs]);

  return { ...state, refresh };
}
