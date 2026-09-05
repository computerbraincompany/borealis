import { performance } from "node:perf_hooks";
import OpenAI from "openai";
import { appLog } from "./appLogger.js";
import { normalizeEmbeddingVectorValues } from "./embeddingVector.js";
import { publicLlmModelId, resolveLlmModelId, sameLlmModel } from "./llmAliases.js";
import { DEFAULT_LLM_SETTINGS, type EffectiveLlmSettings } from "./settingsStore.js";
import { getRuntimeSettings } from "./runtimeSettings.js";
import { isValidToolCallId, MAX_TOOL_CALL_ID_CHARS } from "./toolCallContract.js";

interface LlmRuntimeBundle {
  readonly revision: number;
  readonly settings: EffectiveLlmSettings;
  readonly client: OpenAI;
  readonly discover: ReturnType<typeof createChatModelDiscovery>;
}

let cachedRuntime: LlmRuntimeBundle | undefined;

/** Resolve the revision-scoped SDK client for tests and specialized callers. */
export async function getLlmClient(): Promise<OpenAI> {
  return (await getLlmRuntime()).client;
}

export interface ChatModelOption {
  id: string;
  owned_by?: string;
}

export interface ChatModelDiscovery {
  models: ChatModelOption[];
  discovery: "live" | "unavailable";
}

const MODEL_DISCOVERY_TTL_MS = 15_000;

/** Normalize only the identity fields standardized by OpenAI-compatible catalogs. */
export function normalizeChatModels(input: unknown, configuredEmbeddingModel: string): ChatModelOption[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as { data?: unknown }).data)) return [];

  const models = new Map<string, ChatModelOption>();
  for (const candidate of (input as { data: unknown[] }).data) {
    if (!candidate || typeof candidate !== "object") continue;
    const rawId = (candidate as { id?: unknown }).id;
    if (typeof rawId !== "string") continue;
    const providerId = rawId.trim();
    if (!providerId || providerId.length > 256 || sameLlmModel(providerId, configuredEmbeddingModel)) continue;
    const id = publicLlmModelId(providerId);
    if (!id || id.length > 256 || models.has(id)) continue;

    const model: ChatModelOption = { id };
    const rawOwner = (candidate as { owned_by?: unknown }).owned_by;
    if (typeof rawOwner === "string") {
      const ownedBy = rawOwner.trim().slice(0, 256);
      if (ownedBy) model.owned_by = ownedBy;
    }
    models.set(id, model);
  }

  return [...models.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

interface ChatModelDiscoveryDependencies {
  listModels: () => Promise<unknown>;
  configuredEmbeddingModel?: string;
  now?: () => number;
  warn?: (message: string) => void;
}

/** Build a discovery helper with an isolated cache, which also keeps it deterministic in tests. */
export function createChatModelDiscovery(deps: ChatModelDiscoveryDependencies) {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? console.warn;
  const configuredEmbeddingModel = deps.configuredEmbeddingModel ?? DEFAULT_LLM_SETTINGS.embedModel;
  let cached: { result: ChatModelDiscovery; storedAt: number } | undefined;
  let inFlight: Promise<ChatModelDiscovery> | undefined;

  return async (options: { refresh?: boolean } = {}): Promise<ChatModelDiscovery> => {
    if (inFlight) return inFlight;
    if (!options.refresh && cached && now() - cached.storedAt < MODEL_DISCOVERY_TTL_MS) {
      return cached.result;
    }

    const request = (async (): Promise<ChatModelDiscovery> => {
      try {
        const page = await deps.listModels();
        const result: ChatModelDiscovery = {
          models: normalizeChatModels(page, configuredEmbeddingModel),
          discovery: "live",
        };
        cached = { result, storedAt: now() };
        return result;
      } catch {
        warn("model discovery unavailable");
        return { models: [], discovery: "unavailable" };
      }
    })();

    inFlight = request;
    try {
      return await request;
    } finally {
      if (inFlight === request) inFlight = undefined;
    }
  };
}

export async function discoverChatModels(options: { refresh?: boolean } = {}): Promise<ChatModelDiscovery> {
  return (await getLlmRuntime()).discover(options);
}

export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const runtime = await getLlmRuntime();
  return embedWithClient(runtime.client, runtime.settings.embedModel, texts, signal);
}

/** Build an operation-scoped embedder for a qualified migration target. */
export function createEmbeddingExecutor(
  settings: EffectiveLlmSettings,
  embedModel = settings.embedModel
): (texts: string[], signal?: AbortSignal) => Promise<number[][]> {
  const client = createOpenAiClient(settings);
  const model = resolveLlmModelId(embedModel);
  return (texts, signal) => embedWithClient(client, model, texts, signal, true);
}

async function embedWithClient(
  client: OpenAI,
  embedModel: string,
  texts: string[],
  signal?: AbortSignal,
  modelAlreadyResolved = false
): Promise<number[][]> {
  const out: number[][] = [];
  // batch to keep local inference snappy
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    // encode as "float": openai-node defaults to base64 and blindly decodes the
    // response, which corrupts embeddings when an OpenAI-compatible runtime
    // returns plain floats instead of base64 (768 floats -> 192).
    const res = await client.embeddings.create(
      {
        model: modelAlreadyResolved ? embedModel : resolveLlmModelId(embedModel),
        input: batch,
        encoding_format: "float",
      },
      { timeout: 60_000, maxRetries: 0, ...(signal ? { signal } : {}) }
    );
    out.push(...res.data.map((d) => d.embedding as number[]));
  }
  return out;
}

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  tools?: any;
  signal?: AbortSignal;
}

export interface StreamingChatOptions extends Omit<ChatOptions, "json"> {
  onReasoning?: (text: string) => void;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const MAX_STREAM_CONTENT_CHARS = 32_000;
const MAX_STREAM_REASONING_CHARS = 32_000;
const MAX_STREAM_TOOL_CALLS = 8;
const MAX_STREAM_TOOL_NAME_CHARS = 100;
const MAX_STREAM_TOOL_ARGUMENT_CHARS = 20_000;
const MAX_STREAM_TOTAL_TOOL_ARGUMENT_CHARS = 80_000;
const DEFAULT_QUALIFICATION_TIMEOUT_MS = 15_000;
const MAX_QUALIFICATION_TIMEOUT_MS = 30_000;
const MAX_QUALIFICATION_CHAT_RESPONSE_BYTES = 64 * 1024;
const MAX_QUALIFICATION_EMBED_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_QUALIFICATION_TOOL_ARGUMENT_CHARS = 256;
const MAX_QUALIFICATION_DIMENSION = 16_384;
const QUALIFICATION_TOOL_NAME = "borealis_qualify";
const QUALIFICATION_PROMPT = "Call the provided qualification function exactly once with ok set to true.";
const QUALIFICATION_EMBED_INPUT = "Borealis embedding qualification probe.";

interface StreamToolCallLimits {
  readonly calls: number;
  readonly idChars: number;
  readonly nameChars: number;
  readonly argumentChars: number;
  readonly totalArgumentChars: number;
}

const LIVE_STREAM_TOOL_LIMITS: StreamToolCallLimits = Object.freeze({
  calls: MAX_STREAM_TOOL_CALLS,
  idChars: MAX_TOOL_CALL_ID_CHARS,
  nameChars: MAX_STREAM_TOOL_NAME_CHARS,
  argumentChars: MAX_STREAM_TOOL_ARGUMENT_CHARS,
  totalArgumentChars: MAX_STREAM_TOTAL_TOOL_ARGUMENT_CHARS,
});

const QUALIFICATION_STREAM_TOOL_LIMITS: StreamToolCallLimits = Object.freeze({
  calls: 1,
  idChars: MAX_TOOL_CALL_ID_CHARS,
  nameChars: MAX_STREAM_TOOL_NAME_CHARS,
  argumentChars: MAX_QUALIFICATION_TOOL_ARGUMENT_CHARS,
  totalArgumentChars: MAX_QUALIFICATION_TOOL_ARGUMENT_CHARS,
});

export type ChatQualificationReason = "qualified" | "unreachable" | "tool-call-missing" | "tool-call-invalid";
export type EmbeddingQualificationReason = "qualified" | "unreachable" | "embedding-invalid" | "dimension-mismatch";

export interface ModelPairQualificationResult {
  readonly chat: {
    readonly qualified: boolean;
    readonly reason_code: ChatQualificationReason;
    readonly latency_ms: number;
  };
  readonly embedding: {
    readonly qualified: boolean;
    readonly reason_code: EmbeddingQualificationReason;
    readonly dimension: number | null;
    readonly latency_ms: number;
  };
}

export type ModelQualificationFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ModelQualificationDependencies {
  readonly fetch?: ModelQualificationFetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Exercise only Borealis' fixed synthetic tool and embedding contracts. Draft
 * settings and all provider payloads remain operation-local and are never
 * returned, persisted, or logged.
 */
export async function qualifyModelPair(
  settings: EffectiveLlmSettings,
  expectedDimension: number,
  dependencies: ModelQualificationDependencies = {}
): Promise<ModelPairQualificationResult> {
  if (
    !Number.isSafeInteger(expectedDimension) ||
    expectedDimension < 1 ||
    expectedDimension > MAX_QUALIFICATION_DIMENSION
  ) {
    throw new RangeError("expected embedding dimension is invalid");
  }
  const fetchImpl = dependencies.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = normalizeQualificationTimeout(dependencies.timeoutMs);
  const now = dependencies.now ?? (() => performance.now());
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const [chat, embedding] = await Promise.all([
    qualifyChatRole(settings, headers, fetchImpl, timeoutMs, now),
    qualifyEmbeddingRole(settings, expectedDimension, headers, fetchImpl, timeoutMs, now),
  ]);
  return Object.freeze({ chat: Object.freeze(chat), embedding: Object.freeze(embedding) });
}

async function qualifyChatRole(
  settings: EffectiveLlmSettings,
  headers: Readonly<Record<string, string>>,
  fetchImpl: ModelQualificationFetch,
  timeoutMs: number,
  now: () => number
): Promise<ModelPairQualificationResult["chat"]> {
  const outcome = await postQualificationSse(
    `${settings.llmBaseUrl}/v1/chat/completions`,
    headers,
    {
      model: resolveLlmModelId(settings.chatModel),
      messages: [{ role: "user", content: QUALIFICATION_PROMPT }],
      max_tokens: 128,
      temperature: 0,
      tools: [
        {
          type: "function",
          function: {
            name: QUALIFICATION_TOOL_NAME,
            description: "Return the fixed synthetic qualification result.",
            parameters: {
              type: "object",
              additionalProperties: false,
              required: ["ok"],
              properties: { ok: { type: "boolean", const: true } },
            },
          },
        },
      ],
      tool_choice: "required",
      stream: true,
    },
    MAX_QUALIFICATION_CHAT_RESPONSE_BYTES,
    fetchImpl,
    timeoutMs,
    now
  );
  if (!outcome.reachable) {
    return { qualified: false, reason_code: "unreachable", latency_ms: outcome.latencyMs };
  }

  if (!Array.isArray(outcome.payload)) {
    return { qualified: false, reason_code: "tool-call-invalid", latency_ms: outcome.latencyMs };
  }
  let toolCalls: unknown[];
  try {
    const accumulator = createStreamToolCallAccumulator(QUALIFICATION_STREAM_TOOL_LIMITS, () => {
      throw new Error("qualification stream is invalid");
    });
    let sawDelta = false;
    for (const event of outcome.payload) {
      const record = asRecord(event);
      const choices = record && Array.isArray(record.choices) ? record.choices : undefined;
      const choice = choices?.length === 1 ? asRecord(choices[0]) : undefined;
      const delta = choice && asRecord(choice.delta);
      if (!delta) throw new Error("qualification stream is invalid");
      sawDelta = true;
      accumulator.push(delta.tool_calls);
    }
    if (!sawDelta) throw new Error("qualification stream is invalid");
    toolCalls = accumulator.finish();
  } catch {
    return { qualified: false, reason_code: "tool-call-invalid", latency_ms: outcome.latencyMs };
  }
  if (toolCalls.length === 0) {
    return { qualified: false, reason_code: "tool-call-missing", latency_ms: outcome.latencyMs };
  }
  if (toolCalls.length !== 1 || !validQualificationToolCall(toolCalls[0])) {
    return { qualified: false, reason_code: "tool-call-invalid", latency_ms: outcome.latencyMs };
  }
  return { qualified: true, reason_code: "qualified", latency_ms: outcome.latencyMs };
}

async function qualifyEmbeddingRole(
  settings: EffectiveLlmSettings,
  expectedDimension: number,
  headers: Readonly<Record<string, string>>,
  fetchImpl: ModelQualificationFetch,
  timeoutMs: number,
  now: () => number
): Promise<ModelPairQualificationResult["embedding"]> {
  const outcome = await postQualificationJson(
    `${settings.llmBaseUrl}/v1/embeddings`,
    headers,
    {
      model: resolveLlmModelId(settings.embedModel),
      input: [QUALIFICATION_EMBED_INPUT],
      encoding_format: "float",
    },
    MAX_QUALIFICATION_EMBED_RESPONSE_BYTES,
    fetchImpl,
    timeoutMs,
    now
  );
  if (!outcome.reachable) {
    return {
      qualified: false,
      reason_code: "unreachable",
      dimension: null,
      latency_ms: outcome.latencyMs,
    };
  }

  const payload = asRecord(outcome.payload);
  const data = payload && Array.isArray(payload.data) ? payload.data : undefined;
  const item = data?.length === 1 ? asRecord(data[0]) : undefined;
  const vector = item && Array.isArray(item.embedding) ? item.embedding : undefined;
  const dimension = vector?.length ?? null;
  try {
    normalizeEmbeddingVectorValues(vector);
  } catch {
    return {
      qualified: false,
      reason_code: "embedding-invalid",
      dimension,
      latency_ms: outcome.latencyMs,
    };
  }
  if (dimension !== expectedDimension) {
    return {
      qualified: false,
      reason_code: "dimension-mismatch",
      dimension,
      latency_ms: outcome.latencyMs,
    };
  }
  return { qualified: true, reason_code: "qualified", dimension, latency_ms: outcome.latencyMs };
}

interface QualificationHttpOutcome {
  readonly reachable: boolean;
  readonly payload?: unknown;
  readonly latencyMs: number;
}

async function postQualificationSse(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  maxResponseBytes: number,
  fetchImpl: ModelQualificationFetch,
  timeoutMs: number,
  now: () => number
): Promise<QualificationHttpOutcome> {
  return postQualificationResponse(url, headers, body, maxResponseBytes, fetchImpl, timeoutMs, now, readBoundedSse);
}

async function postQualificationJson(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  maxResponseBytes: number,
  fetchImpl: ModelQualificationFetch,
  timeoutMs: number,
  now: () => number
): Promise<QualificationHttpOutcome> {
  return postQualificationResponse(url, headers, body, maxResponseBytes, fetchImpl, timeoutMs, now, readBoundedJson);
}

async function postQualificationResponse(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  maxResponseBytes: number,
  fetchImpl: ModelQualificationFetch,
  timeoutMs: number,
  now: () => number,
  decode: (response: Response, maximumBytes: number) => Promise<unknown>
): Promise<QualificationHttpOutcome> {
  const controller = new AbortController();
  const startedAt = now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("qualification deadline exceeded"));
    }, timeoutMs);
    timer.unref();
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: "POST",
        headers: { ...headers },
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      }),
      timeout,
    ]);
    if (!response.ok) {
      const cancellation = response.body?.cancel().catch(() => undefined);
      if (cancellation) await Promise.race([cancellation, timeout]);
      return { reachable: false, latencyMs: qualificationLatency(now() - startedAt, timeoutMs) };
    }
    const payload = await Promise.race([decode(response, maxResponseBytes), timeout]);
    return { reachable: true, payload, latencyMs: qualificationLatency(now() - startedAt, timeoutMs) };
  } catch {
    return { reachable: false, latencyMs: qualificationLatency(now() - startedAt, timeoutMs) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const body = await readBoundedBody(response, maximumBytes);
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

async function readBoundedSse(response: Response, maximumBytes: number): Promise<unknown> {
  const body = await readBoundedBody(response, maximumBytes);
  if (body === undefined) return undefined;
  const events: unknown[] = [];
  for (const block of body.replace(/\r\n?/g, "\n").split("\n\n")) {
    if (!block.trim()) continue;
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      return undefined;
    }
  }
  return events.length ? events : undefined;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string | undefined> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes
  ).toString("utf8");
}

function validQualificationToolCall(value: unknown): boolean {
  const call = asRecord(value);
  const fn = call && asRecord(call.function);
  if (!call || !isValidToolCallId(call.id) || call.type !== "function" || !fn || fn.name !== QUALIFICATION_TOOL_NAME) {
    return false;
  }
  if (
    typeof fn.arguments !== "string" ||
    fn.arguments.length < 1 ||
    fn.arguments.length > MAX_QUALIFICATION_TOOL_ARGUMENT_CHARS
  ) {
    return false;
  }
  try {
    const args = JSON.parse(fn.arguments);
    const record = asRecord(args);
    return Boolean(record && Object.keys(record).length === 1 && record.ok === true);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeQualificationTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_QUALIFICATION_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_QUALIFICATION_TIMEOUT_MS);
}

function qualificationLatency(value: number, timeoutMs: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(timeoutMs, Math.round(value)));
}

/** Merge the delta and cumulative function-name conventions used by compatible providers. */
export function mergeStreamedToolName(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming === current) return current;
  if (incoming.startsWith(current)) return incoming;
  return current + incoming;
}

function createStreamToolCallAccumulator(limits: StreamToolCallLimits, fail: () => never) {
  const calls = new Map<number, any>();
  let totalArgumentChars = 0;
  return {
    push(value: unknown): void {
      if (!Array.isArray(value)) return;
      for (const rawCall of value) {
        const call = asRecord(rawCall);
        if (!call) fail();
        const index = call.index ?? 0;
        if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= limits.calls) fail();
        if (call.type !== undefined && call.type !== "function") fail();
        if (call.id !== undefined && (typeof call.id !== "string" || call.id.length > limits.idChars)) fail();
        if (!calls.has(index as number)) {
          if (calls.size >= limits.calls) fail();
          calls.set(index as number, {
            id: typeof call.id === "string" ? call.id : "",
            type: "function",
            function: { name: "", arguments: "" },
          });
        }
        const accumulated = calls.get(index as number);
        if (typeof call.id === "string") accumulated.id = call.id;
        const fn = call.function === undefined ? undefined : asRecord(call.function);
        if (call.function !== undefined && !fn) fail();
        if (typeof fn?.name === "string" && fn.name) {
          const nextName = mergeStreamedToolName(accumulated.function.name, fn.name);
          if (nextName.length > limits.nameChars) fail();
          accumulated.function.name = nextName;
        }
        if (typeof fn?.arguments === "string" && fn.arguments) {
          const nextLength = accumulated.function.arguments.length + fn.arguments.length;
          totalArgumentChars += fn.arguments.length;
          if (nextLength > limits.argumentChars || totalArgumentChars > limits.totalArgumentChars) fail();
          accumulated.function.arguments += fn.arguments;
        }
      }
    },
    finish(): unknown[] {
      const ordered = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
      if (ordered.some((call) => !isValidToolCallId(call.id) || !call.function.name)) fail();
      return ordered;
    },
  };
}

function trailingTagPrefixLength(value: string, tag: string): number {
  const lower = value.toLowerCase();
  const lowerTag = tag.toLowerCase();
  const maxLength = Math.min(lower.length, lowerTag.length - 1);
  for (let length = maxLength; length > 0; length--) {
    if (lower.endsWith(lowerTag.slice(0, length))) return length;
  }
  return 0;
}

export function createThinkSplitter(onDelta: (text: string) => void, onReasoning?: (text: string) => void) {
  let buffer = "";
  let insideThink = false;

  const emit = (text: string) => {
    if (!text) return;
    if (insideThink) onReasoning?.(text);
    else onDelta(text);
  };

  const consume = () => {
    while (buffer) {
      const tag = insideThink ? THINK_CLOSE : THINK_OPEN;
      const tagIndex = buffer.toLowerCase().indexOf(tag);
      if (tagIndex >= 0) {
        emit(buffer.slice(0, tagIndex));
        buffer = buffer.slice(tagIndex + tag.length);
        insideThink = !insideThink;
        continue;
      }

      const heldLength = trailingTagPrefixLength(buffer, tag);
      emit(buffer.slice(0, buffer.length - heldLength));
      buffer = heldLength ? buffer.slice(-heldLength) : "";
      return;
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      consume();
    },
    flush() {
      emit(buffer);
      buffer = "";
    },
  };
}

export async function chatOnce(messages: ChatMessage[], opts: ChatOptions): Promise<OpenAI.Chat.ChatCompletion> {
  const client = (await getLlmRuntime()).client;
  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: resolveLlmModelId(opts.model),
    messages,
    max_tokens: opts.maxTokens ?? 1800,
    temperature: opts.temperature ?? 0.2,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  };
  return client.chat.completions.create(body, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    timeout: 120_000,
    maxRetries: 0,
  });
}

// One bounded retry for a transient provider stream failure (local engines
// such as llama.cpp/LM Studio can crash a stream mid-flight with a 500 while
// the very next request succeeds). Budget and caller-abort failures are never
// retried.
const TRANSIENT_STREAM_RETRY_LIMIT = 1;
const TRANSIENT_STREAM_RETRY_DELAY_MS = 1_000;

export function isTransientStreamFailure(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true; // includes timeouts
  if (error instanceof OpenAI.APIError) {
    if (typeof error.status === "number") return error.status >= 500;
    // Mid-stream error frames can arrive without a parsed status; only
    // engine/server_error wording is retryable. Aborts say "aborted".
    return /server_error|engine protocol|internal server error/i.test(String(error.message));
  }
  return false;
}

export async function streamingChat(
  messages: ChatMessage[],
  opts: StreamingChatOptions,
  onDelta: (text: string) => void
): Promise<OpenAI.Chat.ChatCompletion> {
  const client = (await getLlmRuntime()).client;
  const body = {
    model: resolveLlmModelId(opts.model),
    messages,
    max_tokens: opts.maxTokens ?? 2200,
    temperature: opts.temperature ?? 0.2,
    ...(opts.tools ? { tools: opts.tools } : {}),
    stream: true,
  } as const;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await streamOnce(client, body, opts, onDelta);
    } catch (error: unknown) {
      if (attempt >= TRANSIENT_STREAM_RETRY_LIMIT || opts.signal?.aborted || !isTransientStreamFailure(error)) {
        throw error;
      }
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), TRANSIENT_STREAM_RETRY_DELAY_MS);
        opts.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true }
        );
      });
      if (aborted) throw error;
    }
  }
}

async function streamOnce(
  client: OpenAI,
  body: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
  opts: StreamingChatOptions,
  onDelta: (text: string) => void
): Promise<OpenAI.Chat.ChatCompletion> {
  const streamController = new AbortController();
  const requestSignal = opts.signal ? AbortSignal.any([opts.signal, streamController.signal]) : streamController.signal;
  const stream = await client.chat.completions.create(body, {
    signal: requestSignal,
    timeout: 120_000,
    maxRetries: 0,
  });
  const merged: any = { id: "stream", choices: [{ message: { role: "assistant", content: "", tool_calls: [] } }] };
  let content = "";
  let reasoningChars = 0;
  const failBudget = (): never => {
    streamController.abort();
    throw new Error("model stream budget exceeded");
  };
  const toolCallAccumulator = createStreamToolCallAccumulator(LIVE_STREAM_TOOL_LIMITS, failBudget);
  const splitter = createThinkSplitter(
    (text) => {
      if (content.length + text.length > MAX_STREAM_CONTENT_CHARS) failBudget();
      content += text;
      onDelta(text);
    },
    (text) => {
      reasoningChars += text.length;
      if (reasoningChars > MAX_STREAM_REASONING_CHARS) failBudget();
      opts.onReasoning?.(text);
    }
  );
  for await (const chunk of stream) {
    const delta: any = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content) {
      splitter.push(delta.content);
    }
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
      reasoningChars += delta.reasoning_content.length;
      if (reasoningChars > MAX_STREAM_REASONING_CHARS) failBudget();
      opts.onReasoning?.(delta.reasoning_content);
    }
    toolCallAccumulator.push(delta?.tool_calls);
  }
  splitter.flush();
  merged.choices[0].message.content = content;
  const orderedToolCalls = toolCallAccumulator.finish();
  if (orderedToolCalls.length) merged.choices[0].message.tool_calls = orderedToolCalls;
  return merged;
}

async function getLlmRuntime(): Promise<LlmRuntimeBundle> {
  const snapshot = await getRuntimeSettings();
  if (cachedRuntime?.revision === snapshot.revision) return cachedRuntime;

  const client = createOpenAiClient(snapshot.settings);
  const runtime: LlmRuntimeBundle = {
    revision: snapshot.revision,
    settings: snapshot.settings,
    client,
    discover: createChatModelDiscovery({
      configuredEmbeddingModel: snapshot.settings.embedModel,
      listModels: () => client.models.list({ timeout: 5_000, maxRetries: 0 }),
      warn: () => appLog.warn({ error_code: "MODEL_DISCOVERY_UNAVAILABLE" }, "model discovery unavailable"),
    }),
  };
  cachedRuntime = runtime;
  return runtime;
}

function createOpenAiClient(settings: EffectiveLlmSettings): OpenAI {
  return new OpenAI({
    baseURL: `${settings.llmBaseUrl}/v1`,
    // openai-node requires an explicit string. Nulling its generated header
    // keeps genuinely keyless local runtimes keyless on the wire.
    apiKey: settings.apiKey ?? "borealis-keyless-local-runtime",
    ...(settings.apiKey ? {} : { defaultHeaders: { Authorization: null } }),
    timeout: 65_000,
    maxRetries: 0,
  });
}
