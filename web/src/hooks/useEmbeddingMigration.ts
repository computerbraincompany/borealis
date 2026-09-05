import { useCallback, useEffect, useRef, useState } from "react";
import { formatApiError, modelsApi, type EmbeddingMigrationStatus } from "@/lib/api";

const ACTIVE_POLL_INTERVAL_MS = 1_000;

export type EmbeddingMigrationAction = "applying" | "cancelling" | "retrying" | "starting" | null;

export interface EmbeddingMigrationFeedback {
  kind: "error" | "success";
  message: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  EMBEDDING_INVALID: "The provider returned embeddings that did not match the target identity.",
  EMBEDDING_UNAVAILABLE: "The embedding provider was unavailable while the index was being built.",
  INDEX_VERIFY_FAILED: "The staged index did not pass verification.",
  INSUFFICIENT_DISK: "There is not enough free disk space to build a replacement index safely.",
  INGESTION_BUSY: "Wait for source ingestion to finish before starting the migration.",
  MIGRATION_TOO_LARGE: "This workspace exceeds the managed migration size limit.",
  PROVIDER_CHANGED: "Provider settings changed after the migration started.",
  REMOTE_EGRESS_CONSENT_REQUIRED: "Every affected account must acknowledge remote embedding egress first.",
  SNAPSHOT_DRIFT: "The source snapshot changed while the replacement index was being built.",
  SNAPSHOT_FAILED: "Borealis could not create a stable source snapshot.",
  STARTUP_OPEN_FAILED: "The replacement index could not be opened during restart.",
  STARTUP_SMOKE_FAILED: "The replacement index failed its retrieval check during restart.",
  STARTUP_SWAP_FAILED: "The replacement index could not be installed safely during restart.",
  STATE_INVALID: "The saved migration state could not be validated.",
};

export function embeddingMigrationErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return ERROR_MESSAGES[code] ?? "The embedding migration stopped before completion.";
}

/** Own migration polling and mutations while the Models settings section is visible. */
export function useEmbeddingMigration(enabled: boolean) {
  const [status, setStatus] = useState<EmbeddingMigrationStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<EmbeddingMigrationAction>(null);
  const [feedback, setFeedback] = useState<EmbeddingMigrationFeedback | null>(null);
  const mounted = useRef(false);
  const statusController = useRef<AbortController | null>(null);
  const statusRequest = useRef<Promise<EmbeddingMigrationStatus | null> | null>(null);
  const actionRef = useRef<EmbeddingMigrationAction>(null);
  // Consecutive poll failures widen the next interval so a failing endpoint
  // does not produce one request/error flicker per second while open.
  const pollFailuresRef = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      statusController.current?.abort();
    };
  }, []);

  const refresh = useCallback(async (): Promise<EmbeddingMigrationStatus | null> => {
    if (!enabled || actionRef.current) return null;
    if (statusRequest.current) return statusRequest.current;

    statusController.current?.abort();
    const controller = new AbortController();
    statusController.current = controller;
    if (mounted.current) setChecking(true);

    const request = modelsApi
      .embeddingMigrationStatus(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted && mounted.current) {
          pollFailuresRef.current = 0;
          setStatus(next);
          setLoadError(null);
        }
        return next;
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && mounted.current) {
          pollFailuresRef.current = Math.min(pollFailuresRef.current + 1, 14);
          setLoadError(formatApiError(failure, "Embedding migration status is temporarily unavailable."));
        }
        return null;
      })
      .finally(() => {
        if (statusRequest.current === request) statusRequest.current = null;
        if (!controller.signal.aborted && mounted.current) setChecking(false);
      });
    statusRequest.current = request;
    return request;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      statusController.current?.abort();
      statusRequest.current = null;
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || (status?.phase !== "snapshotting" && status?.phase !== "building")) return;
    let timer = 0;
    let active = true;
    const schedule = () => {
      const delay = Math.min(ACTIVE_POLL_INTERVAL_MS * (pollFailuresRef.current + 1), 15_000);
      timer = window.setTimeout(() => {
        if (!active) return;
        if (document.visibilityState === "visible") void refresh();
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [enabled, refresh, status?.phase]);

  const runAction = useCallback(
    async (
      nextAction: Exclude<EmbeddingMigrationAction, null>,
      operation: () => Promise<EmbeddingMigrationStatus>,
      successMessage: string,
    ): Promise<boolean> => {
      if (!enabled || actionRef.current) return false;
      actionRef.current = nextAction;
      statusController.current?.abort();
      statusRequest.current = null;
      setAction(nextAction);
      setFeedback(null);
      try {
        const next = await operation();
        if (mounted.current) {
          setStatus(next);
          setLoadError(null);
          const migrationFailure = embeddingMigrationErrorMessage(next.error_code);
          setFeedback(
            next.phase === "failed"
              ? { kind: "error", message: migrationFailure ?? "The embedding migration could not continue." }
              : { kind: "success", message: successMessage },
          );
        }
        return next.phase !== "failed";
      } catch (failure: unknown) {
        if (mounted.current) {
          setFeedback({
            kind: "error",
            message: formatApiError(failure, "The embedding migration action could not be completed."),
          });
        }
        return false;
      } finally {
        actionRef.current = null;
        if (mounted.current) setAction(null);
      }
    },
    [enabled],
  );

  const start = useCallback(
    (targetModel: string, targetDimension: number) =>
      runAction(
        "starting",
        () =>
          modelsApi.startEmbeddingMigration({
            target_embed_model: targetModel.trim(),
            target_dimension: targetDimension,
          }),
        "Migration started. Source changes are paused while the replacement index is built.",
      ),
    [runAction],
  );

  const retry = useCallback(
    () =>
      runAction(
        "retrying",
        () => modelsApi.retryEmbeddingMigration(),
        "Migration resumed from its verified checkpoint.",
      ),
    [runAction],
  );

  const cancel = useCallback(
    () =>
      runAction(
        "cancelling",
        () => modelsApi.cancelEmbeddingMigration(),
        "Migration cancelled. The current embedding index remains active.",
      ),
    [runAction],
  );

  const apply = useCallback(
    () =>
      runAction(
        "applying",
        () => modelsApi.applyEmbeddingMigration(),
        "Migration staged for installation. Restart Borealis and its server to install and verify the new index.",
      ),
    [runAction],
  );

  return { status, checking, loadError, action, feedback, refresh, start, retry, cancel, apply };
}
