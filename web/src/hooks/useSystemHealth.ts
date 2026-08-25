import { useCallback, useEffect, useRef, useState } from "react";
import { formatApiError, systemApi, type SystemHealthResponse } from "@/lib/api";

const REFRESH_INTERVAL_MS = 30_000;

export interface SystemHealthState {
  health: SystemHealthResponse | null;
  checking: boolean;
  error: string | null;
}

/** Keep dependency readiness current while Settings is open without overlapping probes. */
export function useSystemHealth(refreshIntervalMs = REFRESH_INTERVAL_MS) {
  const [state, setState] = useState<SystemHealthState>({ health: null, checking: true, error: null });
  const mounted = useRef(false);
  const inFlight = useRef<Promise<SystemHealthResponse | null> | null>(null);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<SystemHealthResponse | null> => {
    if (inFlight.current) return inFlight.current;

    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    if (mounted.current) setState((current) => ({ ...current, checking: true, error: null }));

    const request = systemApi
      .health(requestController.signal)
      .then((health) => {
        if (!requestController.signal.aborted && mounted.current) {
          setState({ health, checking: false, error: null });
        }
        return health;
      })
      .catch((failure: unknown) => {
        if (!requestController.signal.aborted && mounted.current) {
          setState((current) => ({
            ...current,
            checking: false,
            error: formatApiError(failure, "System status is temporarily unavailable."),
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
