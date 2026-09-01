import { useCallback, useEffect, useRef, useState } from "react";
import {
  containedApi,
  formatApiError,
  type ContainedConfig,
  type ContainedConfigInput,
  type ContainedDownloadInput,
  type ContainedDownloadState,
  type ContainedEngineStatus,
  type ContainedResponse,
} from "@/lib/api";

/** Live poll cadence while the Settings Models section keeps the panel mounted. */
const POLL_INTERVAL_MS = 2_000;

export type ContainedAction =
  | "saving-config"
  | "starting-download"
  | "cancelling-download"
  | "starting-engine"
  | "stopping-engine"
  | null;

export interface ContainedFeedback {
  kind: "error" | "success";
  message: string;
}

export interface ContainedSnapshot {
  config: ContainedConfig | null;
  engine: ContainedEngineStatus | null;
  downloads: ContainedDownloadState[];
}

const ACTION_FALLBACKS: Record<Exclude<ContainedAction, null>, string> = {
  "saving-config": "The contained configuration could not be saved.",
  "starting-download": "The download could not be started.",
  "cancelling-download": "The download could not be canceled.",
  "starting-engine": "The contained engine could not be started.",
  "stopping-engine": "The contained engine could not be stopped.",
};

/**
 * Own the contained-management snapshot while the bounded Settings panel is
 * mounted. Every load and mutation carries an exact request generation plus an
 * AbortController, so a stale poll or superseded action can never mutate a
 * newer or unmounted target.
 */
export function useContained(enabled: boolean) {
  const [config, setConfig] = useState<ContainedConfig | null>(null);
  const [engine, setEngine] = useState<ContainedEngineStatus | null>(null);
  const [downloads, setDownloads] = useState<ContainedDownloadState[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<ContainedAction>(null);
  const [feedback, setFeedback] = useState<ContainedFeedback | null>(null);

  const mounted = useRef(false);
  const enabledRef = useRef(enabled);
  const loadRequestRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const actionRef = useRef<ContainedAction>(null);
  const actionRequestRef = useRef(0);
  const actionAbortRef = useRef<AbortController | null>(null);

  const invalidateRequests = useCallback(() => {
    loadRequestRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    actionRequestRef.current += 1;
    actionAbortRef.current?.abort();
    actionAbortRef.current = null;
    actionRef.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidateRequests();
    };
  }, [invalidateRequests]);

  // Sync the guard before the polling effect below reads it.
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const refresh = useCallback(async (): Promise<ContainedResponse | null> => {
    if (!mounted.current || !enabledRef.current) return null;
    const requestId = ++loadRequestRef.current;
    loadAbortRef.current?.abort();
    const abort = new AbortController();
    loadAbortRef.current = abort;
    const ownsResponse = () =>
      mounted.current && enabledRef.current && requestId === loadRequestRef.current && !abort.signal.aborted;
    if (mounted.current) setLoading(true);
    try {
      const next = await containedApi.get(abort.signal);
      if (ownsResponse()) {
        setConfig(next.config);
        setEngine(next.engine);
        setDownloads(next.downloads);
        setLoadError(null);
      }
      return next;
    } catch (failure: unknown) {
      if (ownsResponse()) {
        setLoadError(formatApiError(failure, "Contained engine status is temporarily unavailable."));
      }
      return null;
    } finally {
      if (ownsResponse()) {
        loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      if (mounted.current) {
        setAction(null);
        setLoading(false);
      }
      return;
    }
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      invalidateRequests();
      window.clearInterval(interval);
    };
  }, [enabled, refresh, invalidateRequests]);

  const runAction = useCallback(
    async <Result>(
      name: Exclude<ContainedAction, null>,
      operation: (signal: AbortSignal) => Promise<Result>,
      apply: (result: Result) => void,
      successMessage: string,
    ): Promise<boolean> => {
      if (!mounted.current || !enabledRef.current || actionRef.current) return false;
      actionRef.current = name;
      const requestId = ++actionRequestRef.current;
      actionAbortRef.current?.abort();
      const abort = new AbortController();
      actionAbortRef.current = abort;
      const ownsResult = () =>
        mounted.current && enabledRef.current && requestId === actionRequestRef.current && !abort.signal.aborted;
      setAction(name);
      setFeedback(null);
      try {
        const result = await operation(abort.signal);
        if (ownsResult()) {
          apply(result);
          setFeedback({ kind: "success", message: successMessage });
        }
        return !abort.signal.aborted && requestId === actionRequestRef.current;
      } catch (failure: unknown) {
        if (ownsResult()) {
          setFeedback({ kind: "error", message: formatApiError(failure, ACTION_FALLBACKS[name]) });
        }
        return false;
      } finally {
        if (requestId === actionRequestRef.current && actionAbortRef.current === abort) {
          actionAbortRef.current = null;
          actionRef.current = null;
          if (mounted.current) setAction(null);
        }
      }
    },
    [],
  );

  const saveConfig = useCallback(
    (input: ContainedConfigInput) =>
      runAction(
        "saving-config",
        (signal) => containedApi.saveConfig(input, signal),
        (saved) => setConfig(saved),
        "Contained configuration saved.",
      ),
    [runAction],
  );

  const startDownload = useCallback(
    (body: ContainedDownloadInput) =>
      runAction(
        "starting-download",
        (signal) => containedApi.startDownload(body, signal),
        (download) =>
          setDownloads((current) => [download, ...current.filter((entry) => entry.filename !== download.filename)]),
        `Download started for ${body.filename}.`,
      ),
    [runAction],
  );

  const cancelDownload = useCallback(
    (filename: string) =>
      runAction(
        "cancelling-download",
        (signal) => containedApi.cancelDownload(filename, signal),
        () =>
          setDownloads((current) =>
            current.map((entry) =>
              entry.filename === filename && (entry.state === "downloading" || entry.state === "verifying")
                ? { ...entry, state: "canceled" as const }
                : entry,
            ),
          ),
        `Download canceled for ${filename}.`,
      ),
    [runAction],
  );

  const startEngine = useCallback(
    () =>
      runAction(
        "starting-engine",
        (signal) => containedApi.startEngine(signal),
        (state) => setEngine(state),
        "Engine start accepted.",
      ),
    [runAction],
  );

  const stopEngine = useCallback(
    () =>
      runAction(
        "stopping-engine",
        (signal) => containedApi.stopEngine(signal),
        (state) => setEngine(state),
        "Engine stopped.",
      ),
    [runAction],
  );

  return {
    config,
    engine,
    downloads,
    loading,
    loadError,
    action,
    feedback,
    refresh,
    saveConfig,
    startDownload,
    cancelDownload,
    startEngine,
    stopEngine,
  };
}
