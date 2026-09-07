#!/usr/bin/env node
/**
 * Standalone scripted OpenAI-compatible provider fixture (loopback HTTP).
 *
 * Modeled on server/src/tests/scriptedOpenAiServer.ts but configurable and
 * self-starting: `node scripts/e2e/fixtures/openai-provider.mjs` prints one
 * content-free ready line `{"fixture":"openai-provider","origin":...}` and
 * serves, on 127.0.0.1 with an OS-assigned port:
 *
 *   POST /v1/chat/completions   streaming SSE replayed from a step script
 *   POST /v1/embeddings         deterministic unit-length float vectors
 *   GET  /v1/models             configured chat + embed model ids
 *   GET  /fixture/state         content-free auth-header record (never values)
 *   POST /fixture/script        runtime script install {"steps":[...],
 *                               "on_exhausted"?:"repeat-last"|"fail"} —
 *                               replaces the script and resets the step
 *                               pointer so journeys drive deterministic
 *                               tool-call roundtrips on one provider instance
 *
 * Script steps (env E2E_OPENAI_SCRIPT, inline JSON or "@path"):
 *   {"type":"text","pieces":["Hel","lo"]}
 *   {"type":"tool_call","id":"call_1","name_pieces":["echo","_query"],
 *    "argument_pieces":["{\"text\":","\"hi\"}"]}
 * A create_report tool_call may set echo_chart_from_tool_call_id to one
 * previous render_chart call ID. Only its validated chart UUID is inserted
 * into charts; unavailable, ambiguous or malformed results fail the request.
 *   {"type":"malformed"}                       raw broken data: frame, then [DONE]
 *   {"type":"slow","delay_ms":500,"pieces":[...]}
 *   {"type":"no_response"}                     200 SSE headers, then silence
 *   {"type":"http_error","status":503}
 * When the script is exhausted, E2E_OPENAI_ON_EXHAUSTED selects behaviour:
 * "repeat-last" (default) replays the final step, "fail" answers 400.
 *
 * Environment:
 *   E2E_OPENAI_CHAT_MODEL   default "fixture-chat-v1"
 *   E2E_OPENAI_EMBED_MODEL  default "fixture-embed-v1"
 *   E2E_OPENAI_EMBED_DIM    default 64
 *   E2E_OPENAI_SCRIPT, E2E_OPENAI_ON_EXHAUSTED
 *
 * Never logs request bodies, prompt content, or Authorization values.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createTrackedServer,
  emitReady,
  installShutdown,
  listenLoopback,
  logError,
  readBoundedBody,
  sendJson,
} from "./lib/http-fixture.mjs";

const MAX_CHAT_BYTES = 8 * 1024 * 1024;
const MAX_EMBED_BYTES = 1 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 256 * 1024;
const FIXED_CREATED_SECONDS = 1_754_400_000;

const chatModel = process.env.E2E_OPENAI_CHAT_MODEL || "fixture-chat-v1";
const embedModel = process.env.E2E_OPENAI_EMBED_MODEL || "fixture-embed-v1";
// The packaged-desktop journey target keeps the app's default embedding
// identity (`nomic-embed` → text-embedding-nomic-embed-text-v1.5 @ 768),
// which Settings can never change, so the fixture must answer at that
// dimension. The ceiling follows the product's 16,384 embedding-dimension
// bound; the default stays 64, so the browser-mode runs are unchanged.
const embedDim = clampInt(process.env.E2E_OPENAI_EMBED_DIM, 1, 16_384, 64);
let onExhausted = process.env.E2E_OPENAI_ON_EXHAUSTED === "fail" ? "fail" : "repeat-last";

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function loadScript() {
  const raw = process.env.E2E_OPENAI_SCRIPT ?? "";
  if (!raw) {
    return [{ type: "text", pieces: ["The fixture model answer."] }];
  }
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("script must be a non-empty array");
  for (const step of parsed) {
    if (!step || typeof step.type !== "string") throw new Error("script step needs a type");
  }
  return parsed;
}

let script = loadScript();
let nextStep = 0;

/** Validate a runtime script payload with the same rules as the env script. */
function validSteps(parsed) {
  return (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((step) => step && typeof step.type === "string")
  );
}

function takeStep() {
  if (nextStep < script.length) {
    const step = script[nextStep];
    nextStep += 1;
    return step;
  }
  if (onExhausted === "fail") return null;
  return script[script.length - 1];
}

function chunk(model, delta, finishReason) {
  return {
    id: "chatcmpl-fixture-provider",
    object: "chat.completion.chunk",
    created: FIXED_CREATED_SECONDS,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function textFrames(model, pieces) {
  const frames = pieces.map((piece, index) =>
    chunk(model, index === 0 ? { role: "assistant", content: piece } : { content: piece }, null)
  );
  frames.push(chunk(model, {}, "stop"));
  return frames;
}

function toolCallFrames(model, id, namePieces, argumentPieces) {
  const frames = [
    chunk(
      model,
      {
        role: "assistant",
        tool_calls: [{ index: 0, id: id ?? "call_fixture_1", type: "function", function: { name: namePieces[0] ?? "", arguments: "" } }],
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

/** Deterministic unit vector derived from sha256(model, input, dim). */
function embeddingVector(model, input, dim) {
  const digest = createHash("sha256").update(`${model}\u0000${input}\u0000${dim}`, "utf8").digest();
  let state = digest.readUInt32BE(0) || 1;
  const floats = new Float64Array(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i += 1) {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const uniform = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const value = uniform * 2 - 1;
    floats[i] = value;
    sumSq += value * value;
  }
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error("embedding-norm-invalid");
  const out = new Array(dim);
  for (let i = 0; i < dim; i += 1) out[i] = Math.fround(floats[i] / norm);
  return out;
}

// Content-free bookkeeping: header presence/scheme only, never header values.
const authRecord = [];
const counters = { chat: 0, embeddings: 0 };

function recordAuth(endpoint, header) {
  if (authRecord.length < 1000) {
    authRecord.push({
      endpoint,
      present: typeof header === "string" && header.length > 0,
      scheme:
        typeof header === "string" && /^Bearer\s/i.test(header) ? "bearer" : header ? "other" : null,
    });
  }
}

const tracked = createTrackedServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (req.method === "GET" && path === "/v1/models") {
      recordAuth("models", req.headers.authorization);
      sendJson(res, 200, {
        object: "list",
        data: [
          { id: chatModel, object: "model", owned_by: "borealis-e2e" },
          { id: embedModel, object: "model", owned_by: "borealis-e2e" },
        ],
      });
      return;
    }
    if (req.method === "GET" && path === "/fixture/state") {
      sendJson(res, 200, {
        chat_calls: counters.chat,
        embedding_calls: counters.embeddings,
        auth: authRecord,
        script_remaining: script.length - nextStep,
        on_exhausted: onExhausted,
      });
      return;
    }
    // Runtime script installation (journeys): replaces the replay script and
    // resets the step pointer so a journey can drive a deterministic
    // tool-call roundtrip against the one provider instance the harness
    // launched. Step/shape validation mirrors `loadScript`. Nothing is logged.
    if (req.method === "POST" && path === "/fixture/script") {
      const body = await readBoundedBody(req, MAX_SCRIPT_BYTES);
      if (body === null) return;
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: { message: "invalid json" } });
        return;
      }
      const steps = parsed?.steps;
      const exhausted = parsed?.on_exhausted;
      if (!parsed || typeof parsed !== "object" || !validSteps(steps)) {
        sendJson(res, 400, { error: { message: "steps must be a non-empty array of typed steps" } });
        return;
      }
      if (exhausted !== undefined && exhausted !== "repeat-last" && exhausted !== "fail") {
        sendJson(res, 400, { error: { message: "on_exhausted must be repeat-last or fail" } });
        return;
      }
      script = steps;
      nextStep = 0;
      if (exhausted !== undefined) onExhausted = exhausted;
      sendJson(res, 200, { ok: true, steps: steps.length });
      return;
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const body = await readBoundedBody(req, MAX_CHAT_BYTES);
      if (body === null) return;
      recordAuth("chat", req.headers.authorization);
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: { message: "invalid json" } });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        sendJson(res, 400, { error: { message: "invalid body" } });
        return;
      }
      counters.chat += 1;
      if (parsed.stream !== true) {
        sendJson(res, 400, { error: { message: "fixture streams only" } });
        return;
      }
      const step = takeStep();
      const model = typeof parsed.model === "string" && parsed.model ? parsed.model : chatModel;
      if (!step) {
        sendJson(res, 400, { error: { message: "script exhausted" } });
        return;
      }
      if (step.type === "http_error") {
        sendJson(res, clampInt(step.status, 400, 599, 503), { error: { message: "scripted failure" } });
        return;
      }
      // Opt-in chart echo: only this exact prior tool-call result may supply
      // a server-minted UUID, and only the report's chart list can be filled.
      let argumentPieces = step.argument_pieces ?? ["{}"];
      if (step.echo_chart_from_tool_call_id !== undefined) {
        try {
          if (step.type !== "tool_call" || step.name_pieces?.join("") !== "create_report" ||
              typeof step.echo_chart_from_tool_call_id !== "string" || step.echo_chart_from_tool_call_id.length > 128) throw new Error();
          const matches = (Array.isArray(parsed.messages) ? parsed.messages : []).filter(
            message => message.role === "tool" && message.tool_call_id === step.echo_chart_from_tool_call_id
          );
          if (matches.length !== 1 || typeof matches[0].content !== "string" || matches[0].content.length > 4096) throw new Error();
          const result = JSON.parse(matches[0].content);
          if (result.rendered !== true || typeof result.chart_id !== "string" ||
              !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.chart_id)) throw new Error();
          const raw = argumentPieces.join("");
          if (raw.length > 20000) throw new Error();
          const args = JSON.parse(raw);
          if (!args || typeof args !== "object" || Array.isArray(args) || Object.hasOwn(args, "charts")) throw new Error();
          argumentPieces = [JSON.stringify({ ...args, charts: [result.chart_id] })];
          if (argumentPieces[0].length > 20000) throw new Error();
        } catch {
          sendJson(res, 400, { error: { message: "fixture chart echo unavailable" } });
          return;
        }
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      switch (step.type) {
        case "text":
          for (const frame of textFrames(model, step.pieces ?? ["ok"])) {
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          }
          break;
        case "tool_call":
          for (const frame of toolCallFrames(model, step.id, step.name_pieces ?? ["t"], argumentPieces)) {
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          }
          break;
        case "malformed":
          res.write('data: {"choices": [ this is not json\n\n');
          break;
        case "slow": {
          const delay = clampInt(step.delay_ms, 1, 120_000, 500);
          await new Promise((resolve) => setTimeout(resolve, delay));
          for (const frame of textFrames(model, step.pieces ?? ["slow answer"])) {
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          }
          break;
        }
        case "no_response":
          // Intentionally silent: only a client-side deadline/cancel ends this.
          return;
        default:
          for (const frame of textFrames(model, ["unknown step"] )) {
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          }
          break;
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (req.method === "POST" && path === "/v1/embeddings") {
      const body = await readBoundedBody(req, MAX_EMBED_BYTES);
      if (body === null) return;
      recordAuth("embeddings", req.headers.authorization);
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: { message: "invalid json" } });
        return;
      }
      const inputs = typeof parsed?.input === "string" ? [parsed.input] : Array.isArray(parsed?.input) ? parsed.input : null;
      if (!inputs || inputs.length === 0 || inputs.some((item) => typeof item !== "string")) {
        sendJson(res, 400, { error: { message: "input must be a string or string array" } });
        return;
      }
      const model = typeof parsed.model === "string" && parsed.model ? parsed.model : embedModel;
      const dim = clampInt(parsed.dimensions, 1, 16_384, embedDim);
      // Float arrays are the default; base64 is honoured only when requested.
      const asBase64 = parsed.encoding_format === "base64";
      counters.embeddings += 1;
      const data = inputs.map((input, index) => {
        const vector = embeddingVector(model, input, dim);
        const encoded = asBase64
          ? Buffer.from(new Float32Array(vector).buffer).toString("base64")
          : vector;
        return { object: "embedding", index, embedding: encoded };
      });
      sendJson(res, 200, {
        object: "list",
        model,
        data,
        usage: { prompt_tokens: inputs.join(" ").length, total_tokens: inputs.join(" ").length },
      });
      return;
    }
    sendJson(res, 404, { error: { message: "not found" } });
  } catch (error) {
    logError(error?.message ?? "handler-error");
    if (!res.headersSent) sendJson(res, 500, { error: { message: "fixture error" } });
    else res.end();
  }
});

const port = await listenLoopback(tracked.server);
installShutdown(() => tracked.close());
emitReady({ fixture: "openai-provider", origin: `http://127.0.0.1:${port}` });
