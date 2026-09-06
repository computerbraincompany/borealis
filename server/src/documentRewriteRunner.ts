/**
 * Durable model-assisted document rewrites (M13 stage 3).
 *
 * The runner is the single executor over `document_rewrites`:
 * - startup resume recovers interrupted dispatched rewrites as durable
 *   `failed` rows (`SERVER_RESTARTED`) — the provider call is never replayed,
 *   because a rewrite's only mutation happens at acceptance and a fresh
 *   request is required after an interrupted call;
 * - execution is ONE bounded model call with no tools, through the same
 *   account-authorized runtime and consent gate as chat traffic: the exact
 *   consent target is re-authorized immediately before the first transport,
 *   and a remote provider that lost acknowledgment makes no transport call;
 * - the prompt carries ONLY the selection re-derived from the immutable base
 *   revision plus that revision's copied evidence context under the fixed
 *   bounds in `documentRewriteTypes.ts` — never the whole workspace;
 * - output is replacement text only; provider reasoning, raw stream payloads,
 *   and provider exceptions never reach the ledger, SSE, or logs. Instructions
 *   and selections are never logged.
 * - cancellation is the DELETE-side durable flag observed at the provider
 *   boundary: the transport is interrupted and the store's status CAS
 *   finalizes `cancelled`; shutdown interrupts and finalizes `failed`.
 * - exactly one active rewrite per document (partial unique index plus the
 *   synchronous per-document slot here).
 */
import { cleanFinal } from "./agent.js";
import { auditRemoteEgressTarget } from "./egressAudit.js";
import { authorizeRemoteEgressOperation, RemoteEgressConsentRequiredError } from "./egressPolicy.js";
import {
  DocumentRewriteNotFoundError,
  DocumentRewriteSelectionMismatchError,
  DocumentRewriteStateError,
  type DocumentStore,
  type StoredDocumentRewrite,
} from "./db/stores/documentStore.js";
import type { ChatStore } from "./db/stores/chatStore.js";
import {
  DOCUMENT_REWRITE_MAX_OUTPUT_TOKENS,
  DOCUMENT_REWRITE_REPLACEMENT_MAX_CHARS,
  buildRewriteEvidenceContext,
  buildRewritePromptMessages,
  DocumentRewriteSelectionInvalidError,
  DocumentRewriteSelectionOversizeError,
} from "./documentRewriteTypes.js";
import { publicLlmModelId } from "./llmAliases.js";
import { streamingChat } from "./llm.js";
import { getRuntimeSettings } from "./runtimeSettings.js";

const CANCEL_POLL_INTERVAL_MS = 400;
const CLAIM_INTERVAL_MS = 30_000;
const CLAIM_BATCH_LIMIT = 50;

export interface DocumentRewriteRunnerDependencies {
  readonly store: DocumentStore;
  readonly chats: ChatStore;
  readonly cancelPollIntervalMs?: number;
  readonly claimIntervalMs?: number;
  readonly claimBatchLimit?: number;
}

interface ActiveExecution {
  readonly rewriteId: string;
  readonly accountId: string;
  readonly documentId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly settle: () => void;
  shutdownAborted: boolean;
  cancelObserved: boolean;
  cancelTimer?: NodeJS.Timeout;
}

/** Stable generic failure codes; never derived from provider bodies or text. */
const FAILURE_PROVIDER = "DOCUMENT_REWRITE_PROVIDER_FAILED";
const FAILURE_OUTPUT = "DOCUMENT_REWRITE_OUTPUT_REJECTED";
const FAILURE_RESTART = "SERVER_RESTARTED";
const FAILURE_SELECTION = "DOCUMENT_REWRITE_SELECTION_MISMATCH";
const FAILURE_CONSENT = "REMOTE_EGRESS_CONSENT_REQUIRED";

export function createDocumentRewriteRunner(dependencies: DocumentRewriteRunnerDependencies) {
  const store = dependencies.store;
  const chats = dependencies.chats;
  const cancelPollIntervalMs = dependencies.cancelPollIntervalMs ?? CANCEL_POLL_INTERVAL_MS;
  const claimIntervalMs = dependencies.claimIntervalMs ?? CLAIM_INTERVAL_MS;
  const claimBatchLimit = dependencies.claimBatchLimit ?? CLAIM_BATCH_LIMIT;

  const active = new Map<string, ActiveExecution>();
  let quiescing = false;
  let claimTimer: NodeJS.Timeout | undefined;
  let activeBootstrap: { readonly done: Promise<void> } | undefined;

  // -- Execution ---------------------------------------------------------------

  function registerCancelObserver(execution: ActiveExecution): void {
    execution.cancelTimer = setInterval(() => {
      void store
        .getDocumentRewriteCancelState(execution.accountId, execution.documentId, execution.rewriteId)
        .then((state) => {
          if (state === null || state.cancelRequested || (state.status !== "queued" && state.status !== "running")) {
            if (state?.cancelRequested) execution.cancelObserved = true;
            if (!execution.controller.signal.aborted) execution.controller.abort();
          }
        })
        .catch(() => {
          // Transient store failure; the next poll or the terminal path settles.
        });
    }, cancelPollIntervalMs);
    execution.cancelTimer.unref();
  }

  /** Account default chat model, else the workspace default. */
  async function resolveRewriteModel(accountId: string): Promise<string> {
    try {
      const accountDefault = await chats.getDefaultChatModel(accountId);
      if (accountDefault) return publicLlmModelId(accountDefault);
    } catch {
      // Missing account preference: fall through to the workspace default.
    }
    const snapshot = await getRuntimeSettings();
    return publicLlmModelId(snapshot.settings.chatModel);
  }

  async function runProvider(execution: ActiveExecution, rewrite: StoredDocumentRewrite, model: string): Promise<void> {
    const prompt = await store.getDocumentRewritePromptContext(rewrite.accountId, rewrite.documentId, rewrite.id);
    if (!prompt) return; // Document/rewrite ownership vanished; the row is gone with it.

    // Ingestion-style consent recheck: authorize this exact account against
    // the live target immediately before the first transport. A remote
    // provider that lost acknowledgment produces no transport call.
    const target = await authorizeRemoteEgressOperation(rewrite.accountId);

    const contextBlock = buildRewriteEvidenceContext(prompt.evidence);
    const messages = buildRewritePromptMessages({
      instruction: prompt.instruction,
      selectionText: prompt.selectionText,
      contextBlock,
    });
    const completion = await streamingChat(
      messages,
      {
        accountId: rewrite.accountId,
        model,
        maxTokens: DOCUMENT_REWRITE_MAX_OUTPUT_TOKENS,
        signal: execution.controller.signal,
      },
      () => undefined
    );
    void auditRemoteEgressTarget("remote_turn", rewrite.accountId, target);

    const content = cleanFinal(completion.choices[0]?.message?.content ?? "");
    if (!content.trim()) throw new Error("rewrite output is empty");
    if (content.length > DOCUMENT_REWRITE_REPLACEMENT_MAX_CHARS) {
      throw new Error("rewrite output exceeds the replacement bound");
    }
    await store.completeDocumentRewrite(rewrite.accountId, rewrite.documentId, rewrite.id, {
      replacement: content,
      model,
    });
  }

  async function finalizeFailure(execution: ActiveExecution, error: unknown): Promise<void> {
    const { accountId, documentId, rewriteId, shutdownAborted, cancelObserved } = execution;
    const settleAs = (code: string | null) =>
      code === null
        ? store.cancelDocumentRewrite(accountId, documentId, rewriteId).catch(() => undefined)
        : store
            .failDocumentRewrite(accountId, documentId, rewriteId, {
              errorCode: code,
              errorReason: code === FAILURE_OUTPUT ? "the model response was not usable replacement text" : undefined,
            })
            .catch(() => undefined);
    try {
      if (error instanceof DocumentRewriteNotFoundError) return; // Row deleted underneath; nothing to finalize.
      if (error instanceof RemoteEgressConsentRequiredError) {
        await settleAs(FAILURE_CONSENT);
        return;
      }
      if (execution.controller.signal.aborted) {
        // Cancellation-wins: a requested cancellation finalizes `cancelled`;
        // a shutdown interrupt finalizes `failed` — never a silent retry.
        await settleAs(cancelObserved && !shutdownAborted ? null : FAILURE_RESTART);
        return;
      }
      if (
        error instanceof DocumentRewriteSelectionMismatchError ||
        error instanceof DocumentRewriteSelectionInvalidError ||
        error instanceof DocumentRewriteSelectionOversizeError
      ) {
        await settleAs(FAILURE_SELECTION);
        return;
      }
      if (error instanceof Error && error.message === "model stream budget exceeded") {
        await settleAs(FAILURE_OUTPUT);
        return;
      }
      if (error instanceof Error && error.message === "rewrite output is empty") {
        await settleAs(FAILURE_OUTPUT);
        return;
      }
      if (error instanceof Error && error.message === "rewrite output exceeds the replacement bound") {
        await settleAs(FAILURE_OUTPUT);
        return;
      }
      if (error instanceof DocumentRewriteStateError) return; // A terminal transition already won the race.
      await settleAs(FAILURE_PROVIDER);
    } catch {
      // The durable row is owned by the next startup recovery.
    }
  }

  async function executeClaimed(rewrite: StoredDocumentRewrite): Promise<void> {
    if (quiescing || active.has(rewrite.documentId)) return;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const execution: ActiveExecution = {
      rewriteId: rewrite.id,
      accountId: rewrite.accountId,
      documentId: rewrite.documentId,
      controller: new AbortController(),
      done,
      settle,
      shutdownAborted: false,
      cancelObserved: false,
    };
    // The per-document slot is reserved synchronously so the claim loop and a
    // service dispatch can never enter the same document twice across an await.
    active.set(rewrite.documentId, execution);
    registerCancelObserver(execution);
    try {
      let model: string;
      try {
        model = await resolveRewriteModel(rewrite.accountId);
      } catch {
        model = "";
      }
      let live: StoredDocumentRewrite;
      try {
        live = await store.markDocumentRewriteRunning(rewrite.accountId, rewrite.documentId, rewrite.id, model);
      } catch {
        return;
      }
      if (live.status !== "running") return; // A durable cancellation or another claim won.
      try {
        await runProvider(execution, live, model || "unknown");
      } catch (error) {
        await finalizeFailure(execution, error);
      }
    } finally {
      if (execution.cancelTimer) clearInterval(execution.cancelTimer);
      if (active.get(rewrite.documentId) === execution) active.delete(rewrite.documentId);
      execution.settle();
    }
  }

  // -- Durable claim loop --------------------------------------------------------

  async function claimQueued(): Promise<void> {
    if (quiescing) return;
    let claims: readonly StoredDocumentRewrite[];
    try {
      claims = await store.listQueuedDocumentRewrites(claimBatchLimit);
    } catch {
      return;
    }
    for (const claim of claims) {
      if (quiescing) return; // The durable queued row survives for the next resume.
      if (active.has(claim.documentId)) continue;
      await executeClaimed(claim);
    }
  }

  /** Startup resume: recover interrupted rows, then claim undispatched ones. */
  function start(): void {
    if (quiescing) return;
    if (activeBootstrap) return;
    const handle: { done: Promise<void> } = { done: Promise.resolve() };
    activeBootstrap = handle;
    handle.done = (async () => {
      try {
        await store.recoverInterruptedDocumentRewrites();
      } catch {
        // Repair is durable; a later start retries.
      }
      await claimQueued().catch(() => undefined);
      if (activeBootstrap === handle) activeBootstrap = undefined;
    })();
    void handle.done.catch(() => undefined);
    if (claimTimer === undefined && !quiescing) {
      claimTimer = setInterval(() => void claimQueued().catch(() => undefined), claimIntervalMs);
      claimTimer.unref();
    }
  }

  /**
   * Synchronous quiescence: no further claim or dispatch starts and active
   * provider transports are interrupted before the first await. The returned
   * promise settles only after every execution finalized its durable row —
   * an interrupted rewrite is `failed` (never half-applied, never replayed).
   */
  function stop(): Promise<void> {
    quiescing = true;
    if (claimTimer) clearInterval(claimTimer);
    claimTimer = undefined;
    for (const execution of active.values()) {
      execution.shutdownAborted = true;
      if (!execution.controller.signal.aborted) execution.controller.abort();
    }
    const drains = [...active.values()].map((execution) => execution.done);
    const bootstrap = activeBootstrap?.done ?? Promise.resolve();
    return Promise.allSettled([bootstrap, ...drains]).then(() => undefined);
  }

  /** Fire-and-forget dispatch of a freshly accepted queued row. */
  function dispatch(rewrite: StoredDocumentRewrite): void {
    if (quiescing || active.has(rewrite.documentId)) return; // The claim loop resumes the durable row.
    void executeClaimed(rewrite).catch(() => undefined);
  }

  return {
    start,
    stop,
    dispatch,
    isRunning: () => !quiescing && (claimTimer !== undefined || activeBootstrap !== undefined || active.size > 0),
    activeRewriteCount: () => active.size,
  };
}

export type DocumentRewriteRunner = ReturnType<typeof createDocumentRewriteRunner>;

/**
 * The composition-owned default runner. `applicationRuntime` binds the single
 * executor at startup and clears it when its ownership is released. Routes
 * and services dispatch through it when live; the durable `queued` row is the
 * contract, so a missing executor only defers execution to the next resume.
 */
let defaultRunner: DocumentRewriteRunner | undefined;

export function bindDefaultDocumentRewriteRunner(runner: DocumentRewriteRunner | undefined): void {
  defaultRunner = runner;
}

export function defaultDocumentRewriteRunner(): DocumentRewriteRunner | undefined {
  return defaultRunner;
}
