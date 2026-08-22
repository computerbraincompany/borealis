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
    const res = await client.embeddings.create({ model: config.embedModel, input: batch });
    out.push(...res.data.map((d) => d.embedding as number[]));
  }
  return out;
}

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export async function chatOnce(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean } = {}
): Promise<OpenAI.Chat.ChatCompletion> {
  return client.chat.completions.create({
    model: config.chatModel,
    messages,
    max_tokens: opts.maxTokens ?? 1800,
    temperature: opts.temperature ?? 0.2,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });
}

export async function streamingChat(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number },
  onDelta: (text: string) => void
): Promise<OpenAI.Chat.ChatCompletion> {
  const stream = await client.chat.completions.create({
    model: config.chatModel,
    messages,
    max_tokens: opts.maxTokens ?? 2200,
    temperature: opts.temperature ?? 0.2,
    stream: true,
  });
  const merged: any = { id: "stream", choices: [{ message: { role: "assistant", content: "", tool_calls: [] } }] };
  let content = "";
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onDelta(delta.content);
    }
  }
  merged.choices[0].message.content = content;
  return merged;
}
