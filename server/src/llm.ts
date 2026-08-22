import OpenAI from "openai";
import { config } from "./config.js";

export const client = new OpenAI({
  baseURL: `${config.llmBaseUrl}/v1`,
  apiKey: config.llmApiKey,
});

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

export async function chatOnce(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean; tools?: any } = {}
): Promise<OpenAI.Chat.ChatCompletion> {
  return client.chat.completions.create({
    model: config.chatModel,
    messages,
    max_tokens: opts.maxTokens ?? 1800,
    temperature: opts.temperature ?? 0.2,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });
}

export async function streamingChat(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; tools?: any },
  onDelta: (text: string) => void
): Promise<OpenAI.Chat.ChatCompletion> {
  const stream = await client.chat.completions.create({
    model: config.chatModel,
    messages,
    max_tokens: opts.maxTokens ?? 2200,
    temperature: opts.temperature ?? 0.2,
    ...(opts.tools ? { tools: opts.tools } : {}),
    stream: true,
  });
  const merged: any = { id: "stream", choices: [{ message: { role: "assistant", content: "", tool_calls: [] } }] };
  let content = "";
  const toolCalls: any[] = [];
  for await (const chunk of stream) {
    const delta: any = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: tc.type || "function", function: { name: "", arguments: "" } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
  }
  merged.choices[0].message.content = content;
  if (toolCalls.length) merged.choices[0].message.tool_calls = toolCalls;
  return merged;
}
