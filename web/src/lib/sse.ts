export type SseEventHandler = (event: unknown) => void;

/** Incrementally parses an SSE response, including CRLF and events split across chunks. */
export class SseJsonParser {
  private buffer = "";

  constructor(private readonly onEvent: SseEventHandler) {}

  push(chunk: string): void {
    this.buffer += chunk;
    this.drain(false);
  }

  finish(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    let match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
    while (match?.index !== undefined) {
      this.parseBlock(this.buffer.slice(0, match.index));
      this.buffer = this.buffer.slice(match.index + match[0].length);
      match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
    }

    if (final && this.buffer.trim()) {
      this.parseBlock(this.buffer);
      this.buffer = "";
    }
  }

  private parseBlock(block: string): void {
    const data = block
      .split(/\r?\n|\r/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;

    try {
      this.onEvent(JSON.parse(data));
    } catch {
      // A malformed event must not terminate an otherwise valid stream.
    }
  }
}

export async function consumeSseJson(body: ReadableStream<Uint8Array>, onEvent: SseEventHandler): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseJsonParser(onEvent);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.finish();
}
