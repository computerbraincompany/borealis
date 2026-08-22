import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// repo root = two levels up from server/src
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const JWT_SECRET = process.env.JWT_SECRET ?? "";
// Running with the default or a template secret makes every JWT forgeable.
// Refuse to boot rather than silently shipping broken auth.
const WEAK_JWT_SECRETS = new Set(["", "dev-secret-change-me", "please-change-me", "change-me"]);
if (WEAK_JWT_SECRETS.has(JWT_SECRET) || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET must be set to a random value of at least 32 chars (generate with: openssl rand -base64 32). Refusing to start with a weak/default secret."
  );
}

export const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: JWT_SECRET,
  databaseUrl: process.env.DATABASE_URL || "postgres://north:north_password@localhost:5433/north",

  // LiteLLM / any OpenAI-compatible endpoint
  llmBaseUrl: process.env.LITELLM_BASE_URL || "http://localhost:4000",
  llmApiKey: process.env.LITELLM_API_KEY || "sk-north-local",
  chatModel: process.env.LITELLM_CHAT_MODEL || "qwen-chat",
  embedModel: process.env.LITELLM_EMBED_MODEL || "nomic-embed",
  embeddingDim: Number(process.env.EMBEDDING_DIM || 768),

  pythonServiceUrl: process.env.PYTHON_SERVICE_URL || "http://localhost:8000",

  uploadDir: process.env.UPLOAD_DIR || path.join(root, "uploads"),
  reportDir: process.env.REPORT_DIR || path.join(root, "reports_storage"),
};

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.reportDir, { recursive: true });
