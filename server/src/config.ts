import "dotenv/config";
import path from "node:path";
import fs from "node:fs";

const root = "/Users/max/Developer/github/computerbraincompany/north-clone";

export const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  databaseUrl: process.env.DATABASE_URL || "postgres://north:north_password@localhost:5432/north",

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
