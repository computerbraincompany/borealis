import { useEffect, useRef, useState } from "react";
import type { Source } from "@/lib/api";

const PENDING_SOURCE_STATUSES = new Set(["queued", "pending", "index", "processing"]);
const POLL_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const;

export function isPendingSource(source: Pick<Source, "status">): boolean {
  return PENDING_SOURCE_STATUSES.has(source.status);
}

export function shouldPollSources(sources: Array<Pick<Source, "status">>, locallyPending = false): boolean {
  return locallyPending || sources.some(isPendingSource);
}

export function sourcePollDelay(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return POLL_DELAYS_MS[Math.min(safeAttempt, POLL_DELAYS_MS.length - 1)];
}

/** Poll only while a source is transitioning, backing off until the catalog settles. */
export function usePendingSourcePolling(
  sources: Array<Pick<Source, "status">>,
  refresh: () => Promise<unknown>,
  locallyPending = false,
): void {
  const attemptRef = useRef(0);
  const [cycle, setCycle] = useState(0);
  const pending = shouldPollSources(sources, locallyPending);

  useEffect(() => {
    if (!pending) {
      attemptRef.current = 0;
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      void refresh().finally(() => {
        if (!active) return;
        attemptRef.current += 1;
        setCycle((current) => current + 1);
      });
    }, sourcePollDelay(attemptRef.current));

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [cycle, pending, refresh]);
}
