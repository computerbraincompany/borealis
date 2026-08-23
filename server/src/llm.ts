import OpenAI from "openai";
import { config } from "./config.js";

export const client = new OpenAI({
  baseURL: `${config.llmBaseUrl}/v1`,
  apiKey: config.llmApiKey,
});

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
    const id = rawId.trim();
    if (!id || id.length > 256 || id === configuredEmbeddingModel || models.has(id)) continue;

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
  now?: () => number;
  warn?: (message: string) => void;
}

/** Build a discovery helper with an isolated cache, which also keeps it deterministic in tests. */
export function createChatModelDiscovery(deps: ChatModelDiscoveryDependencies) {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? console.warn;
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
          models: normalizeChatModels(page, config.embedModel),
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

const discoverWithClient = createChatModelDiscovery({
  listModels: () => client.models.list({ timeout: 5_000, maxRetries: 0 }),
});

export function discoverChatModels(options: { refresh?: boolean } = {}): Promise<ChatModelDiscovery> {
  return discoverWithClient(options);
}

export async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  // batch to keep local inference snappy
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    // encode as "float": openai-node defaults to base64 and blindly decodes the
    // response, which corrupts embeddings when the upstream (litellm/LM Studio)
    // returns plain floats instead of base64 (768 floats -> 192).
    const res = await client.embeddings.create({ model: config.embedModel, input: batch, encoding_format: "float" });
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
}

export interface StreamingChatOptions extends Omit<ChatOptions, "json"> {
  onReasoning?: (text: string) => void;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

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

export async function chatOnce(
  messages: ChatMessage[],
  opts: ChatOptions
): Promise<OpenAI.Chat.ChatCompletion> {
  return client.chat.completions.create({
    model: opts.model,
    messages,
    max_tokens: opts.maxTokens ?? 1800,
    temperature: opts.temperature ?? 0.2,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });
}

export async function streamingChat(
  messages: ChatMessage[],
  opts: StreamingChatOptions,
  onDelta: (text: string) => void
): Promise<OpenAI.Chat.ChatCompletion> {
  const stream = await client.chat.completions.create({
    model: opts.model,
    messages,
    max_tokens: opts.maxTokens ?? 2200,
    temperature: opts.temperature ?? 0.2,
    ...(opts.tools ? { tools: opts.tools } : {}),
    stream: true,
  });
  const merged: any = { id: "stream", choices: [{ message: { role: "assistant", content: "", tool_calls: [] } }] };
  let content = "";
  const toolCalls: any[] = [];
  const splitter = createThinkSplitter(
    (text) => {
      content += text;
      onDelta(text);
    },
    opts.onReasoning
  );
  for await (const chunk of stream) {
    const delta: any = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      splitter.push(delta.content);
    }
    if (delta?.reasoning_content) opts.onReasoning?.(delta.reasoning_content);
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: tc.type || "function", function: { name: "", arguments: "" } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) {
          const currentName = toolCalls[idx].function.name;
          if (!currentName) toolCalls[idx].function.name = tc.function.name;
          else if (!currentName.includes(tc.function.name)) toolCalls[idx].function.name += tc.function.name;
        }
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
  }
  splitter.flush();
  merged.choices[0].message.content = content;
  if (toolCalls.length) merged.choices[0].message.tool_calls = toolCalls.filter(Boolean);
  return merged;
}
