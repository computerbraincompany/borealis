import type { Message } from "@/lib/api";

export function prependOlderMessages(current: Message[], older: Message[]): Message[] {
  const known = new Set(current.map((message) => message.id));
  return [...older.filter((message) => !known.has(message.id)), ...current];
}
