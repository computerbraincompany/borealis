/**
 * Durable local research execution (M15 stage 2).
 *
 * The runner is the single executor over `research_runs`:
 * - startup resume recovers interrupted dispatched runs through the store's
 *   durable contract (cancel-requested → cancelled; running steps revert to
 *   `pending` under the SAME identity with their attempt counter intact, so
 *   the restart retry happens at most once), then claims resumable rows in
 *   acceptance order;
 * - one research run executes per account at a time (the durable queue keeps
 *   the rest); one active run per definition is enforced by the store;
 * - each step searches the run's PINNED (source, generation) contract through
 *   M14's `searchCapturedScope` (keyword per planned question, then one
 *   optional semantic pass through the account-authorized embedding boundary
 *   with a consent recheck and content-free audit). A pinned generation that
 *   is no longer available stops that step as `source_changed`; partial work
 *   is retained and never silently continues against a newer generation;
 * - evidence is captured IMMUTABLY during steps, always before any synthesis
 *   call; inserts dedupe by (run, source, generation, chunk, excerpt hash);
 * - step outcomes persist before the runner advances to the next step;
 * - the fixed orchestration budgets (8 steps, 32 searches, 40 model requests
 *   including synthesis, 100/2k/200k evidence, 15-minute wall time) are
 *   enforced through the store's usage CAS and the run's captured budget copy.
 *   Exhaustion finishes honestly as `needs_review` with explicit gap rows and
 *   preserved partial work — never as a successful exhaustive answer;
 * - memo synthesis produces claims/gaps whose citations are validated against
 *   the run's own captured evidence (invalid or foreign references are
 *   rejected); comparison synthesis performs per-column typed cell extraction
 *   where a value that does not match its column type is stored `invalid`
 *   verbatim, never string-coerced;
 * - every provider/embedding call is one bounded call through the same
 *   account-authorized streaming runtime as chat traffic: consent-gated, with
 *   no reasoning exposure and no provider payload in the ledger;
 * - cancellation is the DELETE-side durable flag observed at safe points;
 *   shutdown interrupts transports and leaves the durable row for the bounded
 *   startup resume; nothing publishes partial output as complete.
 */
import { createHash } from "node:crypto";

import { cleanFinal } from "./agent.js";
import { auditRemoteEgressTarget } from "./egressAudit.js";
import { authorizeRemoteEgressOperation, RemoteEgressConsentRequiredError } from "./egressPolicy.js";
import type { RemoteEgressTarget } from "./egressPolicy.js";
import {
  ResearchBudgetExhaustedError,
  ResearchClaimCapError,
  ResearchEvidenceCapError,
  ResearchRunNotFoundError,
  ResearchRunStateError,
  ResearchStoreError,
  ResearchTableLimitError,
  type ResearchStore,
  type StoredResearchRevision,
  type StoredResearchRun,
  type StoredResearchStep,
} from "./db/stores/researchStore.js";
import { discoverChatModels, streamingChat, type ChatMessage } from "./llm.js";
import { sameLlmModel } from "./llmAliases.js";
import {
  RESEARCH_CLAIM_TEXT_MAX_CHARS,
  RESEARCH_EVIDENCE_EXCERPT_MAX_CHARS,
  RESEARCH_EVIDENCE_REFS_MAX,
  RESEARCH_LABEL_MAX_CHARS,
  RESEARCH_QUERY_MAX_CHARS,
  RESEARCH_STEP_OUTCOME_MAX_CHARS,
  ResearchValidationError,
} from "./researchSchemas.js";
import { defaultResearchPlan, parseJsonObject, type ResearchChatTransport } from "./researchPlanner.js";
import {
  searchCapturedScope,
  type SourceSearchMode,
  type SourceSearchPorts,
  type SourceSearchResult,
} from "./sourceSearch.js";

const CANCEL_POLL_INTERVAL_MS = 400;
const CLAIM_INTERVAL_MS = 30_000;
const CLAIM_BATCH_LIMIT = 50;

// Hidden reasoning consumes provider output tokens too. Match the ordinary
// agent's bounded allocation while retaining 40 requests/run, 15 minutes, and
// the transport's independent content/reasoning character caps.
const STEP_MAX_OUTPUT_TOKENS = 8_192;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 8_192;
const COLUMN_MAX_OUTPUT_TOKENS = 8_192;
/** Bounded evidence context for one step/synthesis/column prompt. */
const PROMPT_EVIDENCE_TOTAL_CHARS = 24_000;
const PROMPT_STEP_EXCERPT_CHARS = 600;
const PROMPT_SYNTHESIS_EXCERPT_CHARS = 300;
const PROMPT_COLUMN_EXCERPT_CHARS = 400;
const PROMPT_COLUMN_EXCERPTS_PER_ROW = 4;
const CELL_EXPLANATION_MAX_CHARS = 1_000;

/** Stable generic failure codes; never derived from provider bodies or text. */
const FAILURE_PROVIDER = "RESEARCH_PROVIDER_FAILED";
const FAILURE_MODEL = "RESEARCH_MODEL_UNAVAILABLE";
const FAILURE_CONSENT = "REMOTE_EGRESS_CONSENT_REQUIRED";
const CODE_BUDGET = "RESEARCH_BUDGET_EXHAUSTED";
const CODE_SOURCE_CHANGED = "RESEARCH_SOURCE_CHANGED";
const CODE_OUTPUT = "RESEARCH_OUTPUT_REJECTED";

export interface ResearchRunnerDependencies {
  readonly store: ResearchStore;
  /** Search boundary; defaults to M14 `searchCapturedScope` over the stores. */
  readonly search?: (input: {
    accountId: string;
    scopes: readonly { sourceId: string; generation: number }[];
    query: string;
    mode: SourceSearchMode;
    signal?: AbortSignal;
  }) => Promise<SourceSearchResult>;
  /** Ports forwarded to the search boundary (embedding seam for tests). */
  readonly searchPorts?: () => SourceSearchPorts;
  readonly chat?: ResearchChatTransport;
  /** Live model catalog check; defaults to provider discovery. */
  readonly discover?: () => Promise<{
    discovery: "live" | "unavailable";
    available_models: readonly { id: string }[];
  }>;
  readonly nowMs?: () => number;
  readonly cancelPollIntervalMs?: number;
  readonly claimIntervalMs?: number;
  readonly claimBatchLimit?: number;
}

interface CapturedEvidence {
  readonly id: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly stepOrdinal: number;
}

interface ActiveExecution {
  readonly runId: string;
  readonly accountId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly settle: () => void;
  shutdownAborted: boolean;
  cancelObserved: boolean;
  ownershipLost: boolean;
  currentStepOrdinal: number | null;
  cancelTimer?: NodeJS.Timeout;
}

/** Pipeline-level stop reasons; each maps to an honest final state + gap. */
interface PipelineState {
  searchesExhausted: boolean;
  modelBudgetExhausted: boolean;
  evidenceCapReached: boolean;
  wallClockExceeded: boolean;
  sourceChanged: boolean;
  tableLimitReached: boolean;
  synthesisRejected: boolean;
  zeroEvidence: boolean;
}

class OwnershipLost extends Error {
  constructor() {
    super("research run ownership lost");
    this.name = "OwnershipLost";
  }
}

class ProviderFailure extends Error {
  constructor() {
    super("research provider call failed");
    this.name = "ProviderFailure";
  }
}

class ModelUnavailable extends Error {
  constructor() {
    super("research chat model is not available on the provider");
    this.name = "ModelUnavailable";
  }
}

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function normalizeClaimClassification(value: unknown): "supported" | "conflicting" | "unsupported" {
  return value === "supported" || value === "conflicting" || value === "unsupported" ? value : "unsupported";
}

export function createResearchRunner(dependencies: ResearchRunnerDependencies) {
  const store = dependencies.store;
  const search = dependencies.search ?? ((input) => searchCapturedScope(input, dependencies.searchPorts?.() ?? {}));
  const chat: ResearchChatTransport = dependencies.chat ?? streamingChat;
  const discover = dependencies.discover ?? (() => discoverChatModels());
  const nowMs = dependencies.nowMs ?? (() => Date.now());
  const cancelPollIntervalMs = dependencies.cancelPollIntervalMs ?? CANCEL_POLL_INTERVAL_MS;
  const claimIntervalMs = dependencies.claimIntervalMs ?? CLAIM_INTERVAL_MS;
  const claimBatchLimit = dependencies.claimBatchLimit ?? CLAIM_BATCH_LIMIT;

  /** One executing research run per account, keyed synchronously by account. */
  const active = new Map<string, ActiveExecution>();
  let quiescing = false;
  let claimTimer: NodeJS.Timeout | undefined;
  let activeBootstrap: { readonly done: Promise<void> } | undefined;

  // -- Helpers -----------------------------------------------------------------

  function registerCancelObserver(execution: ActiveExecution): void {
    execution.cancelTimer = setInterval(() => {
      void store
        .getResearchRun(execution.accountId, execution.runId)
        .then((run) => {
          if (run === undefined) {
            execution.ownershipLost = true;
            if (!execution.controller.signal.aborted) execution.controller.abort();
            return;
          }
          if (run.cancelRequested || !["queued", "running", "cancelling"].includes(run.status)) {
            if (run.cancelRequested) execution.cancelObserved = true;
            if (!execution.controller.signal.aborted) execution.controller.abort();
          }
        })
        .catch(() => {
          // Transient store failure; the next poll or the terminal path settles.
        });
    }, cancelPollIntervalMs);
    execution.cancelTimer.unref();
  }

  function assertAlive(execution: ActiveExecution): void {
    if (execution.controller.signal.aborted) throw abortError();
  }

  function wallClockExceeded(run: StoredResearchRun): boolean {
    const startedAt = run.startedAt === null ? null : Date.parse(run.startedAt);
    if (startedAt === null || Number.isNaN(startedAt)) return false;
    return nowMs() - startedAt >= run.budgets.wallMs;
  }

  /**
   * Consume one usage unit through the store's CAS. A budget breach is the
   * honest exhaustion signal; a run-state breach means a durable
   * cancellation/deletion raced us — surfaced as an abort so the terminal
   * paths settle the row honestly.
   */
  async function consumeUsage(
    execution: ActiveExecution,
    run: StoredResearchRun,
    usage: { searches?: number; modelRequests?: number }
  ): Promise<"ok" | "exhausted"> {
    try {
      await store.incrementResearchRunUsage(run.accountId, run.id, usage);
      return "ok";
    } catch (error) {
      if (error instanceof ResearchBudgetExhaustedError) return "exhausted";
      if (error instanceof ResearchRunStateError || error instanceof ResearchRunNotFoundError) throw abortError();
      throw error;
    }
  }

  function evidencePromptBlock(
    evidence: readonly CapturedEvidence[],
    perExcerptChars: number,
    totalChars: number
  ): string {
    let block = "";
    let omitted = 0;
    for (const item of evidence) {
      const line = `[${item.id}] ${item.excerpt.slice(0, perExcerptChars)}\n`;
      if (block.length + line.length > totalChars) {
        omitted += 1;
        continue;
      }
      block += line;
    }
    if (omitted > 0) block += `(${omitted} additional evidence items omitted from this prompt)\n`;
    return block;
  }

  async function settleStep(
    accountId: string,
    runId: string,
    ordinal: number,
    status: "done" | "source_changed" | "skipped" | "failed",
    outcome: string
  ): Promise<void> {
    try {
      await store.recordResearchStepOutcome(
        accountId,
        runId,
        ordinal,
        status,
        clip(outcome, RESEARCH_STEP_OUTCOME_MAX_CHARS)
      );
    } catch (error) {
      if (error instanceof ResearchRunStateError || error instanceof ResearchRunNotFoundError) return;
      throw error;
    }
  }

  // -- One search operation ------------------------------------------------------

  type SearchOutcome = "ok" | "source_changed" | "budget" | "evidence_cap";

  async function runSearchOperation(
    execution: ActiveExecution,
    run: StoredResearchRun,
    scopes: readonly { sourceId: string; generation: number }[],
    query: string,
    mode: SourceSearchMode,
    stepOrdinal: number,
    dossier: Map<string, CapturedEvidence>
  ): Promise<SearchOutcome> {
    assertAlive(execution);
    if ((await consumeUsage(execution, run, { searches: 1 })) === "exhausted") return "budget";

    let target: RemoteEgressTarget | undefined;
    if (mode === "semantic") {
      // Ingestion-style consent recheck immediately before the embedding
      // transport: an unacknowledged remote provider makes no transport call.
      target = await authorizeRemoteEgressOperation(run.accountId);
    }

    let result: SourceSearchResult;
    try {
      result = await search({
        accountId: run.accountId,
        scopes,
        query: query.trim().slice(0, RESEARCH_QUERY_MAX_CHARS),
        mode,
        signal: execution.controller.signal,
      });
    } catch (error) {
      if (isAbortError(error) || error instanceof RemoteEgressConsentRequiredError) throw error;
      throw new ProviderFailure();
    }
    if (target) void auditRemoteEgressTarget("remote_ingest", run.accountId, target);

    if (result.scope.some((entry) => entry.status === "source_changed")) return "source_changed";

    for (const hit of result.hits) {
      assertAlive(execution);
      const excerpt = hit.excerpt.trim().slice(0, RESEARCH_EVIDENCE_EXCERPT_MAX_CHARS);
      if (!excerpt) continue;
      try {
        const inserted = await store.insertResearchEvidence(run.accountId, run.id, {
          sourceId: hit.source_id,
          generation: hit.generation,
          chunkId: hit.chunk_id,
          label: clip(hit.label.trim() || "Source", RESEARCH_LABEL_MAX_CHARS),
          locators: hit.locators,
          excerpt,
          contentHash: sha256(excerpt),
          stepOrdinal,
          query: query.trim().slice(0, RESEARCH_QUERY_MAX_CHARS),
        });
        dossier.set(inserted.id, { id: inserted.id, sourceId: hit.source_id, excerpt, stepOrdinal });
      } catch (error) {
        if (error instanceof ResearchEvidenceCapError) return "evidence_cap";
        if (error instanceof ResearchRunStateError || error instanceof ResearchRunNotFoundError) throw abortError();
        throw error;
      }
    }
    return "ok";
  }

  // -- One bounded model call ------------------------------------------------------

  async function modelCall(
    execution: ActiveExecution,
    run: StoredResearchRun,
    messages: ChatMessage[],
    maxTokens: number
  ): Promise<string> {
    assertAlive(execution);
    const target = await authorizeRemoteEgressOperation(run.accountId);
    try {
      const completion = await chat(
        messages,
        {
          accountId: run.accountId,
          model: run.chatModel,
          maxTokens,
          signal: execution.controller.signal,
        },
        () => undefined
      );
      void auditRemoteEgressTarget("remote_turn", run.accountId, target);
      return cleanFinal(completion.choices?.[0]?.message?.content ?? "");
    } catch (error) {
      if (error instanceof RemoteEgressConsentRequiredError || isAbortError(error)) throw error;
      throw new ProviderFailure();
    }
  }

  // -- Step execution ---------------------------------------------------------------

  async function executeStep(
    execution: ActiveExecution,
    run: StoredResearchRun,
    step: StoredResearchStep,
    question: string,
    scopes: readonly { sourceId: string; generation: number }[],
    dossier: Map<string, CapturedEvidence>,
    state: PipelineState
  ): Promise<{ stopRun: boolean }> {
    const { accountId } = run;
    const runId = run.id;
    const driftOutcome =
      "a pinned source generation is no longer available; step stopped with captured evidence retained";

    for (const plannedQuestion of step.questions) {
      const outcome = await runSearchOperation(
        execution,
        run,
        scopes,
        plannedQuestion,
        "keyword",
        step.ordinal,
        dossier
      );
      if (outcome === "source_changed") {
        await settleStep(accountId, runId, step.ordinal, "source_changed", driftOutcome);
        state.sourceChanged = true;
        return { stopRun: true };
      }
      if (outcome === "evidence_cap") {
        state.evidenceCapReached = true;
        await settleStep(
          accountId,
          runId,
          step.ordinal,
          "skipped",
          "evidence capture reached the run cap; partial dossier retained for review"
        );
        return { stopRun: true };
      }
      if (outcome === "budget") {
        state.searchesExhausted = true;
        await settleStep(
          accountId,
          runId,
          step.ordinal,
          "skipped",
          "the run search budget was exhausted before this step finished"
        );
        return { stopRun: true };
      }
    }

    // Optional semantic pass: one extra search op with the step objective as
    // query, only while the search budget has room. Exhaustion skips it
    // quietly — the mandatory keyword plan already ran.
    if (!wallClockExceeded(run)) {
      const semantic = await runSearchOperation(
        execution,
        run,
        scopes,
        step.objective,
        "semantic",
        step.ordinal,
        dossier
      );
      if (semantic === "source_changed") {
        await settleStep(accountId, runId, step.ordinal, "source_changed", driftOutcome);
        state.sourceChanged = true;
        return { stopRun: true };
      }
      if (semantic === "evidence_cap") state.evidenceCapReached = true;
      // `budget` here only means the optional pass was skipped.
    }

    // Step prompts select this step's own captured evidence — never the whole
    // dossier. Evidence recorded under this ordinal by a prior interrupted
    // attempt belongs to the same identity and is summarized with it.
    const stepEvidence = [...dossier.values()].filter((item) => item.stepOrdinal === step.ordinal);
    if (stepEvidence.length === 0) {
      await settleStep(accountId, runId, step.ordinal, "done", "no relevant evidence found for this step");
      return { stopRun: false };
    }
    if (state.evidenceCapReached) {
      await settleStep(
        accountId,
        runId,
        step.ordinal,
        "skipped",
        "evidence capture reached the run cap before this step could be summarized"
      );
      return { stopRun: true };
    }

    if ((await consumeUsage(execution, run, { modelRequests: 1 })) === "exhausted") {
      state.modelBudgetExhausted = true;
      await settleStep(
        accountId,
        runId,
        step.ordinal,
        "done",
        "evidence captured; the run model-request budget was exhausted before a summary"
      );
      return { stopRun: true };
    }
    const block = evidencePromptBlock(stepEvidence, PROMPT_STEP_EXCERPT_CHARS, PROMPT_EVIDENCE_TOTAL_CHARS);
    const summary = await modelCall(
      execution,
      run,
      [
        {
          role: "system",
          content:
            "You summarize captured research evidence for one planned step. Use only the listed evidence; state plainly when it is insufficient. Never add facts, numbers, or sources that are not listed. Keep internal reasoning concise and reserve output space for the final summary. Keep the summary under 2000 characters.",
        },
        {
          role: "user",
          content:
            `Research question: ${clip(question, 2_000)}\nStep objective: ${step.objective}\n\n` +
            `Evidence captured for this step:\n${block}\nWrite the step summary now.`,
        },
      ],
      STEP_MAX_OUTPUT_TOKENS
    );
    if (!summary) state.synthesisRejected = true;
    await settleStep(accountId, runId, step.ordinal, "done", summary || "the model returned no usable summary");
    return { stopRun: false };
  }

  // -- Synthesis ---------------------------------------------------------------------

  async function synthesizeMemo(
    execution: ActiveExecution,
    run: StoredResearchRun,
    revision: StoredResearchRevision,
    dossier: Map<string, CapturedEvidence>,
    state: PipelineState
  ): Promise<void> {
    const { accountId } = run;
    const runId = run.id;
    if (dossier.size === 0) {
      state.zeroEvidence = true;
      return;
    }
    if ((await consumeUsage(execution, run, { modelRequests: 1 })) === "exhausted") {
      state.modelBudgetExhausted = true;
      return;
    }
    const block = evidencePromptBlock(
      [...dossier.values()],
      PROMPT_SYNTHESIS_EXCERPT_CHARS,
      PROMPT_EVIDENCE_TOTAL_CHARS
    );
    const content = await modelCall(
      execution,
      run,
      [
        {
          role: "system",
          content:
            'You answer a research question from captured local evidence and return one JSON object only: {"claims":[{"text":"...","classification":"supported|conflicting|unsupported","evidence_ids":["..."]}],"gaps":["..."]}. Rules: a claim cites only evidence ids listed in the prompt, at most 5 per claim; "conflicting" requires at least two cited excerpts that materially differ; anything not found in the evidence goes into gaps as "not found in selected evidence", never presented as proof that a fact does not exist; at most 100 claims and 50 gaps; each text under 2000 characters.',
        },
        {
          role: "user",
          content: `Research question: ${revision.question}\n\nCaptured evidence (id, then excerpt):\n${block}\nKeep internal reasoning concise and reserve output space for the complete JSON. Write the JSON now.`,
        },
      ],
      SYNTHESIS_MAX_OUTPUT_TOKENS
    );
    const parsed = parseJsonObject(content);
    if (!parsed) {
      state.synthesisRejected = true;
      return;
    }
    const claims = Array.isArray(parsed.claims) ? parsed.claims.slice(0, 100) : [];
    const gaps = Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 50) : [];
    for (const entry of claims) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!text) continue;
      const rawRefs = Array.isArray(record.evidence_ids) ? record.evidence_ids : [];
      const refs = [
        ...new Set(rawRefs.filter((ref): ref is string => typeof ref === "string" && dossier.has(ref))),
      ].slice(0, RESEARCH_EVIDENCE_REFS_MAX);
      let classification = normalizeClaimClassification(record.classification);
      const distinctExcerpts = new Set(refs.map((ref) => dossier.get(ref)!.excerpt));
      if (classification === "conflicting" && (refs.length < 2 || distinctExcerpts.size < 2)) {
        classification = "unsupported";
      }
      if (classification === "supported" && refs.length === 0) classification = "unsupported";
      try {
        await store.addResearchClaim(accountId, runId, {
          kind: "claim",
          text: clip(text, RESEARCH_CLAIM_TEXT_MAX_CHARS),
          classification,
          evidenceRefs: refs,
        });
      } catch (error) {
        if (error instanceof ResearchClaimCapError) break;
        if (error instanceof ResearchRunStateError || error instanceof ResearchRunNotFoundError) return;
        // A claim whose references did not resolve to this run's dossier is
        // rejected here; the store's FK check is the durable net.
        if (error instanceof ResearchValidationError || error instanceof ResearchStoreError) continue;
        throw error;
      }
    }
    for (const gapValue of gaps) {
      if (typeof gapValue !== "string") continue;
      const gap = gapValue.trim();
      if (!gap) continue;
      try {
        await store.addResearchClaim(accountId, runId, { kind: "gap", text: clip(gap, RESEARCH_CLAIM_TEXT_MAX_CHARS) });
      } catch (error) {
        if (error instanceof ResearchClaimCapError) break;
        if (error instanceof ResearchRunStateError || error instanceof ResearchRunNotFoundError) return;
        if (error instanceof ResearchValidationError || error instanceof ResearchStoreError) continue;
        throw error;
      }
    }
  }

  async function synthesizeComparison(
    execution: ActiveExecution,
    run: StoredResearchRun,
    revision: StoredResearchRevision,
    dossier: Map<string, CapturedEvidence>,
    state: PipelineState
  ): Promise<void> {
    const { accountId } = run;
    const runId = run.id;
    const selectedRows = run.rerunSelection?.row_source_ids.length
      ? run.sources.filter((source) => run.rerunSelection!.row_source_ids.includes(source.sourceId))
      : run.sources;
    const selectedColumns = run.rerunSelection?.column_ids.length
      ? revision.columns.filter((column) => run.rerunSelection!.column_ids.includes(column.id))
      : revision.columns;

    for (const column of selectedColumns) {
      if (state.tableLimitReached || state.modelBudgetExhausted) break;
      if ((await consumeUsage(execution, run, { modelRequests: 1 })) === "exhausted") {
        state.modelBudgetExhausted = true;
        break;
      }
      let block = "";
      for (const row of selectedRows) {
        const rowEvidence = [...dossier.values()]
          .filter((item) => item.sourceId === row.sourceId)
          .slice(0, PROMPT_COLUMN_EXCERPTS_PER_ROW);
        let rowBlock = "";
        for (const item of rowEvidence) {
          const line = `[${item.id}] ${item.excerpt.slice(0, PROMPT_COLUMN_EXCERPT_CHARS)}\n`;
          if (block.length + rowBlock.length + line.length > PROMPT_EVIDENCE_TOTAL_CHARS) break;
          rowBlock += line;
        }
        block += `row source_id=${row.sourceId}\n${rowBlock}`;
      }
      const choicesHint = column.choices ? `\nAllowed exact enum values: ${JSON.stringify(column.choices)}` : "";
      const content = await modelCall(
        execution,
        run,
        [
          {
            role: "system",
            content:
              'You extract one typed value per document row from the listed evidence and return one JSON object only: {"cells":[{"source_id":"...","value":<typed value or null>,"evidence_ids":["..."],"status":"supported|conflicting|not_found","explanation":"..."}]}. Every non-null value must cite 1–5 bracketed evidence ids from that same source row; copy the exact ids, never source ids or invented ids. Use conflicting only when at least two cited excerpts materially disagree. Rules: "value" must exactly match the column type — a number is a JSON number (never a quoted string), a date is a JSON string in exact YYYY-MM-DD ISO calendar form, a boolean is a JSON true/false, an enum value is one of the allowed exact strings, text is a JSON string under 2000 characters. If the evidence does not state the value, omit the row or set value to null with status not_found and an empty evidence_ids array — never guess or coerce. One cell per row at most. Keep internal reasoning concise; reserve output space for the complete JSON object.',
          },
          {
            role: "user",
            content:
              `Column "${column.label}" (question: ${column.question})\nType: ${column.type}` +
              `${column.unit ? `\nUnit: ${column.unit}` : ""}${choicesHint}\n\n` +
              `Rows with their captured evidence (bracketed ids):\n${block}\nWrite the JSON now.`,
          },
        ],
        COLUMN_MAX_OUTPUT_TOKENS
      );
      const parsed = parseJsonObject(content);
      if (!parsed) {
        // Unusable extraction output: stop honestly with the table partial.
        state.synthesisRejected = true;
        break;
      }
      const cells = Array.isArray(parsed.cells) ? (parsed.cells as readonly unknown[]) : [];
      const bySource = new Map<string, Record<string, unknown>>();
      for (const entry of cells) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.source_id === "string") bySource.set(record.source_id.toLowerCase(), record);
      }
      for (const row of selectedRows) {
        const record = bySource.get(row.sourceId);
        const rawValue = record && "value" in record ? record.value : null;
        const rawRefs = Array.isArray(record?.evidence_ids) ? (record.evidence_ids as readonly unknown[]) : [];
        const refs = [
          ...new Set(
            rawRefs.filter(
              (ref): ref is string =>
                typeof ref === "string" && dossier.has(ref) && dossier.get(ref)!.sourceId === row.sourceId
            )
          ),
        ].slice(0, RESEARCH_EVIDENCE_REFS_MAX);
        const explanation =
          typeof record?.explanation === "string" ? clip(record.explanation.trim(), CELL_EXPLANATION_MAX_CHARS) : null;
        const distinctExcerpts = new Set(refs.map((ref) => dossier.get(ref)!.excerpt));
        const assertConflicting = record?.status === "conflicting" && refs.length >= 2 && distinctExcerpts.size >= 2;
        const unsupportedValue = rawValue !== null && refs.length === 0;
        if (unsupportedValue) state.synthesisRejected = true;
        try {
          await store.recordResearchMachineCell(accountId, runId, {
            columnId: column.id,
            rowSourceId: row.sourceId,
            ...(unsupportedValue
              ? { assertedStatus: "invalid" as const }
              : assertConflicting
                ? { assertedStatus: "conflicting" as const }
                : {}),
            rawValue,
            evidenceRefs: refs,
            explanation: unsupportedValue
              ? "The model value has no valid captured evidence for this source row."
              : explanation,
          });
        } catch (error) {
          if (error instanceof ResearchTableLimitError) {
            state.tableLimitReached = true;
            break;
          }
          // A malformed row/column reference is rejected; the cell stays
          // absent (honest not-written state), never coerced or guessed.
          if (error instanceof ResearchValidationError || error instanceof ResearchRunStateError) continue;
          throw error;
        }
      }
    }
  }

  // -- Pipeline -----------------------------------------------------------------------

  async function runPipeline(execution: ActiveExecution, run: StoredResearchRun): Promise<void> {
    const accountId = run.accountId;
    const revision = await store.getResearchRevisionContent(accountId, run.definitionId, run.definitionRevision);
    if (!revision) throw new OwnershipLost();
    assertAlive(execution);

    // The captured chat model is revalidated against the live catalog when
    // discovery answers; an unavailable catalog defers to the transport, whose
    // unknown-id failure settles honestly as a provider failure.
    const catalog = await discover();
    if (
      catalog.discovery === "live" &&
      !catalog.available_models.some((model) => sameLlmModel(model.id, run.chatModel))
    ) {
      throw new ModelUnavailable();
    }

    const plan = revision.plan.steps.length ? revision.plan : defaultResearchPlan(revision.question);
    await store.materializeResearchSteps(
      accountId,
      run.id,
      plan.steps.map((step) => ({ objective: step.objective, questions: [...step.questions] }))
    );
    const steps = await store.listResearchSteps(accountId, run.id);

    // Reload the dossier captured by any prior attempt so a restart retry
    // summarizes/ synthesizes over the same immutable evidence (dedupe
    // prevents duplicate rows under the same run identity).
    const dossier = new Map<string, CapturedEvidence>();
    let after: { timestamp: string; id: string } | null = null;
    for (;;) {
      const page = await store.listResearchEvidence(accountId, run.id, { limit: 50, after });
      for (const item of page.items) {
        dossier.set(item.id, {
          id: item.id,
          sourceId: item.sourceId,
          excerpt: item.excerpt,
          stepOrdinal: item.stepOrdinal,
        });
      }
      after = page.next;
      if (!after) break;
    }

    const state: PipelineState = {
      searchesExhausted: false,
      modelBudgetExhausted: false,
      evidenceCapReached: false,
      wallClockExceeded: false,
      sourceChanged: false,
      tableLimitReached: false,
      synthesisRejected: false,
      zeroEvidence: false,
    };
    const scopes = run.sources.map((source) => ({ sourceId: source.sourceId, generation: source.generation }));

    let stopRun = false;
    for (const step of steps) {
      // After a stop, never-dispatched `pending` steps are left honestly
      // pending (the store forbids settling a step that never ran); the run
      // status plus an explicit gap carry the honest partial-work story.
      if (stopRun) continue;
      assertAlive(execution);
      if (wallClockExceeded(run)) {
        state.wallClockExceeded = true;
        continue;
      }
      if (step.status !== "pending") continue;
      let dispatched: StoredResearchStep;
      try {
        dispatched = await store.markResearchStepRunning(accountId, run.id, step.ordinal);
      } catch (error) {
        if (error instanceof ResearchRunStateError) throw abortError();
        throw error;
      }
      if (dispatched.status !== "running") continue;
      execution.currentStepOrdinal = step.ordinal;
      const result = await executeStep(execution, run, dispatched, revision.question, scopes, dossier, state);
      execution.currentStepOrdinal = null;
      if (result.stopRun) stopRun = true;
    }

    // Synthesis phase. Evidence capture (above) has durably completed for
    // every executed step before this point — the provider call log proves
    // evidence-before-synthesis ordering.
    assertAlive(execution);
    if (!state.wallClockExceeded) {
      if (revision.outputKind === "memo") {
        await synthesizeMemo(execution, run, revision, dossier, state);
      } else {
        await synthesizeComparison(execution, run, revision, dossier, state);
      }
    }

    // Explicit gap rows keep every honest stop reason reviewable on the run.
    const gaps: string[] = [];
    if (state.searchesExhausted) gaps.push("search budget exhausted: remaining planned searches were not run");
    if (state.modelBudgetExhausted) gaps.push("model request budget exhausted: summaries or synthesis are incomplete");
    if (state.evidenceCapReached) gaps.push("evidence capture cap reached: later matches were not captured");
    if (state.wallClockExceeded) gaps.push("wall-time budget exhausted: remaining steps and synthesis were not run");
    if (state.sourceChanged)
      gaps.push("a pinned source generation changed mid-run; the affected step stopped and later steps were skipped");
    if (state.tableLimitReached) gaps.push("comparison table limit reached: later cells were not written");
    if (state.synthesisRejected)
      gaps.push("synthesis output was not fully supported or usable: review the retained claims and cells");
    if (state.zeroEvidence)
      gaps.push("not found in selected evidence: the planned searches captured no passages in the pinned scope");
    for (const gap of gaps) {
      try {
        await store.addResearchClaim(accountId, run.id, { kind: "gap", text: gap });
      } catch (error) {
        if (error instanceof ResearchClaimCapError) break;
        if (error instanceof ResearchRunStateError || error instanceof ResearchRunNotFoundError) break;
        throw error;
      }
    }

    const finished = await store.listResearchSteps(accountId, run.id);
    const allStepsDone = finished.every((item) => item.status === "done");
    const clean =
      allStepsDone &&
      !state.searchesExhausted &&
      !state.modelBudgetExhausted &&
      !state.evidenceCapReached &&
      !state.wallClockExceeded &&
      !state.sourceChanged &&
      !state.tableLimitReached &&
      !state.synthesisRejected &&
      !state.zeroEvidence;
    const errorCode = clean
      ? undefined
      : state.sourceChanged
        ? CODE_SOURCE_CHANGED
        : state.searchesExhausted ||
            state.modelBudgetExhausted ||
            state.evidenceCapReached ||
            state.wallClockExceeded ||
            state.tableLimitReached
          ? CODE_BUDGET
          : CODE_OUTPUT;
    await store.finishResearchRun(accountId, run.id, clean ? "completed" : "needs_review", errorCode);
  }

  async function finalizeFailure(execution: ActiveExecution, error: unknown): Promise<void> {
    const { accountId, runId } = execution;
    try {
      if (error instanceof OwnershipLost) return; // Definition/run vanished; cascade owns the rows.
      if (error instanceof RemoteEgressConsentRequiredError) {
        await settleCurrentStep(execution, "failed", "the provider consent requirement was revoked");
        await store.finishResearchRun(accountId, runId, "failed", FAILURE_CONSENT).catch(() => undefined);
        return;
      }
      if (error instanceof ModelUnavailable) {
        await settleCurrentStep(execution, "failed", "the captured chat model is not available on the provider");
        await store.finishResearchRun(accountId, runId, "failed", FAILURE_MODEL).catch(() => undefined);
        return;
      }
      // The cancellation/shutdown signal is checked BEFORE provider-failure
      // classification: interrupting an in-flight transport surfaces as the
      // provider SDK's abort error (not a plain AbortError), yet the durable
      // intent is cancellation. A shutdown interrupt leaves the durable
      // running row for the bounded startup resume (never a silent rerun); an
      // observed cancellation is settled now and the store's cancel-wins rule
      // finalizes `cancelled`.
      if (execution.controller.signal.aborted) {
        if (execution.shutdownAborted || execution.ownershipLost) return;
        await settleCurrentStep(execution, "skipped", "cancelled mid-step");
        await store.finishResearchRun(accountId, runId, "needs_review").catch(() => undefined);
        return;
      }
      if (error instanceof ProviderFailure) {
        await settleCurrentStep(execution, "failed", "the model provider call failed");
        await store.finishResearchRun(accountId, runId, "failed", FAILURE_PROVIDER).catch(() => undefined);
        return;
      }
      if (error instanceof ResearchRunStateError || error instanceof ResearchRunNotFoundError) return;
      await settleCurrentStep(execution, "failed", "the research run could not complete");
      await store.finishResearchRun(accountId, runId, "failed", FAILURE_PROVIDER).catch(() => undefined);
    } catch {
      // The durable row is owned by the next startup recovery.
    }
  }

  async function settleCurrentStep(execution: ActiveExecution, status: "failed" | "skipped", outcome: string) {
    if (execution.currentStepOrdinal === null) return;
    await settleStep(execution.accountId, execution.runId, execution.currentStepOrdinal, status, outcome).catch(
      () => undefined
    );
  }

  // -- Claim loop -----------------------------------------------------------------------

  async function executeClaimed(run: StoredResearchRun): Promise<void> {
    if (quiescing || active.has(run.accountId)) return;
    // The account slot is reserved synchronously so the claim loop and a
    // route dispatch can never enter the same account twice across an await.
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const execution: ActiveExecution = {
      runId: run.id,
      accountId: run.accountId,
      controller: new AbortController(),
      done,
      settle,
      shutdownAborted: false,
      cancelObserved: false,
      ownershipLost: false,
      currentStepOrdinal: null,
    };
    active.set(run.accountId, execution);
    registerCancelObserver(execution);
    try {
      let live: StoredResearchRun;
      try {
        live = await store.markResearchRunRunning(run.accountId, run.id);
      } catch {
        return;
      }
      if (live.status === "cancelling") {
        await store.finishResearchRun(run.accountId, run.id, "needs_review").catch(() => undefined);
        return;
      }
      if (live.status !== "running") return; // A durable cancellation won.
      try {
        await runPipeline(execution, live);
      } catch (error) {
        await finalizeFailure(execution, error);
      }
    } finally {
      if (execution.cancelTimer) clearInterval(execution.cancelTimer);
      if (active.get(run.accountId) === execution) active.delete(run.accountId);
      execution.settle();
    }
  }

  async function claimQueued(): Promise<void> {
    if (quiescing) return;
    let claims: readonly StoredResearchRun[];
    try {
      claims = await store.listResumableResearchRuns(claimBatchLimit);
    } catch {
      return;
    }
    for (const claim of claims) {
      if (quiescing) return; // The durable row survives for the next resume.
      if (active.has(claim.accountId)) continue; // One executing run per account.
      await executeClaimed(claim);
    }
  }

  /** Startup resume: recover interrupted rows, then claim resumable ones. */
  function start(): void {
    if (quiescing) return;
    if (activeBootstrap) return;
    const handle: { done: Promise<void> } = { done: Promise.resolve() };
    activeBootstrap = handle;
    handle.done = (async () => {
      try {
        await store.recoverInterruptedResearchRuns();
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
   * Synchronous quiescence: no claim or dispatch continues and active model
   * transports are interrupted before the first await. The returned promise
   * settles only after every execution has stopped; interrupted runs stay
   * durable `running` for the bounded at-most-once startup resume.
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

  /** Fire-and-forget dispatch of a freshly accepted queued run. */
  function dispatch(run: StoredResearchRun): void {
    if (quiescing || active.has(run.accountId)) return; // The claim loop resumes the durable row.
    void executeClaimed(run).catch(() => undefined);
  }

  return {
    start,
    stop,
    dispatch,
    isRunning: () => !quiescing && (claimTimer !== undefined || activeBootstrap !== undefined || active.size > 0),
    activeRunCount: () => active.size,
  };
}

export type ResearchRunner = ReturnType<typeof createResearchRunner>;

/**
 * The composition-owned default runner. `applicationRuntime` binds the single
 * executor at startup and clears it when its ownership is released. Routes
 * dispatch through it when live; the durable `queued` row is the contract, so
 * a missing executor only defers execution to the next resume.
 */
let defaultRunner: ResearchRunner | undefined;

export function bindDefaultResearchRunner(runner: ResearchRunner | undefined): void {
  defaultRunner = runner;
}

export function defaultResearchRunner(): ResearchRunner | undefined {
  return defaultRunner;
}
