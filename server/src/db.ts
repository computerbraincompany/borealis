import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- csv | xlsx | pdf | docx | connector
  connector TEXT,                 -- connector id if synced remotely
  display_name TEXT NOT NULL,
  file_path TEXT,
  url TEXT,
  mime TEXT,
  size_bytes BIGINT DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready',   -- ready | index | error
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS sources_id_account_uidx ON sources (id, account_id);

CREATE TABLE IF NOT EXISTS chunks (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  source_name TEXT,
  content TEXT NOT NULL,
  embedding vector(${config.embeddingDim}),
  meta JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks (source_id);

CREATE TABLE IF NOT EXISTS connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,             -- url_csv | url_json
  config JSONB NOT NULL DEFAULT '{}',
  target_table TEXT NOT NULL,
  last_sync TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT,
  source_mode TEXT NOT NULL DEFAULT 'all',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS source_mode TEXT NOT NULL DEFAULT 'all';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chats_source_mode_check'
      AND conrelid = 'chats'::regclass
  ) THEN
    ALTER TABLE chats
      ADD CONSTRAINT chats_source_mode_check
      CHECK (source_mode IN ('all', 'selected'));
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS chats_id_account_uidx ON chats (id, account_id);

CREATE TABLE IF NOT EXISTS chat_sources (
  chat_id UUID NOT NULL,
  source_id UUID NOT NULL,
  account_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, source_id),
  FOREIGN KEY (chat_id, account_id)
    REFERENCES chats(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, account_id)
    REFERENCES sources(id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chat_sources_source_idx
  ON chat_sources (source_id, chat_id);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- user | assistant | system
  content TEXT,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID REFERENCES chats(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  html_path TEXT,
  pdf_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS charts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spec JSONB NOT NULL,
  echarts JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function initDb() {
  await pool.query(SCHEMA);
  await pool.query(`UPDATE chats SET model=$1 WHERE model IS NULL`, [config.chatModel]);
  await pool.query(`ALTER TABLE chats ALTER COLUMN model SET NOT NULL`);
}

export async function q<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}
