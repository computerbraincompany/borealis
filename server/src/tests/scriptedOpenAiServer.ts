/**
 * Protocol-minimal, deterministic OpenAI-compatible provider fixture for the
 * vertical agent-turn integration test. It exists so the production
 * route → agent → tool → `llm.ts` client path can be exercised over a real
 * loopback HTTP socket without a live model or external network. It is a seam
 * fixture, not an OpenAI emulator: it serves only `POST /v1/chat/completions`
 * with `stream: true` from a fixed script of `text/event-stream` frames and
 * answers 404 for every other path.
 *
 * Chat-completion request bodies are parsed and retained in memory for test
 * assertions only. Headers, raw bytes, and parsed bodies are never printed.
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const FIXED_CREATED_SECONDS = 1_754_400_000;

export interface ScriptedOpenAiServer {
  /** Bare loopback origin, e.g. `http://127.0.0.1:54321`. */
  readonly origin: string;
  /** Parsed chat-completion request bodies in arrival order (in-memory copy). */
  readonly calls: readonly Record<string, unknown>[];
  close(): Promise<void>;
}

function chunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | null
): Record<string, unknown> {
  return {
    id: "chatcmpl-scripted-vertical",
    object: "chat.completion.chunk",
    created: FIXED_CREATED_SECONDS,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** One streaming assistant answer split into content pieces across frames. */
export function assistantTextChunks(model: string, pieces: readonly string[]): Record<string, unknown>[] {
  if (!pieces.length) throw new Error("a scripted text response needs at least one piece");
  const frames = pieces.map((piece, index) =>
    chunk(model, index === 0 ? { role: "assistant", content: piece } : { content: piece }, null)
  );
  frames.push(chunk(model, {}, "stop"));
  return frames;
}

/**
 * One streaming native function tool call whose name and JSON arguments are
 * deliberately split across frames, so the production streamed tool-call
 * accumulator and name-merge contract are the code that reconstructs it.
 */
export function assistantToolCallChunks(
  model: string,
  toolCallId: string,
  namePieces: readonly string[],
  argumentPieces: readonly string[]
): Record<string, unknown>[] {
  if (!namePieces.length || !argumentPieces.length) {
    throw new Error("a scripted tool-call response needs name and argument pieces");
  }
  const frames = [
    chunk(
      model,
      {
        role: "assistant",
        tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: namePieces[0], arguments: "" } }],
      },
      null
    ),
  ];
  for (const piece of namePieces.slice(1)) {
    frames.push(chunk(model, { tool_calls: [{ index: 0, type: "function", function: { name: piece } }] }, null));
  }
  for (const piece of argumentPieces) {
    frames.push(chunk(model, { tool_calls: [{ index: 0, function: { arguments: piece } }] }, null));
  }
  frames.push(chunk(model, {}, "tool_calls"));
  return frames;
}

export async function startScriptedOpenAiServer(
  model: string,
  responses: readonly (readonly Record<string, unknown>[])[]
): Promise<ScriptedOpenAiServer> {
  const calls: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  let nextResponse = 0;
  const server = http.createServer((req, res) => {
    const body: Buffer[] = [];
    let receivedBytes = 0;
    let aborted = false;
    req.on("data", (piece: Buffer) => {
      receivedBytes += piece.length;
      if (receivedBytes > MAX_REQUEST_BYTES) {
        aborted = true;
        res.destroy();
        return;
      }
      body.push(piece);
    });
    req.on("end", () => {
      if (aborted) return;
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(body).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.writeHead(400).end();
        return;
      }
      calls.push(parsed as Record<string, unknown>);
      const script = responses[nextResponse];
      nextResponse += 1;
      if ((parsed as { stream?: unknown }).stream !== true || !script) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      for (const frame of script) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get calls(): readonly Record<string, unknown>[] {
      return [...calls];
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
