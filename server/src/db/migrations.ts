import { SqliteMigrationError } from "./types.js";

export const LATEST_SQLITE_SCHEMA_VERSION = 5;

interface MigrationDatabase {
  exec(sql: string): unknown;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
}

const SCHEMA_V1 = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('url_csv','url_json')),
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  target_table TEXT NOT NULL,
  last_sync TEXT,
  sync_status TEXT NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle','syncing','indexing','error')),
  sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, target_table)
) STRICT;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  connector TEXT,
  display_name TEXT NOT NULL,
  file_path TEXT,
  url TEXT,
  mime TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','index','error')),
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  ready_generation INTEGER CHECK (ready_generation IS NULL OR ready_generation >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, name),
  FOREIGN KEY (connector, account_id) REFERENCES connectors(id, account_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  source_name TEXT,
  content TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  UNIQUE (source_id, generation, seq),
  FOREIGN KEY (source_id, account_id) REFERENCES sources(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX chunks_source_idx ON chunks (source_id, generation, seq);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  title_is_manual INTEGER NOT NULL DEFAULT 0 CHECK (title_is_manual IN (0,1)),
  model TEXT NOT NULL,
  source_mode TEXT NOT NULL DEFAULT 'all' CHECK (source_mode IN ('all','selected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id)
) STRICT;
CREATE INDEX chats_account_activity_idx ON chats (account_id, updated_at DESC, id DESC);

CREATE TABLE chat_sources (
  chat_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (chat_id, source_id),
  FOREIGN KEY (chat_id, account_id) REFERENCES chats(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, account_id) REFERENCES sources(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX chat_sources_source_idx ON chat_sources (source_id, chat_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX messages_chat_id_id_idx ON messages (chat_id, id DESC);

CREATE TABLE chat_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  user_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','cancelling','completed','failed','cancelled')),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  UNIQUE (id, account_id),
  FOREIGN KEY (chat_id, account_id) REFERENCES chats(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX chat_runs_one_active_uidx
  ON chat_runs (chat_id) WHERE status IN ('running','cancelling');
CREATE INDEX chat_runs_account_activity_idx ON chat_runs (account_id, created_at DESC);

CREATE TABLE chat_run_sources (
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (run_id, source_id),
  FOREIGN KEY (run_id, account_id) REFERENCES chat_runs(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, account_id) REFERENCES sources(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX chat_run_sources_source_idx ON chat_run_sources (account_id, source_id, run_id);

CREATE TABLE ingestion_jobs (
  source_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('preparing','pending','running','done','error')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  leased_at TEXT,
  lease_token TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (source_id, account_id) REFERENCES sources(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX ingestion_jobs_claim_idx ON ingestion_jobs (status, available_at, updated_at, source_id);

CREATE TABLE dataset_cache_cleanup_jobs (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (account_id, name, location)
) STRICT;

CREATE TABLE ingestion_chunk_staging (
  chunk_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  UNIQUE (source_id, generation, seq),
  FOREIGN KEY (source_id, account_id) REFERENCES sources(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX ingestion_chunk_staging_generation_idx
  ON ingestion_chunk_staging (source_id, generation, seq);

CREATE TABLE pending_source_deletes (
  source_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT,
  connector_id TEXT,
  dataset_locations TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dataset_locations)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX pending_source_deletes_account_idx ON pending_source_deletes (account_id, created_at);

CREATE TABLE pending_vector_ops (
  source_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('delete_generation','prune_except_generation')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (source_id, operation, generation)
) STRICT;
CREATE INDEX pending_vector_ops_account_idx ON pending_vector_ops (account_id, created_at);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('pending','published')),
  title TEXT NOT NULL,
  subtitle TEXT,
  html_path TEXT,
  pdf_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE charts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('pending','published')),
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  echarts TEXT NOT NULL CHECK (json_valid(echarts)),
  png_base64 TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
`;

const SCHEMA_V2 = `
CREATE TABLE _artifact_tenant_validation (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;
INSERT INTO _artifact_tenant_validation (valid)
SELECT CASE WHEN
  EXISTS (
    SELECT 1
    FROM reports report
    LEFT JOIN chats chat
      ON chat.id=report.chat_id AND chat.account_id=report.account_id
    LEFT JOIN chat_runs run
      ON run.id=report.run_id AND run.account_id=report.account_id
    WHERE (report.chat_id IS NOT NULL AND chat.id IS NULL)
       OR (report.run_id IS NOT NULL AND run.id IS NULL)
       OR (report.chat_id IS NOT NULL AND report.run_id IS NOT NULL AND run.chat_id<>report.chat_id)
  )
  OR EXISTS (
    SELECT 1
    FROM charts chart
    LEFT JOIN chat_runs run
      ON run.id=chart.run_id AND run.account_id=chart.account_id
    WHERE chart.run_id IS NOT NULL AND run.id IS NULL
  )
  THEN 0 ELSE 1 END;
DROP TABLE _artifact_tenant_validation;

CREATE TABLE report_artifact_cleanup_jobs (
  report_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  run_id TEXT,
  html_path TEXT,
  pdf_path TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX report_artifact_cleanup_jobs_retry_idx
  ON report_artifact_cleanup_jobs (attempts, updated_at, report_id);
CREATE INDEX report_artifact_cleanup_jobs_run_idx
  ON report_artifact_cleanup_jobs (account_id, run_id, report_id);

CREATE TRIGGER reports_tenant_insert_guard
BEFORE INSERT ON reports
WHEN (NEW.chat_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM chats WHERE id=NEW.chat_id AND account_id=NEW.account_id
     ))
  OR (NEW.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM chat_runs WHERE id=NEW.run_id AND account_id=NEW.account_id
     ))
  OR (NEW.chat_id IS NOT NULL AND NEW.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM chat_runs
        WHERE id=NEW.run_id AND account_id=NEW.account_id AND chat_id=NEW.chat_id
     ))
  OR EXISTS (
        SELECT 1 FROM report_artifact_cleanup_jobs WHERE report_id=NEW.id
     )
BEGIN
  SELECT RAISE(ABORT, 'report tenant ownership mismatch or id pending cleanup');
END;

CREATE TRIGGER reports_tenant_update_guard
BEFORE UPDATE OF id, account_id, chat_id, run_id ON reports
WHEN NEW.id<>OLD.id
  OR NEW.account_id<>OLD.account_id
  OR (NEW.chat_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM chats WHERE id=NEW.chat_id AND account_id=NEW.account_id
     ))
  OR (NEW.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM chat_runs WHERE id=NEW.run_id AND account_id=NEW.account_id
     ))
  OR (NEW.chat_id IS NOT NULL AND NEW.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM chat_runs
        WHERE id=NEW.run_id AND account_id=NEW.account_id AND chat_id=NEW.chat_id
     ))
BEGIN
  SELECT RAISE(ABORT, 'report tenant ownership mismatch or id pending cleanup');
END;

CREATE TRIGGER charts_tenant_insert_guard
BEFORE INSERT ON charts
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM chat_runs WHERE id=NEW.run_id AND account_id=NEW.account_id
)
BEGIN
  SELECT RAISE(ABORT, 'chart tenant ownership mismatch');
END;

CREATE TRIGGER charts_tenant_update_guard
BEFORE UPDATE OF id, account_id, run_id ON charts
WHEN NEW.id<>OLD.id
  OR NEW.account_id<>OLD.account_id
  OR (NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM chat_runs WHERE id=NEW.run_id AND account_id=NEW.account_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'chart tenant ownership mismatch');
END;

CREATE TRIGGER report_delete_cleanup
BEFORE DELETE ON reports
BEGIN
  INSERT INTO report_artifact_cleanup_jobs
    (report_id,account_id,run_id,html_path,pdf_path)
  VALUES (OLD.id,OLD.account_id,OLD.run_id,OLD.html_path,OLD.pdf_path)
  ON CONFLICT(report_id) DO NOTHING;
END;
`;

const SCHEMA_V3 = `
ALTER TABLE reports ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reports ADD COLUMN supersedes TEXT REFERENCES reports(id);
ALTER TABLE reports ADD COLUMN payload TEXT CHECK (payload IS NULL OR json_valid(payload));
CREATE INDEX reports_chat_published_idx
  ON reports (account_id, chat_id, version DESC)
  WHERE status='published' AND chat_id IS NOT NULL;
`;

const SCHEMA_V4 = `
ALTER TABLE users ADD COLUMN remote_egress_ack_at TEXT;
`;

const SCHEMA_V5 = `
CREATE TABLE libraries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, name)
) STRICT;

CREATE TABLE library_sources (
  library_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (library_id, source_id),
  FOREIGN KEY (library_id, account_id) REFERENCES libraries(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, account_id) REFERENCES sources(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX library_sources_source_idx ON library_sources (account_id, source_id);
`;

const migrations = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
  { version: 5, sql: SCHEMA_V5 },
] as const;

function schemaVersion(database: MigrationDatabase): number {
  const raw = database.pragma("user_version", { simple: true });
  const version = typeof raw === "bigint" ? Number(raw) : raw;
  if (!Number.isSafeInteger(version) || Number(version) < 0) {
    throw new SqliteMigrationError("SQLite returned an invalid schema version");
  }
  return Number(version);
}

export function migrateSqlite(database: MigrationDatabase): number {
  let current = schemaVersion(database);
  if (current > LATEST_SQLITE_SCHEMA_VERSION) {
    throw new SqliteMigrationError(
      `SQLite schema version ${current} is newer than supported version ${LATEST_SQLITE_SCHEMA_VERSION}`
    );
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    database.exec("BEGIN IMMEDIATE");
    let inTransaction = true;
    try {
      database.exec(migration.sql);
      database.pragma(`user_version = ${migration.version}`);
      database.exec("COMMIT");
      inTransaction = false;
      current = migration.version;
    } catch (error) {
      if (inTransaction) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the migration failure; close/reopen recovery is authoritative.
        }
      }
      throw new SqliteMigrationError(`failed to apply SQLite schema version ${migration.version}`, { cause: error });
    }
  }
  return current;
}
