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
  sync_status TEXT NOT NULL DEFAULT 'idle',
  sync_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS sync_error TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS connectors_account_target_uidx
  ON connectors (account_id, target_table);

CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  title_is_manual BOOLEAN NOT NULL DEFAULT false,
  model TEXT,
  source_mode TEXT NOT NULL DEFAULT 'all',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS source_mode TEXT NOT NULL DEFAULT 'all';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE chats SET updated_at=created_at WHERE updated_at IS NULL;
ALTER TABLE chats ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE chats ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS title_is_manual BOOLEAN;
UPDATE chats SET title_is_manual=false WHERE title_is_manual IS NULL;
ALTER TABLE chats ALTER COLUMN title_is_manual SET DEFAULT false;
ALTER TABLE chats ALTER COLUMN title_is_manual SET NOT NULL;
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
CREATE INDEX IF NOT EXISTS chats_account_activity_idx ON chats (account_id, updated_at DESC, id DESC);

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
CREATE INDEX IF NOT EXISTS messages_chat_id_id_idx ON messages (chat_id, id DESC);

CREATE TABLE IF NOT EXISTS chat_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY (chat_id, account_id)
    REFERENCES chats(id, account_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_runs_one_active_uidx
  ON chat_runs (chat_id) WHERE status IN ('running', 'cancelling');
CREATE INDEX IF NOT EXISTS chat_runs_account_activity_idx
  ON chat_runs (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  source_id UUID PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  leased_at TIMESTAMPTZ,
  lease_token UUID,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS lease_token UUID;
CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_idx
  ON ingestion_jobs (status, available_at, updated_at);

CREATE TABLE IF NOT EXISTS dataset_cache_cleanup_jobs (
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, name, location)
);

CREATE TABLE IF NOT EXISTS ingestion_chunk_staging (
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(${config.embeddingDim}),
  meta JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (source_id, generation, seq)
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID REFERENCES chats(id) ON DELETE SET NULL,
  run_id UUID REFERENCES chat_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'published',
  title TEXT NOT NULL,
  subtitle TEXT,
  html_path TEXT,
  pdf_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS run_id UUID;
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_run_id_fkey;
ALTER TABLE reports ADD CONSTRAINT reports_run_id_fkey FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

CREATE TABLE IF NOT EXISTS charts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES chat_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'published',
  spec JSONB NOT NULL,
  echarts JSONB NOT NULL,
  png_base64 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE charts ADD COLUMN IF NOT EXISTS png_base64 TEXT;
ALTER TABLE charts ADD COLUMN IF NOT EXISTS run_id UUID;
ALTER TABLE charts DROP CONSTRAINT IF EXISTS charts_run_id_fkey;
ALTER TABLE charts ADD CONSTRAINT charts_run_id_fkey FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE SET NULL;
ALTER TABLE charts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
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
