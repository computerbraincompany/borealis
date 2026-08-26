import OpenAI from "openai";
import { appLog } from "./appLogger.js";
import { publicLlmModelId, resolveLlmModelId, sameLlmModel } from "./llmAliases.js";
import { DEFAULT_LLM_SETTINGS, type EffectiveLlmSettings } from "./settingsStore.js";
import { getRuntimeSettings } from "./runtimeSettings.js";

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
  const out: number[][] = [];
  // batch to keep local inference snappy
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    // encode as "float": openai-node defaults to base64 and blindly decodes the
    // response, which corrupts embeddings when an OpenAI-compatible runtime
    // returns plain floats instead of base64 (768 floats -> 192).
    const res = await runtime.client.embeddings.create(
      { model: resolveLlmModelId(runtime.settings.embedModel), input: batch, encoding_format: "float" },
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
  let totalToolArgumentChars = 0;
  const toolCalls = new Map<number, any>();
  const failBudget = (): never => {
    streamController.abort();
    throw new Error("model stream budget exceeded");
  };
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
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!Number.isSafeInteger(idx) || idx < 0 || idx >= MAX_STREAM_TOOL_CALLS) failBudget();
        if (tc.type !== undefined && tc.type !== "function") failBudget();
        if (typeof tc.id === "string" && tc.id.length > 256) failBudget();
        if (!toolCalls.has(idx)) {
          if (toolCalls.size >= MAX_STREAM_TOOL_CALLS) failBudget();
          toolCalls.set(idx, {
            id: typeof tc.id === "string" ? tc.id.slice(0, 256) : "",
            type: "function",
            function: { name: "", arguments: "" },
          });
        }
        const accumulated = toolCalls.get(idx);
        if (typeof tc.id === "string") accumulated.id = tc.id.slice(0, 256);
        if (typeof tc.function?.name === "string" && tc.function.name) {
          const currentName = accumulated.function.name;
          const nextName = !currentName
            ? tc.function.name
            : currentName.includes(tc.function.name)
              ? currentName
              : currentName + tc.function.name;
          if (nextName.length > MAX_STREAM_TOOL_NAME_CHARS) failBudget();
          accumulated.function.name = nextName;
        }
        if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
          const nextLength = accumulated.function.arguments.length + tc.function.arguments.length;
          totalToolArgumentChars += tc.function.arguments.length;
          if (
            nextLength > MAX_STREAM_TOOL_ARGUMENT_CHARS ||
            totalToolArgumentChars > MAX_STREAM_TOTAL_TOOL_ARGUMENT_CHARS
          ) {
            failBudget();
          }
          accumulated.function.arguments += tc.function.arguments;
        }
      }
    }
  }
  splitter.flush();
  merged.choices[0].message.content = content;
  if (toolCalls.size) {
    const orderedToolCalls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCall);
    if (orderedToolCalls.some((toolCall) => !toolCall.id || !toolCall.function.name)) failBudget();
    merged.choices[0].message.tool_calls = orderedToolCalls;
  }
  return merged;
}

async function getLlmRuntime(): Promise<LlmRuntimeBundle> {
  const snapshot = await getRuntimeSettings();
  if (cachedRuntime?.revision === snapshot.revision) return cachedRuntime;

  const client = new OpenAI({
    baseURL: `${snapshot.settings.llmBaseUrl}/v1`,
    // openai-node requires an explicit string. Nulling its generated header
    // keeps genuinely keyless local runtimes keyless on the wire.
    apiKey: snapshot.settings.apiKey ?? "borealis-keyless-local-runtime",
    ...(snapshot.settings.apiKey ? {} : { defaultHeaders: { Authorization: null } }),
    timeout: 65_000,
    maxRetries: 0,
  });
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
