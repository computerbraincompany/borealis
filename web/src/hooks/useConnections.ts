import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectionsApi,
  formatApiError,
  type ConnectionAuthorizationDto,
  type ConnectionCreateInput,
  type ConnectionDetailDto,
  type ConnectionDto,
  type ConnectionPatchInput,
  type ConnectionToolDto,
} from "@/lib/api";

/**
 * Catalog row: the list endpoint's redacted DTO, enriched with the tool
 * catalog whenever this surface has loaded that connection's detail.
 */
export type ConnectionRow = ConnectionDto & { tools?: ConnectionToolDto[] };
import { authPollOutcome, connectionStatusCopy, type AuthPollState } from "@/lib/connectionStatus";

/**
 * Own the Settings → Connections catalog while the panel is mounted.
 *
 * Every load and mutation carries an exact request generation plus an
 * AbortController (the `useContained` pattern), and each action names its
 * exact connection target, so a stale or superseded response can never
 * mutate a newer or closed surface. A successful local delete bumps the
 * catalog generation before filtering so an in-flight list response cannot
 * resurrect the removed row.
 *
 * Credential material is write-only here: the hook forwards credentials to
 * the API exactly once per mutation and keeps no copy — DTOs from the
 * server never contain secrets, and nothing here re-echoes them.
 */

const AUTH_POLL_INTERVAL_MS = 3_000;
const MAX_CATALOG_PAGES = 10;

export type ConnectionActionKind =
  | "create"
  | "update"
  | "toggle"
  | "test"
  | "discover"
  | "authorize"
  | "revoke"
  | "delete";

export interface ConnectionAction {
  kind: ConnectionActionKind;
  connectionId: string | null;
}

export interface ConnectionFeedback {
  kind: "error" | "success";
  message: string;
}

export interface ConnectionAuthSession {
  connectionId: string;
  authorizeUrl: string;
  expiresAt: string;
  desktopOpenToken?: string;
}

const ACTION_FALLBACKS: Record<ConnectionActionKind, string> = {
  create: "The connection could not be created.",
  update: "The connection could not be saved.",
  toggle: "The connection state could not be changed.",
  test: "The connection test failed.",
  discover: "Tool discovery failed.",
  authorize: "The sign-in session could not be started.",
  revoke: "The stored sign-in could not be revoked.",
  delete: "The connection could not be deleted.",
};

export function useConnections(enabled: boolean) {
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<ConnectionAction | null>(null);
  const [feedback, setFeedback] = useState<ConnectionFeedback | null>(null);
  const [authSession, setAuthSession] = useState<ConnectionAuthSession | null>(null);

  const mounted = useRef(false);
  const enabledRef = useRef(enabled);
  const loadRequestRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const actionRef = useRef<ConnectionAction | null>(null);
  const actionRequestRef = useRef(0);
  const actionAbortRef = useRef<AbortController | null>(null);
  const authBaselineRef = useRef<AuthPollState | null>(null);
  const authExpiresAtRef = useRef(0);
  const authPollTimerRef = useRef(0);
  const authPollRequestRef = useRef(0);
  const authPollAbortRef = useRef<AbortController | null>(null);
  const authPollFailuresRef = useRef(0);
  const authSessionRef = useRef<ConnectionAuthSession | null>(null);

  const invalidateAll = useCallback(() => {
    loadRequestRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    actionRequestRef.current += 1;
    actionAbortRef.current?.abort();
    actionAbortRef.current = null;
    actionRef.current = null;
    authPollRequestRef.current += 1;
    authPollAbortRef.current?.abort();
    authPollAbortRef.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidateAll();
    };
  }, [invalidateAll]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const stopAuthPolling = useCallback(() => {
    if (authPollTimerRef.current) window.clearTimeout(authPollTimerRef.current);
    authPollTimerRef.current = 0;
    authPollRequestRef.current += 1;
    authPollAbortRef.current?.abort();
    authPollAbortRef.current = null;
    authBaselineRef.current = null;
    authExpiresAtRef.current = 0;
  }, []);

  const applyDetail = useCallback((detail: ConnectionDetailDto) => {
    setConnections((current) => current.map((row) => (row.id === detail.id ? detail : row)));
  }, []);

  const applyPartial = useCallback((partial: ConnectionDto) => {
    setConnections((current) =>
      current.map((row) => (row.id === partial.id ? ({ ...row, ...partial, tools: row.tools } as ConnectionRow) : row)),
    );
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!mounted.current || !enabledRef.current) return;
    const requestId = ++loadRequestRef.current;
    loadAbortRef.current?.abort();
    const abort = new AbortController();
    loadAbortRef.current = abort;
    const owns = () =>
      mounted.current && enabledRef.current && requestId === loadRequestRef.current && !abort.signal.aborted;
    setLoading(true);
    try {
      const pages: ConnectionRow[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await connectionsApi.list({ cursor: cursor ?? null, signal: abort.signal });
        pages.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor && pages.length < MAX_CATALOG_PAGES * 50 && owns());
      if (owns()) {
        setConnections(pages);
        setLoadError(null);
      }
    } catch (failure: unknown) {
      if (owns()) setLoadError(formatApiError(failure, "Connections could not be loaded."));
    } finally {
      if (owns()) {
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
      stopAuthPolling();
      authSessionRef.current = null;
      setAuthSession(null);
      return;
    }
    void refresh();
    return () => stopAuthPolling();
  }, [enabled, refresh, stopAuthPolling]);

  const clearAuthSession = useCallback(
    (result: ConnectionFeedback | null) => {
      stopAuthPolling();
      authSessionRef.current = null;
      if (mounted.current) {
        setAuthSession(null);
        if (result) setFeedback(result);
      }
    },
    [stopAuthPolling],
  );

  // The baseline/expiry are passed in (not pre-set by the caller) because
  // `stopAuthPolling()` deliberately clears them; setting them first would be
  // undone before the first poll ever runs.
  const scheduleAuthPoll = useCallback(
    (baseline: AuthPollState | null, expiresAtMs: number) => {
      stopAuthPolling();
      authBaselineRef.current = baseline;
      authExpiresAtRef.current = expiresAtMs;
      const poll = () => {
        const session = authSessionRef.current;
        if (!session) return;
        const delay = Math.min(AUTH_POLL_INTERVAL_MS * (authPollFailuresRef.current + 1), 15_000);
        authPollTimerRef.current = window.setTimeout(() => {
          authPollTimerRef.current = 0;
          if (!authSessionRef.current) return;
          if (document.visibilityState === "visible") void pollOnce();
          poll();
        }, delay);
      };
      const pollOnce = async () => {
        const session = authSessionRef.current;
        const baseline = authBaselineRef.current;
        if (!session || !baseline) return;
        const requestId = ++authPollRequestRef.current;
        authPollAbortRef.current?.abort();
        const abort = new AbortController();
        authPollAbortRef.current = abort;
        const owns = () =>
          mounted.current &&
          enabledRef.current &&
          authSessionRef.current?.connectionId === session.connectionId &&
          requestId === authPollRequestRef.current &&
          !abort.signal.aborted;
        try {
          const detail = await connectionsApi.get(session.connectionId, abort.signal);
          if (!owns()) return;
          authPollFailuresRef.current = 0;
          applyDetail(detail);
          const expired = Date.now() >= authExpiresAtRef.current;
          const outcome = authPollOutcome(
            { status: detail.status, statusCode: detail.status_code, credentialState: detail.credential_state },
            baseline,
            expired,
          );
          if (outcome === "success") {
            clearAuthSession({
              kind: "success",
              message: `Signed in to “${detail.name}”. Test the connection to publish its tools.`,
            });
          } else if (outcome === "failure") {
            const copy = connectionStatusCopy(detail.status, detail.status_code);
            clearAuthSession({
              kind: "error",
              message:
                expired && detail.status_code === null
                  ? "The sign-in window expired. Start sign-in again."
                  : copy.label,
            });
          }
        } catch (failure: unknown) {
          if (owns()) {
            authPollFailuresRef.current = Math.min(authPollFailuresRef.current + 1, 6);
            // A failing status poll is bounded feedback, not a session end;
            // the session itself still ends at expiry.
            void failure;
          }
        } finally {
          if (owns()) authPollAbortRef.current = null;
        }
      };
      poll();
    },
    [applyDetail, clearAuthSession, stopAuthPolling],
  );

  const runAction = useCallback(
    async <Result>(
      target: ConnectionAction,
      operation: (signal: AbortController["signal"]) => Promise<Result>,
      apply: (result: Result) => void,
      successMessage: string,
    ): Promise<boolean> => {
      if (!mounted.current || !enabledRef.current || actionRef.current) return false;
      actionRef.current = target;
      const requestId = ++actionRequestRef.current;
      actionAbortRef.current?.abort();
      const abort = new AbortController();
      actionAbortRef.current = abort;
      const ownsResult = () =>
        mounted.current && enabledRef.current && requestId === actionRequestRef.current && !abort.signal.aborted;
      setAction(target);
      setFeedback(null);
      try {
        const result = await operation(abort.signal);
        if (ownsResult()) {
          apply(result);
          setFeedback({ kind: "success", message: successMessage });
        }
        return !abort.signal.aborted && requestId === actionRequestRef.current;
      } catch (failure: unknown) {
        if (ownsResult())
          setFeedback({ kind: "error", message: formatApiError(failure, ACTION_FALLBACKS[target.kind]) });
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

  const create = useCallback(
    async (input: ConnectionCreateInput): Promise<boolean> => {
      const ok = await runAction(
        { kind: "create", connectionId: null },
        (signal) => connectionsApi.create(input, signal),
        (detail) => {
          // Bump the catalog generation so an in-flight list can never
          // duplicate or overwrite the just-created row.
          loadRequestRef.current += 1;
          setConnections((current) => [detail, ...current.filter((row) => row.id !== detail.id)]);
        },
        `Connection “${input.name.trim()}” created.`,
      );
      return ok;
    },
    [runAction],
  );

  const save = useCallback(
    async (
      connectionId: string,
      patch: Omit<ConnectionPatchInput, "expected_revision">,
      expectedRevision: number,
    ): Promise<boolean> =>
      runAction(
        { kind: "update", connectionId },
        (signal) => connectionsApi.update(connectionId, { ...patch, expected_revision: expectedRevision }, signal),
        (detail) => applyDetail(detail),
        "Connection saved.",
      ),
    [runAction, applyDetail],
  );

  const toggle = useCallback(
    async (connectionId: string, enabledNext: boolean, expectedRevision: number): Promise<boolean> =>
      runAction(
        { kind: "toggle", connectionId },
        (signal) =>
          connectionsApi.update(connectionId, { enabled: enabledNext, expected_revision: expectedRevision }, signal),
        (detail) => applyDetail(detail),
        enabledNext ? "Connection enabled." : "Connection disabled.",
      ),
    [runAction, applyDetail],
  );

  const test = useCallback(
    async (connectionId: string): Promise<boolean> =>
      runAction(
        { kind: "test", connectionId },
        (signal) => connectionsApi.test(connectionId, signal),
        (partial) => applyPartial(partial),
        "Connection test passed.",
      ),
    [runAction, applyPartial],
  );

  const discover = useCallback(
    async (connectionId: string): Promise<boolean> =>
      runAction(
        { kind: "discover", connectionId },
        (signal) => connectionsApi.discover(connectionId, signal),
        (detail) => applyDetail(detail),
        "Tool catalog published.",
      ),
    [runAction, applyDetail],
  );

  const authorize = useCallback(
    async (connectionId: string): Promise<ConnectionAuthorizationDto | null> => {
      const baseline = connections.find((row) => row.id === connectionId);
      let authorization: ConnectionAuthorizationDto | null = null;
      const ok = await runAction(
        { kind: "authorize", connectionId },
        async (signal) => {
          authorization = await connectionsApi.authorize(connectionId, signal);
          return authorization;
        },
        (result) => {
          if (!mounted.current) return;
          const baselineState = baseline
            ? { status: baseline.status, statusCode: baseline.status_code, credentialState: baseline.credential_state }
            : null;
          const session: ConnectionAuthSession = {
            connectionId,
            authorizeUrl: result.authorize_url,
            expiresAt: result.expires_at,
            ...(result.desktop_open_token ? { desktopOpenToken: result.desktop_open_token } : {}),
          };
          authSessionRef.current = session;
          authPollFailuresRef.current = 0;
          setAuthSession(session);
          // Passed through so `stopAuthPolling()` inside the scheduler cannot
          // clear the comparison state the first poll needs.
          scheduleAuthPoll(baselineState, Date.parse(result.expires_at) || Date.now() + 5 * 60_000);
        },
        "Sign-in link ready — open it in your browser.",
      );
      return ok ? authorization : null;
    },
    [runAction, connections, scheduleAuthPoll],
  );

  const revoke = useCallback(
    async (connectionId: string): Promise<boolean> => {
      const ok = await runAction(
        { kind: "revoke", connectionId },
        (signal) => connectionsApi.revoke(connectionId, signal),
        (partial) => applyPartial(partial),
        "Stored sign-in revoked.",
      );
      if (authSessionRef.current?.connectionId === connectionId) clearAuthSession(null);
      return ok;
    },
    [runAction, applyPartial, clearAuthSession],
  );

  const remove = useCallback(
    async (connectionId: string): Promise<boolean> => {
      const ok = await runAction(
        { kind: "delete", connectionId },
        (signal) => connectionsApi.remove(connectionId, signal),
        () => {
          // Generation bump precedes filtering so an in-flight list
          // response cannot resurrect the deleted row (AgentsView rule).
          loadRequestRef.current += 1;
          setConnections((current) => current.filter((row) => row.id !== connectionId));
        },
        "Connection deleted.",
      );
      if (authSessionRef.current?.connectionId === connectionId) clearAuthSession(null);
      return ok;
    },
    [runAction, clearAuthSession],
  );

  const dismissAuthSession = useCallback(() => clearAuthSession(null), [clearAuthSession]);

  const clearFeedback = useCallback(() => {
    if (mounted.current) setFeedback(null);
  }, []);

  return {
    connections,
    loading,
    loadError,
    action,
    feedback,
    authSession,
    refresh,
    create,
    save,
    toggle,
    test,
    discover,
    authorize,
    revoke,
    remove,
    dismissAuthSession,
    clearFeedback,
  };
}
