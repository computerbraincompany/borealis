import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { sameLlmModel } from "./llmAliases.js";

// Browser development keeps conventional server/.env support. The packaged
// utility process receives an explicit, main-owned environment and must never
// discover a stray userData/.env file through its working directory.
if (process.env.BOREALIS_DESKTOP !== "1") dotenv.config();

// repo root = two levels up from server/src
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const WEAK_JWT_SECRETS = new Set(["", "dev-secret-change-me", "please-change-me", "change-me"]);
const MAX_JWT_SECRET_FILE_BYTES = 4_096;

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

/** Accept zero only for an OS-assigned ephemeral listening port. */
export function parseServerPort(value: string | undefined): number {
  if (value !== undefined && value.trim() === "") throw new Error("PORT must be an integer between 0 and 65535");
  const parsed = value === undefined ? 3_000 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  return parsed;
}

export function resolveSettingsFile(input: {
  readonly settingsFile?: string;
  readonly legacySettingsPath?: string;
  readonly storageDir: string;
}): string {
  return path.resolve(input.settingsFile || input.legacySettingsPath || path.join(input.storageDir, "settings.json"));
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
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error(`${name} must use HTTPS unless it is a loopback origin`);
  }
  return url.origin;
}

export function resolveLlmBaseUrl(input: { llmBaseUrl?: string; legacyBaseUrl?: string }): string {
  if (input.llmBaseUrl !== undefined) {
    return parseServiceOrigin(input.llmBaseUrl, "http://127.0.0.1:1234", "LLM_BASE_URL");
  }
  if (input.legacyBaseUrl !== undefined) {
    return parseServiceOrigin(input.legacyBaseUrl, "http://127.0.0.1:1234", "LITELLM_BASE_URL");
  }
  return parseServiceOrigin(undefined, "http://127.0.0.1:1234", "LLM_BASE_URL");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.split(".", 1)[0] === "127";
  if (ipVersion === 6) return normalized === "::1";
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/** Treat the standard loopback spellings as one endpoint without doing DNS. */
export function serviceOriginsEquivalent(left: string, right: string): boolean {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  if (leftUrl.origin === rightUrl.origin) return true;
  return (
    leftUrl.protocol === rightUrl.protocol &&
    effectivePort(leftUrl) === effectivePort(rightUrl) &&
    isLoopbackHostname(leftUrl.hostname) &&
    isLoopbackHostname(rightUrl.hostname)
  );
}

function canonicalStorageDirectory(value: string): string {
  const resolved = path.resolve(value);
  fs.mkdirSync(resolved, { recursive: true });
  return fs.realpathSync(resolved);
}

export interface ResolveJwtSecretOptions {
  readonly envSecret?: string;
  readonly filename: string;
}

/**
 * Resolve a server-owned JWT signing secret without requiring a .env file.
 * An explicitly supplied environment value always wins and is never repaired;
 * weak values fail closed. Otherwise a 0600 secret file is read without
 * following symlinks, or created once through an atomic same-directory link.
 */
export function resolveJwtSecret(options: ResolveJwtSecretOptions): string {
  if (options.envSecret !== undefined) return validateJwtSecret(options.envSecret, "JWT_SECRET");

  const filename = path.resolve(options.filename);
  try {
    return readJwtSecretFile(filename);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new Error("JWT secret file is invalid or unreadable", { cause: error });
    }
  }

  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const secret = randomBytes(48).toString("base64url");
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, `${secret}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, filename);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      return readJwtSecretFile(filename);
    }
    syncDirectory(directory);
    return secret;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return readJwtSecretFile(filename);
    throw new Error("JWT secret file could not be created", { cause: error });
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best-effort cleanup after a failed write.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        // The fully written secret is already durable; do not expose cleanup details.
      }
    }
  }
}

function readJwtSecretFile(filename: string): string {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_JWT_SECRET_FILE_BYTES) {
      throw new Error("invalid JWT secret file");
    }
    if ((stat.mode & 0o777) !== 0o600) fs.fchmodSync(descriptor, 0o600);
    const contents = fs.readFileSync(descriptor, "utf8");
    const secret = contents.endsWith("\r\n")
      ? contents.slice(0, -2)
      : contents.endsWith("\n")
        ? contents.slice(0, -1)
        : contents;
    return validateJwtSecret(secret, "JWT secret file");
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateJwtSecret(secret: string, source: "JWT_SECRET" | "JWT secret file"): string {
  if (
    secret.length < 32 ||
    secret.length > MAX_JWT_SECRET_FILE_BYTES ||
    WEAK_JWT_SECRETS.has(secret) ||
    containsControlCharacter(secret)
  ) {
    throw new Error(`${source} must contain a strong secret of at least 32 characters`);
  }
  return secret;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is best-effort on platforms that do not support it.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
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
    throw new Error("LLM_CHAT_MODEL must contain between 1 and 256 characters");
  }
  if (embedModel.length < 1 || embedModel.length > 256) {
    throw new Error("LLM_EMBED_MODEL must contain between 1 and 256 characters");
  }
  if (sameLlmModel(chatModel, embedModel)) {
    throw new Error("LLM_CHAT_MODEL and LLM_EMBED_MODEL must be distinct");
  }

  return { chatModel, embedModel };
}

const storageDir = path.resolve(process.env.BOREALIS_DATA_DIR || path.join(root, ".borealis"));
const sqlitePath = path.resolve(process.env.SQLITE_PATH || path.join(storageDir, "borealis.sqlite"));
const settingsFile = resolveSettingsFile({
  settingsFile: process.env.SETTINGS_FILE,
  legacySettingsPath: process.env.SETTINGS_PATH,
  storageDir,
});
const jwtSecretFile = path.resolve(process.env.JWT_SECRET_FILE || path.join(storageDir, "jwt.secret"));
// File-backed configuration is initialized only after the exact workspace lock
// is held. An environment-owned secret can be validated eagerly because that
// path performs no filesystem access.
const jwtSecret =
  process.env.JWT_SECRET === undefined
    ? ""
    : resolveJwtSecret({ envSecret: process.env.JWT_SECRET, filename: jwtSecretFile });

const maxMessageChars = boundedPositiveInteger(process.env.MAX_MESSAGE_CHARS, 32_000, "MAX_MESSAGE_CHARS", 100_000);
const maxHistoryChars = boundedPositiveInteger(process.env.MAX_HISTORY_CHARS, 120_000, "MAX_HISTORY_CHARS", 500_000);
// Reserve one ordinary full-content message plus bounded metadata/envelope.
// JSON escape-heavy content is honestly truncated at response time so every
// page still returns a cursor-bearing row within this aggregate budget.
if (maxHistoryChars < maxMessageChars + 36_000) {
  throw new Error("MAX_HISTORY_CHARS must be at least MAX_MESSAGE_CHARS + 36000");
}

export const config = {
  port: parseServerPort(process.env.PORT),
  host: process.env.HOST || "127.0.0.1",
  jwtSecret,
  jwtSecretFile,
  storageDir,
  settingsFile,
  sqlitePath,
  lanceDir: path.resolve(process.env.LANCEDB_DIR || path.join(storageDir, "lancedb")),
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),

  embeddingDim: boundedPositiveInteger(process.env.EMBEDDING_DIM, 768, "EMBEDDING_DIM", 16_384),

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

  ocrMaxPages: boundedPositiveInteger(process.env.OCR_MAX_PAGES, 12, "OCR_MAX_PAGES", 100),
  ocrMaxRasterPixels: boundedPositiveInteger(
    process.env.OCR_MAX_RASTER_PIXELS,
    4_000_000,
    "OCR_MAX_RASTER_PIXELS",
    16_000_000
  ),
  ocrPageTimeoutMs: boundedPositiveInteger(process.env.OCR_PAGE_TIMEOUT_MS, 10_000, "OCR_PAGE_TIMEOUT_MS", 60_000),
  ocrTotalTimeoutMs: boundedPositiveInteger(process.env.OCR_TOTAL_TIMEOUT_MS, 60_000, "OCR_TOTAL_TIMEOUT_MS", 300_000),
  ocrMaxObservations: boundedPositiveInteger(process.env.OCR_MAX_OBSERVATIONS, 1_000, "OCR_MAX_OBSERVATIONS", 5_000),
  ocrMaxPageChars: boundedPositiveInteger(process.env.OCR_MAX_PAGE_CHARS, 20_000, "OCR_MAX_PAGE_CHARS", 100_000),

  uploadDir: path.resolve(process.env.UPLOAD_DIR || path.join(storageDir, "uploads")),
  reportDir: path.resolve(process.env.REPORT_DIR || path.join(storageDir, "reports")),
  containedDir: path.resolve(process.env.CONTAINED_DIR || path.join(storageDir, "models")),
};

/**
 * Create and canonicalize durable paths only after the caller owns the exact
 * workspace lock. Keeping module evaluation path-only ensures a losing server
 * process cannot mutate a live workspace before returning WORKSPACE_LOCKED.
 */
export function initializeConfigStorage(): void {
  config.storageDir = canonicalStorageDirectory(config.storageDir);
  fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
  config.lanceDir = canonicalStorageDirectory(config.lanceDir);
  config.uploadDir = canonicalStorageDirectory(config.uploadDir);
  config.reportDir = canonicalStorageDirectory(config.reportDir);
  config.containedDir = canonicalStorageDirectory(config.containedDir);
  config.jwtSecret = resolveJwtSecret({ envSecret: process.env.JWT_SECRET, filename: config.jwtSecretFile });
}
