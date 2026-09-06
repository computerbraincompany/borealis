/**
 * Bounded research-plan proposal generation (M15 stage 2).
 *
 * `POST /api/research/:id/plan` performs ONE bounded model call through the
 * account-authorized runtime (consent gate plus content-free egress audit, no
 * reasoning exposure) and returns an editable plan PROPOSAL. It never starts
 * execution and never writes a run row: the proposal becomes durable only when
 * the user saves it through `PATCH /api/research/:id` with revision CAS.
 *
 * A provider failure, timeout, or unusable output is not fatal: the caller
 * always receives the deterministic four-step fallback plan (find relevant
 * evidence → compare claims → identify gaps and conflicts → synthesize output)
 * with `fallback: true` and an explicit error code. The proposal shape is the
 * one owned by `researchSchemas.normalizeResearchPlan` (≤8 steps, ≤8 questions
 * per step, ≤32 total questions, serialized budget) so a saved proposal can
 * never promise work the run budgets cannot perform.
 */
import { randomUUID } from "node:crypto";

import { cleanFinal } from "./agent.js";
import { auditRemoteEgressTarget } from "./egressAudit.js";
import { RemoteEgressConsentRequiredError } from "./egressPolicy.js";
import type { RemoteEgressTarget } from "./egressPolicy.js";
import type { StoredResearchDefinition } from "./db/stores/researchStore.js";
import type { ChatMessage, StreamingChatOptions } from "./llm.js";
import { streamingChat } from "./llm.js";
import {
  RESEARCH_QUESTION_MAX_CHARS,
  RESEARCH_STEP_OBJECTIVE_MAX_CHARS,
  RESEARCH_STEP_QUESTION_MAX_CHARS,
  normalizeResearchPlan,
  type ResearchPlan,
} from "./researchSchemas.js";
import { storageRuntime } from "./storageRuntime.js";

export const RESEARCH_PLAN_MAX_OUTPUT_TOKENS = 1_200;
const PLAN_SOURCE_LABELS_MAX = 100;
const PLAN_SOURCE_LABEL_CHARS = 80;
const PLAN_QUESTION_CLIP = RESEARCH_STEP_QUESTION_MAX_CHARS - 16;

/** Stable generic plan-failure codes; never derived from provider bodies. */
export const RESEARCH_PLAN_PROVIDER_FAILED = "RESEARCH_PLAN_PROVIDER_FAILED";
export const RESEARCH_PLAN_OUTPUT_REJECTED = "RESEARCH_PLAN_OUTPUT_REJECTED";

export type ResearchChatTransport = (
  messages: ChatMessage[],
  opts: StreamingChatOptions,
  onDelta: (text: string) => void
) => Promise<{ choices?: { message?: { content?: string | null } }[] }>;

export interface ResearchPlanProposal {
  readonly plan: ResearchPlan;
  /** True when the returned plan is the deterministic fallback. */
  readonly fallback: boolean;
  /** True when the definition's chat model actually produced the proposal. */
  readonly modelUsed: boolean;
  readonly model: string;
  readonly errorCode: string | null;
}

export interface ResearchPlannerPorts {
  readonly chat?: ResearchChatTransport;
  /** Source display labels for the prompt; defaults to the owned source rows. */
  readonly sourceLabels?: (accountId: string, sourceIds: readonly string[]) => Promise<readonly string[]>;
}

/**
 * The deterministic fallback plan from the specification: find relevant
 * evidence, compare claims, identify gaps and conflicts, synthesize output.
 * Every search question is derived from the question text so the plan stays
 * answerable against the pinned scope without inventing subject matter.
 */
export function defaultResearchPlan(question: string): ResearchPlan {
  const q = question.trim().slice(0, PLAN_QUESTION_CLIP) || "the research question";
  const topic = q.length > 120 ? `${q.slice(0, 119)}…` : q;
  return normalizeResearchPlan({
    steps: [
      {
        id: randomUUID(),
        objective: `Find the evidence that directly answers ${topic}`,
        questions: [q, `key facts about ${topic}`],
      },
      {
        id: randomUUID(),
        objective: "Compare the claims and figures the sources make about the question",
        questions: [`${topic} comparison`, "differences and contradictions between sources"],
      },
      {
        id: randomUUID(),
        objective: "Identify gaps, conflicts, and missing information",
        questions: [`missing information about ${topic}`, "conflicts between sources"],
      },
      {
        id: randomUUID(),
        objective: "Synthesize the reviewed answer from the captured evidence",
        questions: [`summary and conclusion for ${topic}`],
      },
    ],
  });
}

/**
 * Parse a model answer into one JSON object. Streaming chat is not JSON-mode,
 * so the answer is cleaned (reasoning/think markers and "Final Answer:"
 * labels stripped by `cleanFinal`), fenced code blocks are unwrapped, and the
 * first `{...}` object literal is taken. Anything that is not a JSON object
 * yields null — never a guess.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  let text = cleanFinal(raw);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fallthrough
    }
  }
  return null;
}

/**
 * Repair a loose proposal into the normalized plan shape: malformed steps are
 * dropped, per-step question lists are cleaned and clipped, the whole plan is
 * capped to the run search budget, and step ids are assigned here. Returns
 * null when nothing salvageable remains so the caller falls back honestly.
 */
export function salvagePlanProposal(value: unknown): ResearchPlan | null {
  const stepsValue =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).steps : null;
  if (!Array.isArray(stepsValue)) return null;
  let remainingQuestions = 32;
  const steps: Record<string, unknown>[] = [];
  for (const entry of stepsValue.slice(0, 8)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const objective = typeof record.objective === "string" ? record.objective.trim() : "";
    if (!objective || objective.includes("\0")) continue;
    const questions = (Array.isArray(record.questions) ? record.questions : [])
      .filter(
        (question): question is string => typeof question === "string" && !!question.trim() && !question.includes("\0")
      )
      .map((question) => question.trim().slice(0, RESEARCH_STEP_QUESTION_MAX_CHARS))
      .slice(0, Math.min(8, remainingQuestions));
    if (!questions.length) continue;
    remainingQuestions -= questions.length;
    steps.push({ id: randomUUID(), objective: objective.slice(0, RESEARCH_STEP_OBJECTIVE_MAX_CHARS), questions });
    if (remainingQuestions <= 0) break;
  }
  if (!steps.length) return null;
  try {
    return normalizeResearchPlan({ steps });
  } catch {
    return null;
  }
}

function planSystemPrompt(): string {
  return [
    "You are the research planner of the Borealis local research workspace.",
    'Return a step-by-step evidence-gathering plan as a single JSON object: {"steps":[{"objective":"...","questions":["..."]}]}',
    "Rules:",
    "- At most 8 ordered steps. Each step has one user-facing objective string and 1-8 short keyword search questions.",
    "- At most 32 search questions in total across the plan.",
    "- Questions must be answerable by keyword or semantic search over the user's selected local documents.",
    "- Never invent sources, facts, or numbers. Objectives describe what the step must establish.",
    "- Output JSON only, with no prose and no markdown.",
  ].join("\n");
}

async function defaultSourceLabels(accountId: string, sourceIds: readonly string[]): Promise<readonly string[]> {
  if (!sourceIds.length) return [];
  const records = await storageRuntime()
    .sources.getSourcesByIds(accountId, sourceIds.slice(0, PLAN_SOURCE_LABELS_MAX))
    .catch(() => [] as { id: string; displayName: string; name: string }[]);
  const byId = new Map(records.map((record) => [record.id, record]));
  return sourceIds.slice(0, PLAN_SOURCE_LABELS_MAX).map((sourceId) => {
    const record = byId.get(sourceId);
    const label = record ? record.displayName || record.name : "document";
    return label.slice(0, PLAN_SOURCE_LABEL_CHARS);
  });
}

/**
 * Generate one plan proposal for the definition's pinned head revision. The
 * exact authorized `target` was already consent-checked by the route; this
 * function re-asserts nothing about consent (the transport itself is
 * authorized), it only records the content-free egress receipt after the
 * call. Provider failures degrade to the deterministic fallback plan; a lost
 * consent race re-throws so the route answers 403 with zero payload.
 */
export async function generateResearchPlanProposal(input: {
  accountId: string;
  definition: StoredResearchDefinition;
  target: RemoteEgressTarget;
  signal?: AbortSignal;
  ports?: ResearchPlannerPorts;
}): Promise<ResearchPlanProposal> {
  const { accountId, definition } = input;
  const revision = definition.revision;
  const model = revision.chatModel;
  const chat = input.ports?.chat ?? streamingChat;
  const sourceLabels = input.ports?.sourceLabels ?? defaultSourceLabels;

  let errorCode: string | null = null;
  let content = "";
  try {
    const labels = await sourceLabels(accountId, revision.sourceIds);
    const columnHint =
      revision.outputKind === "comparison" && revision.columns.length
        ? `\nComparison columns: ${revision.columns
            .map((column) => column.label)
            .slice(0, 20)
            .join(", ")}`
        : "";
    const completion = await chat(
      [
        { role: "system", content: planSystemPrompt() },
        {
          role: "user",
          content:
            `Research question: ${revision.question.slice(0, RESEARCH_QUESTION_MAX_CHARS)}\n` +
            `Output kind: ${revision.outputKind}${columnHint}\n` +
            `Selected sources (${revision.sourceIds.length}): ${labels.join(", ") || "(unlabeled)"}\n` +
            "Produce the plan JSON now.",
        },
      ],
      {
        accountId,
        model,
        maxTokens: RESEARCH_PLAN_MAX_OUTPUT_TOKENS,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      () => undefined
    );
    // Content-free egress receipt for the exact authorized target only.
    void auditRemoteEgressTarget("remote_turn", accountId, input.target);
    content = completion.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    if (error instanceof RemoteEgressConsentRequiredError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    errorCode = RESEARCH_PLAN_PROVIDER_FAILED;
  }

  if (!errorCode) {
    const parsed = parseJsonObject(content);
    const salvaged = parsed ? salvagePlanProposal(parsed) : null;
    if (salvaged) {
      return Object.freeze({ plan: salvaged, fallback: false, modelUsed: true, model, errorCode: null });
    }
    errorCode = RESEARCH_PLAN_OUTPUT_REJECTED;
  }
  return Object.freeze({
    plan: defaultResearchPlan(revision.question),
    fallback: true,
    modelUsed: false,
    model,
    errorCode,
  });
}
