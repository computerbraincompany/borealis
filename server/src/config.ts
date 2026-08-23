import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// repo root = two levels up from server/src
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const JWT_SECRET = process.env.JWT_SECRET ?? "";
const PYTHON_SERVICE_TOKEN = process.env.PYTHON_SERVICE_TOKEN ?? "";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY ?? "";
// Running with the default or a template secret makes every JWT forgeable.
// Refuse to boot rather than silently shipping broken auth.
const WEAK_JWT_SECRETS = new Set(["", "dev-secret-change-me", "please-change-me", "change-me"]);
if (WEAK_JWT_SECRETS.has(JWT_SECRET) || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET must be set to a random value of at least 32 chars (generate with: openssl rand -base64 32). Refusing to start with a weak/default secret."
  );
}
if (PYTHON_SERVICE_TOKEN.length < 32) {
  throw new Error("PYTHON_SERVICE_TOKEN must be set to a random value of at least 32 chars");
}
if (LITELLM_API_KEY.length < 32 || /^sk-borealis-local$/i.test(LITELLM_API_KEY)) {
  throw new Error("LITELLM_API_KEY must be set to a non-placeholder value of at least 32 chars");
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function parseCorsOrigins(value: string | undefined): readonly string[] {
  const raw = value ?? "http://127.0.0.1:5173,http://localhost:5173";
  const origins = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const url = new URL(item);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== item) {
        throw new Error("CORS_ORIGINS must contain comma-separated HTTP(S) origins without paths");
      }
      return url.origin;
    });
  return Object.freeze([...new Set(origins)]);
}

export function parseServiceOrigin(value: string | undefined, fallback: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value ?? fallback);
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || /^127\./.test(hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error(`${name} must use HTTPS unless it is a loopback origin`);
  }
  return url.origin;
}

function canonicalStorageDirectory(value: string): string {
  const resolved = path.resolve(value);
  fs.mkdirSync(resolved, { recursive: true });
  return fs.realpathSync(resolved);
}

export interface ModelIds {
  chatModel: string;
  embedModel: string;
}

/** Validate the two operator-owned model roles without exposing their values. */
export function validateModelIds(input: ModelIds): ModelIds {
  const chatModel = input.chatModel.trim();
  const embedModel = input.embedModel.trim();

  if (chatModel.length < 1 || chatModel.length > 256) {
    throw new Error("LITELLM_CHAT_MODEL must contain between 1 and 256 characters");
  }
  if (embedModel.length < 1 || embedModel.length > 256) {
    throw new Error("LITELLM_EMBED_MODEL must contain between 1 and 256 characters");
  }
  if (chatModel === embedModel) {
    throw new Error("LITELLM_CHAT_MODEL and LITELLM_EMBED_MODEL must be distinct");
  }

  return { chatModel, embedModel };
}

const modelIds = validateModelIds({
  chatModel: process.env.LITELLM_CHAT_MODEL ?? "qwen-chat",
  embedModel: process.env.LITELLM_EMBED_MODEL ?? "nomic-embed",
});

const maxMessageChars = boundedPositiveInteger(process.env.MAX_MESSAGE_CHARS, 32_000, "MAX_MESSAGE_CHARS", 100_000);
const maxHistoryChars = boundedPositiveInteger(process.env.MAX_HISTORY_CHARS, 120_000, "MAX_HISTORY_CHARS", 500_000);
// Reserve one ordinary full-content message plus bounded metadata/envelope.
// JSON escape-heavy content is honestly truncated at response time so every
// page still returns a cursor-bearing row within this aggregate budget.
if (maxHistoryChars < maxMessageChars + 36_000) {
  throw new Error("MAX_HISTORY_CHARS must be at least MAX_MESSAGE_CHARS + 36000");
}

export const config = {
  port: boundedPositiveInteger(process.env.PORT, 3000, "PORT", 65_535),
  host: process.env.HOST || "127.0.0.1",
  jwtSecret: JWT_SECRET,
  databaseUrl: process.env.DATABASE_URL || "postgres://borealis:borealis_password@localhost:5433/borealis",
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),

  // LiteLLM / any OpenAI-compatible endpoint
  llmBaseUrl: parseServiceOrigin(process.env.LITELLM_BASE_URL, "http://localhost:4000", "LITELLM_BASE_URL"),
  llmApiKey: LITELLM_API_KEY,
  chatModel: modelIds.chatModel,
  embedModel: modelIds.embedModel,
  embeddingDim: boundedPositiveInteger(process.env.EMBEDDING_DIM, 768, "EMBEDDING_DIM", 16_384),

  pythonServiceUrl: parseServiceOrigin(process.env.PYTHON_SERVICE_URL, "http://localhost:8000", "PYTHON_SERVICE_URL"),
  pythonServiceToken: PYTHON_SERVICE_TOKEN,

  maxUploadBytes: boundedPositiveInteger(
    process.env.MAX_UPLOAD_BYTES,
    25 * 1024 * 1024,
    "MAX_UPLOAD_BYTES",
    250 * 1024 * 1024
  ),
  maxMessageChars,
  maxHistoryMessages: boundedPositiveInteger(process.env.MAX_HISTORY_MESSAGES, 80, "MAX_HISTORY_MESSAGES", 500),
  maxHistoryChars,
  maxExtractedChars: boundedPositiveInteger(
    process.env.MAX_EXTRACTED_CHARS,
    2_000_000,
    "MAX_EXTRACTED_CHARS",
    10_000_000
  ),
  maxIngestChunks: boundedPositiveInteger(process.env.MAX_INGEST_CHUNKS, 2_500, "MAX_INGEST_CHUNKS", 10_000),

  uploadDir: canonicalStorageDirectory(process.env.UPLOAD_DIR || path.join(root, "uploads")),
  reportDir: canonicalStorageDirectory(process.env.REPORT_DIR || path.join(root, "reports_storage")),
};
