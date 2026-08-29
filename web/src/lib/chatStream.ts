import {
  parseCitationRefs,
  parseQueryResultArtifacts,
  type ChatRunTerminalStatus,
  type CitationRef,
  type QueryResultArtifact,
  type RetrievedEvidence,
} from "@/lib/api";

export interface ToolStep {
  key: number;
  name: string;
  summary: string | null;
  status: "running" | "done" | "error";
  resultSummary?: string;
}

export interface StreamState {
  running: boolean;
  stopping: boolean;
  runId: string | null;
  terminalStatus: ChatRunTerminalStatus | null;
  model: string | null;
  text: string;
  steps: ToolStep[];
  error: string | null;
  finalCharts: string[];
  finalReport: string | null;
  finalEvidence: RetrievedEvidence[];
  finalCitations: CitationRef[];
  finalQueryResults: QueryResultArtifact[];
}

export type StreamsByChat = Record<string, StreamState>;

export type StreamsAction =
  | { type: "replace"; chatId: string; state: StreamState }
  | { type: "patch"; chatId: string; patch: Partial<StreamState> }
  | { type: "append"; chatId: string; text: string }
  | { type: "event"; chatId: string; event: unknown; stepKey: number }
  | {
      type: "rehydrate";
      chatId: string;
      runId: string;
      status: "running" | "cancelling";
      model: string | null;
    }
  | { type: "select-chat"; chatId: string }
  | { type: "reconcile-no-active-run"; chatId: string }
  | { type: "clear"; chatId: string };

export function createStreamState(model: string | null = null): StreamState {
  return {
    running: false,
    stopping: false,
    runId: null,
    terminalStatus: null,
    model,
    text: "",
    steps: [],
    error: null,
    finalCharts: [],
    finalReport: null,
    finalEvidence: [],
    finalCitations: [],
    finalQueryResults: [],
  };
}

export const EMPTY_STREAM_STATE = createStreamState();

export function streamsByChatReducer(state: StreamsByChat, action: StreamsAction): StreamsByChat {
  if (action.type === "reconcile-no-active-run") {
    const stream = state[action.chatId];
    // Preserve explicit completed/failed/cancelled UX. This reconciliation is
    // only for a locally stranded running state after navigation prevented the
    // original SSE cleanup from reading authoritative detail.
    if (!stream?.running) return state;
    const next = { ...state };
    delete next[action.chatId];
    return next;
  }

  if (action.type === "select-chat") {
    let next = state;
    for (const [chatId, stream] of Object.entries(state)) {
      const shouldClear = chatId === action.chatId ? !stream.running && !stream.error : Boolean(stream.error);
      if (!shouldClear) continue;
      if (next === state) next = { ...state };
      if (chatId === action.chatId) delete next[chatId];
      else next[chatId] = { ...stream, error: null };
    }
    return next;
  }

  if (action.type === "clear") {
    if (!(action.chatId in state)) return state;
    const next = { ...state };
    delete next[action.chatId];
    return next;
  }

  const previous = state[action.chatId] ?? createStreamState();
  let nextState: StreamState;
  if (action.type === "replace") nextState = action.state;
  else if (action.type === "rehydrate") {
    const base = previous.runId === action.runId ? previous : createStreamState(action.model);
    nextState = {
      ...base,
      running: true,
      stopping: action.status === "cancelling",
      runId: action.runId,
      terminalStatus: null,
      error: null,
    };
  } else if (action.type === "patch") nextState = { ...previous, ...action.patch };
  else if (action.type === "append")
    nextState = action.text ? { ...previous, text: previous.text + action.text } : previous;
  else nextState = applyAgentEvent(previous, action.event, action.stepKey);

  return nextState === previous ? state : { ...state, [action.chatId]: nextState };
}

export function applyAgentEvent(state: StreamState, event: unknown, stepKey: number): StreamState {
  if (!event || typeof event !== "object" || Array.isArray(event)) return state;
  const value = event as Record<string, any>;
  const type = typeof value.type === "string" ? value.type : "";

  if (type === "run-started") {
    const runId = safeIdentifier(value.run_id) ?? safeIdentifier(value.id);
    return runId ? { ...state, running: true, runId, terminalStatus: null } : state;
  }

  if (type === "run-ended") {
    const runId = safeIdentifier(value.run_id) ?? safeIdentifier(value.id);
    const status = safeTerminalStatus(value.status);
    if (!runId || !status || (state.runId && state.runId !== runId)) return state;
    return {
      ...state,
      running: false,
      stopping: false,
      runId,
      terminalStatus: status,
      error: status === "failed" ? state.error || "Generation failed" : null,
    };
  }

  if (type === "step-start") {
    const name = safeIdentifier(value.name) ?? "tool";
    return {
      ...state,
      steps: [
        ...state.steps,
        {
          key: stepKey,
          name,
          // Never derive a UI string from legacy args. Only a server-produced,
          // redacted summary is eligible for display.
          summary: safeSummary(value.summary),
          status: "running",
        },
      ],
    };
  }

  if (type === "step-end") {
    const name = safeIdentifier(value.name) ?? "tool";
    let index = -1;
    for (let candidate = state.steps.length - 1; candidate >= 0; candidate -= 1) {
      const step = state.steps[candidate];
      if (step.name === name && step.status === "running") {
        index = candidate;
        break;
      }
    }
    if (index < 0) return state;
    const result = value.result && typeof value.result === "object" ? value.result : null;
    const failed =
      value.ok === false ||
      value.status === "error" ||
      Boolean(value.error) ||
      Boolean(result && Object.prototype.hasOwnProperty.call(result, "error"));
    const resultSummary = safeSummary(value.summary) ?? safeSummary(value.error_summary) ?? undefined;
    const steps = [...state.steps];
    steps[index] = { ...steps[index], status: failed ? "error" : "done", resultSummary };
    return { ...state, steps };
  }

  if (type === "delta" && typeof value.text === "string") return { ...state, text: state.text + value.text };

  // Legacy reasoning events are deliberately ignored. Raw model internals are
  // neither rendered nor retained in client state.
  if (type === "reasoning") return state;

  if (type === "message") {
    const meta = value.meta && typeof value.meta === "object" ? value.meta : {};
    return {
      ...state,
      model: safeIdentifier(meta.model) ?? state.model,
      finalCharts: safeIdentifiers(meta.charts),
      finalReport: safeIdentifier(meta.report),
      finalEvidence: Array.isArray(meta.evidence) ? meta.evidence : [],
      finalCitations: parseCitationRefs(meta.citations),
      finalQueryResults: parseQueryResultArtifacts(meta.query_results),
    };
  }

  if (type === "error") return { ...state, error: safeSummary(value.message, 500) ?? "Generation failed" };
  return state;
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : null;
}

function safeIdentifiers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const safe = safeIdentifier(item);
    return safe ? [safe] : [];
  });
}

function safeSummary(value: unknown, limit = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, limit) : null;
}

function safeTerminalStatus(value: unknown): ChatRunTerminalStatus | null {
  return value === "cancelled" || value === "completed" || value === "failed" ? value : null;
}
