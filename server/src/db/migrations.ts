import { SqliteMigrationError } from "./types.js";

export const LATEST_SQLITE_SCHEMA_VERSION = 25;

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

const SCHEMA_V6 = `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, name)
) STRICT;

CREATE TABLE agent_revisions (
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  account_id TEXT NOT NULL,
  instructions TEXT NOT NULL CHECK (length(instructions) >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (agent_id, version),
  FOREIGN KEY (agent_id, account_id) REFERENCES agents(id, account_id) ON DELETE CASCADE
) STRICT;

ALTER TABLE chats ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE chat_runs ADD COLUMN agent_instructions TEXT;
`;

const SCHEMA_V7 = `
CREATE TABLE egress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('consent_acknowledged','remote_turn','remote_ingest')),
  endpoint_host TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX egress_events_account_idx ON egress_events (account_id, created_at DESC);
`;

const SCHEMA_V8 = `
CREATE UNIQUE INDEX reports_id_account_uidx ON reports (id, account_id);

CREATE TABLE report_shares (
  report_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (report_id, recipient_account_id),
  FOREIGN KEY (report_id, owner_account_id) REFERENCES reports(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX report_shares_recipient_idx ON report_shares (recipient_account_id, shared_at DESC);
`;

const SCHEMA_V9 = `
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connector_sync','agent_turn')),
  target_id TEXT NOT NULL,
  prompt TEXT,
  schedule_minutes INTEGER NOT NULL CHECK (schedule_minutes BETWEEN 15 AND 10080),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, name)
) STRICT;

CREATE TABLE automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','skipped')),
  detail TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
) STRICT;
CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, started_at DESC);
`;

const SCHEMA_V10 = `
CREATE TABLE connector_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('create','manual','scheduled')),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','skipped')),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  FOREIGN KEY (connector_id, account_id) REFERENCES connectors(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX connector_syncs_connector_idx ON connector_syncs (connector_id, started_at DESC);
`;

const SCHEMA_V11 = `
ALTER TABLE users ADD COLUMN default_chat_model TEXT CHECK (default_chat_model IS NULL OR length(default_chat_model) <= 200);
`;

// Query-plan evidence for the catalog keysets showed tenant-index scans plus
// temporary ORDER BY trees for every catalog except chats. These indexes match
// the exact tenant/order tuples used by bounded pagination.
const SCHEMA_V12 = `
CREATE INDEX sources_account_catalog_idx ON sources (account_id, created_at DESC, id DESC);
CREATE INDEX connectors_account_catalog_idx ON connectors (account_id, created_at DESC, id DESC);
CREATE INDEX libraries_account_catalog_idx ON libraries (account_id, created_at DESC, id DESC);
CREATE INDEX agents_account_catalog_idx ON agents (account_id, created_at DESC, id DESC);
CREATE INDEX automations_account_catalog_idx ON automations (account_id, created_at DESC, id DESC);
CREATE INDEX reports_account_catalog_idx
  ON reports (account_id, created_at DESC, id DESC)
  WHERE status='published';
DROP INDEX report_shares_recipient_idx;
CREATE INDEX report_shares_recipient_idx
  ON report_shares (recipient_account_id, shared_at DESC, report_id DESC);
`;

// Agent editor ships before the previously reserved (unimplemented) remediation migrations.
const SCHEMA_V13 = `
ALTER TABLE agents ADD COLUMN configuration TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(configuration));
ALTER TABLE agent_revisions ADD COLUMN configuration TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(configuration));
ALTER TABLE chat_runs ADD COLUMN agent_tools TEXT CHECK(agent_tools IS NULL OR json_valid(agent_tools));
CREATE TABLE agent_skills (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=240),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 8000),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,name)
) STRICT;
CREATE INDEX agent_skills_account_idx ON agent_skills(account_id,name,id);
CREATE TABLE agent_skill_revisions (
  skill_id TEXT NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(skill_id,version)
) STRICT;
`;

// Provider-bound remote-egress consent. The nullable column stores only the
// canonical bare remote origin an account acknowledged, bounded to the Settings
// endpoint ceiling. The pre-v14 timestamp never identified a trustworthy
// destination, so no backfill runs: timestamp-only rows stay unacknowledged
// for every remote provider until the account consents again.
const SCHEMA_V14 = `
ALTER TABLE users ADD COLUMN remote_egress_ack_origin TEXT
  CHECK (remote_egress_ack_origin IS NULL OR length(remote_egress_ack_origin) <= 2048);
`;

// Automation target ownership becomes a database invariant. The unowned
// v9 `target_id` text is replaced by canonical kind-specific columns with
// composite same-account foreign keys, so connector/chat deletion cascades
// the bound automations and their run history instead of leaving a dangling
// schedule. The public `target_id` survives as a generated projection of
// the canonical columns. SQLite cannot add these composite keys in place,
// so both tables are rebuilt in one transaction without ever disabling
// foreign keys. Legacy migration policy: an automation is copied only when
// its kind-appropriate target exists under the same account; where v14
// allowed several otherwise-valid connector_sync rows for one connector,
// exactly one deterministic survivor per (account_id,target_id) is kept —
// the row ordered first by created_at DESC, id DESC, matching the
// connector-schedule read order — and every other duplicate plus its run
// history is dropped. Runs are copied only for surviving parents with a
// matching account. The old child table is dropped before the old parent;
// indexes are recreated after the rename.
const SCHEMA_V15 = `
CREATE TABLE automations_v15 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connector_sync','agent_turn')),
  connector_id TEXT,
  chat_id TEXT,
  target_id TEXT GENERATED ALWAYS AS (coalesce(connector_id, chat_id)) VIRTUAL,
  prompt TEXT,
  schedule_minutes INTEGER NOT NULL CHECK (schedule_minutes BETWEEN 15 AND 10080),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, name),
  UNIQUE (id, account_id),
  CHECK (
    (kind = 'connector_sync' AND connector_id IS NOT NULL AND chat_id IS NULL)
    OR (kind = 'agent_turn' AND chat_id IS NOT NULL AND connector_id IS NULL)
  ),
  FOREIGN KEY (connector_id, account_id) REFERENCES connectors(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, account_id) REFERENCES chats(id, account_id) ON DELETE CASCADE
) STRICT;

INSERT INTO automations_v15 (
  id,account_id,name,kind,connector_id,chat_id,prompt,schedule_minutes,
  state,consecutive_failures,last_run_at,next_run_at,created_at,updated_at
)
SELECT
  a.id,a.account_id,a.name,a.kind,
  CASE WHEN a.kind='connector_sync' THEN a.target_id END,
  CASE WHEN a.kind='agent_turn' THEN a.target_id END,
  a.prompt,a.schedule_minutes,a.state,a.consecutive_failures,a.last_run_at,a.next_run_at,a.created_at,a.updated_at
FROM automations a
WHERE
  (
    a.kind='connector_sync'
    AND EXISTS (
      SELECT 1 FROM connectors c WHERE c.id=a.target_id AND c.account_id=a.account_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM automations newer
      WHERE newer.account_id=a.account_id
        AND newer.kind='connector_sync'
        AND newer.target_id=a.target_id
        AND (newer.created_at,newer.id) > (a.created_at,a.id)
    )
  )
  OR (
    a.kind='agent_turn'
    AND EXISTS (
      SELECT 1 FROM chats h WHERE h.id=a.target_id AND h.account_id=a.account_id
    )
  );

ALTER TABLE automations RENAME TO automations_pre_v15;
ALTER TABLE automations_v15 RENAME TO automations;

CREATE TABLE automation_runs_v15 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','skipped')),
  detail TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  FOREIGN KEY (automation_id, account_id) REFERENCES automations(id, account_id) ON DELETE CASCADE
) STRICT;

INSERT INTO automation_runs_v15 (id,automation_id,account_id,outcome,detail,started_at,finished_at)
SELECT r.id,r.automation_id,r.account_id,r.outcome,r.detail,r.started_at,r.finished_at
FROM automation_runs r
WHERE EXISTS (
  SELECT 1 FROM automations a WHERE a.id=r.automation_id AND a.account_id=r.account_id
)
ORDER BY r.id;

DROP TABLE automation_runs;
DROP TABLE automations_pre_v15;
ALTER TABLE automation_runs_v15 RENAME TO automation_runs;

CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, started_at DESC);
CREATE INDEX automations_account_catalog_idx ON automations (account_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX automations_connector_target_uidx ON automations (account_id, connector_id) WHERE connector_id IS NOT NULL;
`;

// Schema v16 gives the connector-refresh protocol one constrained durable row
// per connector-backed source. The three-column source/connector/account
// foreign key (backed by the unique parent index below) is load-bearing: two
// connectors in one account may never be paired with each other's source,
// including through direct SQL. The `repair_ordinal` AUTOINCREMENT column is
// the immutable startup keyset order; the `(attempts, updated_at, source_id)`
// index is the periodic fairness order. The legacy backfill classifies every
// protocol-key combination in `sources.meta` in this same transaction: an
// unclassifiable combination makes the phase CHECK fail, which aborts and
// rolls back v16 (`user_version` stays 15). Only after every insert succeeds
// does `json_remove` strip exactly the four protocol keys; every other meta
// key — especially the bounded error/display metadata — is preserved.
const SCHEMA_V16 = `
CREATE UNIQUE INDEX sources_id_connector_account_uidx ON sources(id, connector, account_id);

CREATE TABLE connector_refresh_states (
  repair_ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  refresh_version TEXT NOT NULL CHECK (length(refresh_version) BETWEEN 1 AND 512),
  phase TEXT NOT NULL CHECK (phase IN ('preparing','prepared','activating','activated','cleanup_pending')),
  candidate_location TEXT CHECK (candidate_location IS NULL OR length(candidate_location) BETWEEN 1 AND 32768),
  activation_previous_location TEXT CHECK (activation_previous_location IS NULL OR length(activation_previous_location) BETWEEN 1 AND 32768),
  cleanup_previous_location TEXT CHECK (cleanup_previous_location IS NULL OR length(cleanup_previous_location) BETWEEN 1 AND 32768),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (phase <> 'preparing' OR candidate_location IS NULL),
  CHECK (phase = 'preparing' OR candidate_location IS NOT NULL),
  CHECK (phase <> 'preparing' OR (activation_previous_location IS NULL AND cleanup_previous_location IS NULL)),
  CHECK (phase <> 'cleanup_pending' OR activation_previous_location IS NULL),
  CHECK (phase <> 'cleanup_pending' OR (cleanup_previous_location IS NOT NULL AND cleanup_previous_location <> candidate_location)),
  CHECK (cleanup_previous_location IS NULL OR cleanup_previous_location <> candidate_location),
  FOREIGN KEY (source_id, connector_id, account_id) REFERENCES sources(id, connector, account_id) ON DELETE CASCADE,
  FOREIGN KEY (connector_id, account_id) REFERENCES connectors(id, account_id) ON DELETE CASCADE
) STRICT;

WITH protocol_rows AS (
  SELECT
    s.id AS source_id,
    s.account_id AS account_id,
    s.connector AS connector,
    s.status AS source_status,
    s.file_path AS file_path,
    s.ready_generation AS ready_generation,
    j.status AS job_status,
    j.generation AS job_generation,
    json_type(s.meta,'$.connector_refresh_version') AS version_type,
    json_type(s.meta,'$.connector_candidate_location') AS candidate_type,
    json_type(s.meta,'$.connector_activation_previous_location') AS activation_type,
    json_type(s.meta,'$.connector_previous_location') AS cleanup_type,
    json_extract(s.meta,'$.connector_refresh_version') AS version_value,
    json_extract(s.meta,'$.connector_candidate_location') AS candidate_value,
    json_extract(s.meta,'$.connector_activation_previous_location') AS activation_value,
    json_extract(s.meta,'$.connector_previous_location') AS cleanup_value
  FROM sources s
  LEFT JOIN ingestion_jobs j ON j.source_id=s.id AND j.account_id=s.account_id
  WHERE json_type(s.meta,'$.connector_refresh_version') IS NOT NULL
     OR json_type(s.meta,'$.connector_candidate_location') IS NOT NULL
     OR json_type(s.meta,'$.connector_activation_previous_location') IS NOT NULL
     OR json_type(s.meta,'$.connector_previous_location') IS NOT NULL
),
classified AS (
  SELECT r.*,
    CASE
      WHEN NOT (
        (r.version_type IS NULL OR (r.version_type='text' AND r.version_value<>''))
        AND (r.candidate_type IS NULL OR (r.candidate_type='text' AND r.candidate_value<>''))
        AND (r.activation_type IS NULL OR r.activation_type='null' OR (r.activation_type='text' AND r.activation_value<>''))
        AND (r.cleanup_type IS NULL OR (r.cleanup_type='text' AND r.cleanup_value<>''))
      ) THEN 'invalid'
      WHEN r.version_type IS NOT NULL AND r.candidate_type IS NULL
           AND r.activation_type IS NULL AND r.cleanup_type IS NULL
      THEN CASE
        WHEN r.connector IS NOT NULL AND r.source_status='index'
             AND r.job_status='preparing' AND r.job_generation >= 1
        THEN 'preparing' ELSE 'invalid' END
      WHEN r.version_type IS NOT NULL AND r.candidate_type IS NOT NULL
      THEN CASE
        WHEN r.connector IS NOT NULL AND r.job_status IN ('pending','running','error')
             AND r.job_generation >= 1
             AND (r.cleanup_type IS NULL OR r.cleanup_value <> r.candidate_value)
        THEN 'activating' ELSE 'invalid' END
      WHEN r.version_type IS NULL AND r.candidate_type IS NULL AND r.activation_type IS NULL
           AND r.cleanup_type IS NOT NULL
      THEN CASE
        WHEN r.connector IS NOT NULL AND r.source_status='ready'
             AND r.ready_generation >= 1 AND r.file_path IS NOT NULL
             AND r.cleanup_value <> r.file_path
        THEN 'cleanup_pending' ELSE 'invalid' END
      ELSE 'invalid'
    END AS resolved_phase
  FROM protocol_rows r
)
INSERT INTO connector_refresh_states (
  source_id,account_id,connector_id,generation,refresh_version,phase,
  candidate_location,activation_previous_location,cleanup_previous_location
)
SELECT
  c.source_id,c.account_id,c.connector,
  CASE WHEN c.resolved_phase='cleanup_pending' THEN c.ready_generation ELSE c.job_generation END,
  CASE WHEN c.resolved_phase='cleanup_pending' THEN 'legacy:' || c.source_id ELSE c.version_value END,
  c.resolved_phase,
  CASE WHEN c.resolved_phase='preparing' THEN NULL
       WHEN c.resolved_phase='cleanup_pending' THEN c.file_path
       ELSE c.candidate_value END,
  CASE WHEN c.resolved_phase='activating' THEN c.activation_value ELSE NULL END,
  CASE WHEN c.resolved_phase IN ('activating','cleanup_pending') THEN c.cleanup_value ELSE NULL END
FROM classified c;

UPDATE sources
   SET meta=json_remove(meta,
     '$.connector_refresh_version',
     '$.connector_candidate_location',
     '$.connector_activation_previous_location',
     '$.connector_previous_location')
 WHERE json_type(meta,'$.connector_refresh_version') IS NOT NULL
    OR json_type(meta,'$.connector_candidate_location') IS NOT NULL
    OR json_type(meta,'$.connector_activation_previous_location') IS NOT NULL
    OR json_type(meta,'$.connector_previous_location') IS NOT NULL;

CREATE INDEX connector_refresh_states_repair_idx ON connector_refresh_states (attempts, updated_at, source_id);
CREATE INDEX pending_source_deletes_periodic_idx ON pending_source_deletes (attempts, updated_at, account_id, source_id);
CREATE INDEX pending_vector_ops_periodic_idx ON pending_vector_ops (attempts, updated_at, source_id, operation, generation);
CREATE INDEX dataset_cache_cleanup_jobs_periodic_idx ON dataset_cache_cleanup_jobs (attempts, updated_at, account_id, name, location);
`;

// Schema v17 introduces Connected agents: account-scoped MCP connection
// records and their published tool-discovery snapshots. `config` holds only
// validated non-secret JSON (the strict kind-specific shape is owned by the
// connection store); credential material lives outside the ledger in the
// connection secret store and is never serialized into these rows. `kind` is
// constrained to the two transports this wave implements; the webdav adapter
// reserved for M14 arrives with its own migration widening this CHECK, so the
// existing rows stay strict in the meantime. `revision` is the optimistic
// edit counter (stale expected revisions conflict in the store);
// `discovery_revision` advances only when a validated tool snapshot is
// published, and `connection_tool_snapshots` always holds exactly the current
// published discovery. Per-descriptor and aggregate discovery budgets are
// enforced by the store before any write; the CHECK bounds below are the
// last-line durable guard. Deleting a connection cascades its snapshots;
// account deletion cascades both tables.
const SCHEMA_V17 = `
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('mcp_http','mcp_stdio')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  discovery_revision INTEGER NOT NULL DEFAULT 0 CHECK (discovery_revision >= 0),
  config TEXT NOT NULL CHECK (json_valid(config)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  status TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','ready','disconnected','error')),
  status_code TEXT CHECK (status_code IS NULL OR length(status_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, name)
) STRICT;

CREATE INDEX connections_account_catalog_idx ON connections (account_id, created_at DESC, id DESC);

CREATE TABLE connection_tool_snapshots (
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  discovery_revision INTEGER NOT NULL CHECK (discovery_revision >= 1),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 199),
  tool_id TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 8192),
  input_schema TEXT NOT NULL CHECK (json_valid(input_schema) AND length(input_schema) <= 16384),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (connection_id, discovery_revision, position),
  UNIQUE (connection_id, discovery_revision, name),
  FOREIGN KEY (connection_id, account_id) REFERENCES connections(id, account_id) ON DELETE CASCADE
) STRICT;
`;

// Schema v18 — saved analyses (M12). Six owner-scoped tables plus one
// capture table. Definitions are optimistic-revisioned heads (analyses) over
// immutable full-content revisions (analysis_revisions); the explicit selected
// source set is bound in analysis_sources, which stores the source ID, the
// ready generation and content identity captured at bind time, and an
// unavailable marker set exactly once by the AFTER DELETE trigger below when
// the source row goes away through any path (route, connector cascade,
// startup repair, or account cascade). Frozen run provenance
// (analysis_run_sources) references only its own run — never the mutable
// sources table — so deleting a source can never retarget an accepted run.
// analysis_runs is one-active-run-per-analysis via the partial unique index;
// the second partial unique index makes client operation UUIDs idempotent
// per (account, analysis). analysis_results carries one immutable bounded
// result per successful run (worker ceilings preserved, 500 rows / 64
// columns / 20k cells enforced by the store; the row-payload CHECK bounds
// characters — the store enforces the stricter 1 MiB UTF-8 byte ceiling).
// query_captures persists full executable SQL (never sliced receipt text)
// tied to a completed chat run; it cascades with that run, while analysis
// origin links are opaque text so a deleted chat never removes an analysis.
export const SCHEMA_V18 = `
CREATE TABLE analyses (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id)
) STRICT;
CREATE INDEX analyses_account_catalog_idx ON analyses (account_id, created_at DESC, id DESC);

CREATE TABLE analysis_revisions (
  analysis_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  account_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  sql TEXT NOT NULL CHECK (length(sql) BETWEEN 1 AND 20000),
  parameters TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(parameters)='array' AND json_array_length(parameters) <= 20),
  source_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(source_ids)='array' AND json_array_length(source_ids) <= 100),
  comparison_key TEXT
    CHECK (comparison_key IS NULL
      OR (json_type(comparison_key)='array' AND json_array_length(comparison_key) BETWEEN 1 AND 3)),
  origin_chat_id TEXT CHECK (origin_chat_id IS NULL OR length(origin_chat_id) <= 256),
  origin_run_id TEXT CHECK (origin_run_id IS NULL OR length(origin_run_id) <= 256),
  origin_capture_id TEXT CHECK (origin_capture_id IS NULL OR length(origin_capture_id) <= 256),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (analysis_id, revision),
  FOREIGN KEY (analysis_id, account_id) REFERENCES analyses(id, account_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE analysis_sources (
  analysis_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  ready_generation INTEGER CHECK (ready_generation IS NULL OR ready_generation >= 0),
  content_identity TEXT CHECK (content_identity IS NULL OR length(content_identity) BETWEEN 1 AND 33000),
  unavailable_at TEXT CHECK (unavailable_at IS NULL OR length(unavailable_at) = 24),
  bound_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (analysis_id, source_id),
  FOREIGN KEY (analysis_id, account_id) REFERENCES analyses(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX analysis_sources_source_idx ON analysis_sources (account_id, source_id, analysis_id);

CREATE TRIGGER analysis_sources_mark_unavailable_on_source_delete
AFTER DELETE ON sources
BEGIN
  UPDATE analysis_sources
     SET unavailable_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE source_id = OLD.id AND unavailable_at IS NULL;
END;

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analysis_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled','stale-inputs')),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) <= 64),
  parameter_values TEXT NOT NULL DEFAULT '{}'
    CHECK (json_type(parameter_values)='array' AND json_array_length(parameter_values) <= 20),
  schema_fingerprint TEXT CHECK (schema_fingerprint IS NULL OR length(schema_fingerprint) <= 512),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 128),
  error_reason TEXT CHECK (error_reason IS NULL OR length(error_reason) <= 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (id, account_id),
  FOREIGN KEY (analysis_id, account_id) REFERENCES analyses(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX analysis_runs_one_active_uidx
  ON analysis_runs (analysis_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX analysis_runs_operation_uidx
  ON analysis_runs (account_id, analysis_id, operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX analysis_runs_analysis_activity_idx ON analysis_runs (analysis_id, created_at DESC, id DESC);

CREATE TABLE analysis_run_sources (
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  ready_generation INTEGER NOT NULL CHECK (ready_generation >= 0),
  content_identity TEXT NOT NULL CHECK (length(content_identity) BETWEEN 1 AND 33000),
  PRIMARY KEY (run_id, source_id),
  FOREIGN KEY (run_id, account_id) REFERENCES analysis_runs(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX analysis_run_sources_source_idx ON analysis_run_sources (account_id, source_id, run_id);

CREATE TABLE analysis_results (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analysis_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  columns TEXT NOT NULL
    CHECK (json_type(columns)='array' AND json_array_length(columns) BETWEEN 0 AND 64),
  rows TEXT NOT NULL
    CHECK (json_type(rows)='array' AND json_array_length(rows) <= 500 AND length(rows) <= 1048576),
  returned_rows INTEGER NOT NULL CHECK (returned_rows BETWEEN 0 AND 500),
  source_row_total INTEGER CHECK (source_row_total IS NULL OR source_row_total >= 0),
  row_count_exact INTEGER NOT NULL DEFAULT 0 CHECK (row_count_exact IN (0,1)),
  completeness TEXT NOT NULL DEFAULT '{"complete":true,"reasons":[]}' CHECK (json_valid(completeness)),
  parameter_values TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(parameter_values)='array' AND json_array_length(parameter_values) <= 20),
  source_provenance TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(source_provenance)='array' AND json_array_length(source_provenance) <= 100),
  schema_fingerprint TEXT CHECK (schema_fingerprint IS NULL OR length(schema_fingerprint) <= 512),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  FOREIGN KEY (analysis_id, account_id) REFERENCES analyses(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, account_id) REFERENCES analysis_runs(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX analysis_results_analysis_activity_idx
  ON analysis_results (analysis_id, created_at DESC, id DESC);

CREATE TABLE query_captures (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  sql TEXT NOT NULL CHECK (length(sql) BETWEEN 1 AND 20000),
  sources TEXT NOT NULL
    CHECK (json_type(sources)='array' AND json_array_length(sources) <= 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  FOREIGN KEY (run_id, account_id) REFERENCES chat_runs(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX query_captures_run_idx ON query_captures (account_id, run_id, id);
`;

// Schema v20 — editable documents (M13 stage 1). Contiguous after the
// coordinator merge: v19 (knowledge ledger) precedes this entry in the
// ordered migration array.
//
// Owner-scoped documents are stable identities distinct from legacy report
// rows. `documents.current_revision` is the head counter (optimistic CAS like
// `analyses`); every `document_revisions` row is an immutable full snapshot
// with its own UUID, a `base_revision_id` provenance link, and the frozen
// tree payload — the 400,000-character CHECK is the durable last line for the
// store's evidence-inclusive budget (`documentTypes.ts` rejects oversize
// edits before the transaction). The immutability triggers make raw UPDATE
// statements on revisions and publications fail closed; the revision DELETE
// path is store-only via cascade from the parent document (foreign-key
// actions do not fire triggers while `recursive_triggers` stays off). Origin
// links are opaque bounded text — never foreign keys — so report/chat/run/
// analysis deletion can never rewrite or remove a copied document.
// `document_publications` freezes one immutable version row per publication
// (title, rendered paths, supersedes chain) with versions assigned only by
// the store's completion transaction after required artifacts exist;
// `document_publication_intents` carries the render protocol: one active
// intent per document (partial unique index), idempotent operation UUIDs, and
// crash-recoverable status. Both cleanup tables follow the v2/v16
// durable-intent pattern: the document deletion trigger reserves filesystem
// work before the row vanishes, and interrupted renders queue exact-directory
// cleanup with the fairness order. Retention: unlimited revisions per
// document at these bounds — no count quota is enforced or reserved.
export const SCHEMA_V20 = `
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  origin_report_id TEXT CHECK (origin_report_id IS NULL OR length(origin_report_id) <= 256),
  origin_chat_id TEXT CHECK (origin_chat_id IS NULL OR length(origin_chat_id) <= 256),
  origin_run_id TEXT CHECK (origin_run_id IS NULL OR length(origin_run_id) <= 256),
  origin_analysis_result_id TEXT
    CHECK (origin_analysis_result_id IS NULL OR length(origin_analysis_result_id) <= 256),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id)
) STRICT;
CREATE INDEX documents_account_catalog_idx ON documents (account_id, created_at DESC, id DESC);

CREATE TABLE document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  account_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(payload) BETWEEN 1 AND 400000),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','model','automation')),
  base_revision_id TEXT REFERENCES document_revisions(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (document_id, revision),
  UNIQUE (id, account_id),
  FOREIGN KEY (document_id, account_id) REFERENCES documents(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX document_revisions_document_idx ON document_revisions (document_id, revision DESC);

CREATE TRIGGER document_revisions_no_update
BEFORE UPDATE ON document_revisions
BEGIN
  SELECT RAISE(ABORT, 'document revisions are immutable');
END;

CREATE TABLE document_publications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  version INTEGER NOT NULL CHECK (version >= 1),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  supersedes TEXT REFERENCES document_publications(id),
  html_path TEXT NOT NULL CHECK (length(html_path) BETWEEN 1 AND 32768),
  pdf_path TEXT NOT NULL CHECK (length(pdf_path) BETWEEN 1 AND 32768),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (document_id, version),
  UNIQUE (id, account_id),
  FOREIGN KEY (document_id, account_id) REFERENCES documents(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (revision_id, account_id) REFERENCES document_revisions(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX document_publications_document_activity_idx
  ON document_publications (document_id, version DESC);

CREATE TRIGGER document_publications_no_update
BEFORE UPDATE ON document_publications
BEGIN
  SELECT RAISE(ABORT, 'document publications are immutable');
END;

CREATE TABLE document_publication_intents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 64),
  explicit_revision_selection INTEGER NOT NULL DEFAULT 0 CHECK (explicit_revision_selection IN (0,1)),
  status TEXT NOT NULL DEFAULT 'rendering'
    CHECK (status IN ('rendering','ready','completed','failed')),
  artifact_directory TEXT NOT NULL CHECK (length(artifact_directory) BETWEEN 1 AND 32768),
  html_path TEXT CHECK (html_path IS NULL OR length(html_path) BETWEEN 1 AND 32768),
  pdf_path TEXT CHECK (pdf_path IS NULL OR length(pdf_path) BETWEEN 1 AND 32768),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  error_reason TEXT CHECK (error_reason IS NULL OR length(error_reason) <= 500),
  publication_id TEXT REFERENCES document_publications(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, document_id, operation_id),
  FOREIGN KEY (document_id, account_id) REFERENCES documents(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (revision_id, account_id) REFERENCES document_revisions(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX document_publication_intents_one_active_uidx
  ON document_publication_intents (document_id) WHERE status IN ('rendering','ready');
CREATE INDEX document_publication_intents_repair_idx
  ON document_publication_intents (status, updated_at, id);

CREATE TABLE document_artifact_cleanup_jobs (
  document_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX document_artifact_cleanup_jobs_retry_idx
  ON document_artifact_cleanup_jobs (attempts, updated_at, document_id);

CREATE TRIGGER document_delete_cleanup
BEFORE DELETE ON documents
BEGIN
  INSERT INTO document_artifact_cleanup_jobs (document_id,account_id)
  VALUES (OLD.id,OLD.account_id)
  ON CONFLICT(document_id) DO NOTHING;
END;

CREATE TABLE document_publication_cleanup_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  artifact_directory TEXT NOT NULL CHECK (length(artifact_directory) BETWEEN 1 AND 32768),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX document_publication_cleanup_jobs_retry_idx
  ON document_publication_cleanup_jobs (attempts, updated_at, id);
`;

// Schema v19 — living knowledge libraries (M14 stage 1). A refreshable
// knowledge connection is a desktop folder or a read-only WebDAV collection
// bound to one account and one target library. WebDAV credentials never
// enter this ledger: `credential_configured` is the only public boolean, and
// the material itself lives in the shared connection secret store keyed by
// the same account/connection pair (the v17 MCP custody mechanism, reused —
// never a second secret store).
//
// Identity invariants the schema encodes: a managed item is exactly
// `(account_id, connection_id, normalized relative_path)` with one stable
// `source_id` — content never identifies an item, so a rename is a missing
// old path plus a new path and same-path replacement reuses the source
// (UNIQUE (account_id, connection_id, source_id) keeps the mapping 1:1).
// mtime/size/etag columns are bounded hints only; the 64-character lowercase
// SHA-256 `content_hash` alone decides unchanged. Item lifecycle is explicit:
// `active`, `missing_upstream` (retained with last ready content and the
// stale label), or `removed` by the explicit remove-from-library action.
//
// Previews are durable bounded scans: absolute scan/selection budgets live
// in CHECKs (1000 entries, 10 levels, 1000 visited, 100 MiB), each entry
// carries a deterministic selection token, and the preview revision is the
// optimistic apply target — a stale manifest never activates anything.
// Refreshes are durable committed work: at most one active refresh per
// connection (partial unique index), per-item retry state with generation
// CAS (expected vs promoted generation) so recovery restarts only
// incomplete items without duplicate promotion, and history retained to the
// newest runs per connection by the store. Deleting a connection cascades
// these mappings only — sources, library membership, reports, and evidence
// are never touched here, and chat scope tables are not referenced at all.
export const SCHEMA_V19 = `
CREATE TABLE knowledge_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('desktop_folder','webdav')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  config TEXT NOT NULL
    CHECK (json_valid(config) AND json_type(config)='object' AND length(config) <= 8192),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  watch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (watch_enabled IN (0,1)),
  credential_configured INTEGER NOT NULL DEFAULT 0 CHECK (credential_configured IN (0,1)),
  status TEXT NOT NULL DEFAULT 'untested'
    CHECK (status IN ('untested','ready','disconnected','error')),
  status_code TEXT CHECK (status_code IS NULL OR length(status_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, name),
  CHECK (kind <> 'desktop_folder' OR credential_configured = 0),
  FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX knowledge_connections_account_catalog_idx
  ON knowledge_connections (account_id, created_at DESC, id DESC);

CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  relative_path TEXT NOT NULL
    CHECK (
      length(relative_path) BETWEEN 1 AND 1024
      AND relative_path NOT GLOB '/*'
      AND relative_path NOT GLOB '*/'
      AND relative_path NOT GLOB '..*'
      AND relative_path NOT GLOB '*..'
      AND relative_path NOT GLOB '*/../*'
      AND relative_path NOT GLOB '*//*'
      AND relative_path = trim(relative_path)
    ),
  source_id TEXT NOT NULL,
  content_hash TEXT NOT NULL
    CHECK (length(content_hash) = 64 AND content_hash = lower(content_hash) AND content_hash GLOB '[0-9a-f]*'),
  ingested_hash TEXT
    CHECK (ingested_hash IS NULL OR (length(ingested_hash) = 64 AND ingested_hash = lower(ingested_hash) AND ingested_hash GLOB '[0-9a-f]*')),
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  lifecycle TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle IN ('active','missing_upstream','removed')),
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  mtime_hint TEXT CHECK (mtime_hint IS NULL OR length(mtime_hint) BETWEEN 1 AND 128),
  etag_hint TEXT CHECK (etag_hint IS NULL OR length(etag_hint) BETWEEN 1 AND 512),
  last_refreshed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, connection_id, relative_path),
  UNIQUE (account_id, connection_id, source_id),
  CHECK (stale = 0 OR lifecycle = 'missing_upstream'),
  FOREIGN KEY (connection_id, account_id) REFERENCES knowledge_connections(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, account_id) REFERENCES sources(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX knowledge_items_connection_catalog_idx
  ON knowledge_items (account_id, connection_id, created_at DESC, id DESC);

CREATE TABLE knowledge_previews (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','complete','failed','applied','expired')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  scan_limit_entries INTEGER NOT NULL CHECK (scan_limit_entries BETWEEN 1 AND 1000),
  scan_limit_depth INTEGER NOT NULL CHECK (scan_limit_depth BETWEEN 1 AND 10),
  scan_limit_visited INTEGER NOT NULL CHECK (scan_limit_visited BETWEEN 1 AND 1000),
  scan_limit_bytes INTEGER NOT NULL CHECK (scan_limit_bytes BETWEEN 1 AND 104857600),
  visited_entries INTEGER NOT NULL DEFAULT 0 CHECK (visited_entries BETWEEN 0 AND 1000),
  directories INTEGER NOT NULL DEFAULT 0 CHECK (directories BETWEEN 0 AND 10),
  aggregate_bytes INTEGER NOT NULL DEFAULT 0 CHECK (aggregate_bytes BETWEEN 0 AND 104857600),
  new_count INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  changed_count INTEGER NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  unsupported_count INTEGER NOT NULL DEFAULT 0 CHECK (unsupported_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  CHECK (status <> 'applied' OR applied_at IS NOT NULL),
  UNIQUE (id, account_id),
  FOREIGN KEY (connection_id, account_id) REFERENCES knowledge_connections(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX knowledge_previews_connection_catalog_idx
  ON knowledge_previews (account_id, connection_id, created_at DESC, id DESC);

CREATE TABLE knowledge_preview_entries (
  preview_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entry_id TEXT NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 64),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 999),
  relative_path TEXT NOT NULL
    CHECK (
      length(relative_path) BETWEEN 1 AND 1024
      AND relative_path NOT GLOB '/*'
      AND relative_path NOT GLOB '*/'
      AND relative_path NOT GLOB '..*'
      AND relative_path NOT GLOB '*..'
      AND relative_path NOT GLOB '*/../*'
      AND relative_path NOT GLOB '*//*'
      AND relative_path = trim(relative_path)
    ),
  classification TEXT NOT NULL
    CHECK (classification IN ('new','changed','unchanged','duplicate','missing','unsupported')),
  content_hash TEXT CHECK (content_hash IS NULL OR (length(content_hash) = 64 AND content_hash = lower(content_hash) AND content_hash GLOB '[0-9a-f]*')),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes BETWEEN 0 AND 104857600),
  existing_source_id TEXT,
  mtime_hint TEXT CHECK (mtime_hint IS NULL OR length(mtime_hint) BETWEEN 1 AND 128),
  etag_hint TEXT CHECK (etag_hint IS NULL OR length(etag_hint) BETWEEN 1 AND 512),
  selection_token TEXT NOT NULL CHECK (length(selection_token) = 64 AND selection_token = lower(selection_token)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (preview_id, entry_id),
  UNIQUE (preview_id, ordinal),
  UNIQUE (preview_id, relative_path),
  CHECK (classification <> 'unsupported' OR content_hash IS NULL),
  FOREIGN KEY (preview_id, account_id) REFERENCES knowledge_previews(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (existing_source_id) REFERENCES sources(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE knowledge_refreshes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  requested_by TEXT NOT NULL DEFAULT 'manual'
    CHECK (requested_by IN ('manual','apply','scheduled')),
  expected_connection_revision INTEGER NOT NULL CHECK (expected_connection_revision >= 1),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','partial','failed','cancelled')),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  UNIQUE (id, account_id),
  CHECK (status = 'active' OR finished_at IS NOT NULL),
  FOREIGN KEY (connection_id, account_id) REFERENCES knowledge_connections(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX knowledge_refreshes_one_active_uidx
  ON knowledge_refreshes (connection_id) WHERE status='active';
CREATE INDEX knowledge_refreshes_connection_history_idx
  ON knowledge_refreshes (account_id, connection_id, created_at DESC, id DESC);

CREATE TABLE knowledge_refresh_items (
  refresh_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relative_path TEXT NOT NULL
    CHECK (
      length(relative_path) BETWEEN 1 AND 1024
      AND relative_path NOT GLOB '/*'
      AND relative_path NOT GLOB '*/'
      AND relative_path NOT GLOB '..*'
      AND relative_path NOT GLOB '*..'
      AND relative_path NOT GLOB '*/../*'
      AND relative_path NOT GLOB '*//*'
      AND relative_path = trim(relative_path)
    ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','staged','committed','ready','unchanged','missing','failed','blocked','cancelled')),
  target_hash TEXT CHECK (target_hash IS NULL OR (length(target_hash) = 64 AND target_hash = lower(target_hash) AND target_hash GLOB '[0-9a-f]*')),
  candidate_path TEXT CHECK (candidate_path IS NULL OR length(candidate_path) BETWEEN 1 AND 32768),
  candidate_size_bytes INTEGER CHECK (candidate_size_bytes IS NULL OR candidate_size_bytes >= 0),
  current_ready_generation INTEGER CHECK (current_ready_generation IS NULL OR current_ready_generation >= 0),
  expected_generation INTEGER CHECK (expected_generation IS NULL OR expected_generation >= 1),
  promoted_generation INTEGER CHECK (promoted_generation IS NULL OR promoted_generation >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 32),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (refresh_id, item_id),
  CHECK (status NOT IN ('committed','ready') OR expected_generation IS NOT NULL),
  CHECK (status <> 'ready' OR promoted_generation IS NOT NULL),
  CHECK (candidate_size_bytes IS NULL OR target_hash IS NOT NULL),
  FOREIGN KEY (refresh_id, account_id) REFERENCES knowledge_refreshes(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (item_id, account_id) REFERENCES knowledge_items(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX knowledge_refresh_items_recovery_idx
  ON knowledge_refresh_items (updated_at, refresh_id, item_id)
  WHERE status IN ('pending','staged','committed');
CREATE INDEX knowledge_refresh_items_connection_idx
  ON knowledge_refresh_items (account_id, connection_id, refresh_id, item_id);
`;

// Schema v21 — Connected agents stage 4. `chat_runs.agent_mcp_tools` stores the
// frozen per-run MCP tool mapping captured atomically with turn acceptance
// (JSON array of {alias, connection_id, tool_id, discovery_revision, name,
// description, input_schema, authorization_reference}). Credential material
// never enters this column: the authorization entry is the non-secret
// custody reference (`absent` / `oauth:<digest>` / `secret:<digest>`), checked
// against live custody before every dispatch. The aggregate CHECK is the
// durable last-line budget; the store enforces the stricter
// MAX_RUN_MCP_SNAPSHOT_CHARS before any write. The column is append-only and
// rides the existing chat_runs cascades — deleting a chat or account removes
// the snapshot with the run, and no MCP state survives anywhere else in the
// ledger. The schema v19 slot is the parallel M14 branch (pending merge,
// never applied after this entry); this migration is append-only and never
// depends on it.
export const SCHEMA_V21 = `
ALTER TABLE chat_runs ADD COLUMN agent_mcp_tools TEXT
  CHECK (agent_mcp_tools IS NULL OR (json_valid(agent_mcp_tools) AND length(agent_mcp_tools) <= 524288));
`;

// Schema v22 — reusable document templates (coordinator re-keyed from v21; v21 = MCP run snapshot) (M13 stage 2). Owner-scoped rows
// beside the v20 document ledger: a template stores one immutable-by-policy
// normalized structure snapshot (headings, bounded instructions, formatting,
// and empty placeholders) captured by the `documentTemplates.ts` codec, which
// strips source excerpts, table results, chart values, credentials, analysis
// provenance, and source bindings before anything reaches this table. The
// `snapshot` CHECK applies the same 400,000-character document revision bound
// as the last-line durable guard; the store enforces the 100-per-account
// quota and the per-name uniqueness inside the same transaction. `revision`
// is the optimistic edit counter (stale `expected_revision` conflicts in the
// store). Snapshots are ordinary rows — updates are allowed here (unlike the
// immutable v20 revision/publication ledgers) because a template is a
// mutable catalog entry, not durable document history. Account deletion
// cascades; built-in templates are server constants and never stored rows.
export const SCHEMA_V22 = `
CREATE TABLE document_templates (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot) AND length(snapshot) BETWEEN 1 AND 400000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, name)
) STRICT;
CREATE INDEX document_templates_account_catalog_idx ON document_templates (account_id, created_at DESC, id DESC);
`;

// Schema v23 — model-assisted document rewrites (M13 stage 3). `document_rewrites`
// is the durable operation ledger for "rewrite selection": one row per request
// with the exact owner/document/base-revision/section target, the optional
// UTF-16 selection range, the SHA-256 of the selected text as it existed in the
// base revision, and the bounded instruction (≤2,000 characters — the durable
// last line; the route schema and store enforce the same bound). Selection is
// bounded at 8,000 characters (whole-section requests over that bound are
// rejected before any write), and the proposed replacement at 20,000.
// Lifecycle: `queued → running → completed|failed|cancelled`, plus `stale` —
// a completed proposal whose acceptance was rejected because the head moved or
// the selection no longer matches; stale rows stay inspectable forever and are
// never auto-applied. One active (queued/running) rewrite per document is
// enforced by the partial unique index; retained proposals per document are
// bounded at 100 by the store, with explicit row deletion at quota (no trigger
// deletes proposals implicitly — a retained proposal only vanishes when the
// owner deletes it or the document cascades). Acceptance records
// `applied_revision_id` inside the same transaction that appends the
// model-authored revision, making apply one-shot without widening the status
// enum; re-acceptance fails closed. Cancellation and restart never leave a
// half-applied rewrite: `running` rows recover as `failed` with a generic
// error and the provider call is never replayed. Evidence references copied
// from the base revision ride `evidence_refs` as a bounded JSON array of the
// revision's own document-local evidence UUIDs. Instructions, selections, and
// replacements are content that must never reach logs.
export const SCHEMA_V23 = `
CREATE TABLE document_rewrites (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  section_id TEXT NOT NULL CHECK (length(section_id) BETWEEN 36 AND 64),
  range_start INTEGER CHECK (range_start IS NULL OR range_start >= 0),
  range_end INTEGER CHECK (range_end IS NULL OR range_end BETWEEN 1 AND 50000),
  selection_sha256 TEXT NOT NULL CHECK (length(selection_sha256) = 64 AND selection_sha256 = lower(selection_sha256)),
  selection_chars INTEGER NOT NULL CHECK (selection_chars BETWEEN 1 AND 8000),
  instruction TEXT NOT NULL CHECK (length(instruction) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','cancelled','stale')),
  replacement TEXT CHECK (replacement IS NULL OR length(replacement) BETWEEN 1 AND 20000),
  evidence_refs TEXT NOT NULL
    CHECK (json_valid(evidence_refs) AND json_type(evidence_refs)='array' AND length(evidence_refs) <= 4000),
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 256),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  error_reason TEXT CHECK (error_reason IS NULL OR length(error_reason) <= 500),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  applied_revision_id TEXT REFERENCES document_revisions(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (range_start IS NULL OR (range_end IS NOT NULL AND range_end > range_start AND range_end - range_start <= 8000)),
  CHECK (replacement IS NULL OR status IN ('completed','stale')),
  CHECK (status NOT IN ('completed','failed','cancelled','stale') OR finished_at IS NOT NULL),
  UNIQUE (id, account_id),
  FOREIGN KEY (document_id, account_id) REFERENCES documents(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (base_revision_id, account_id) REFERENCES document_revisions(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX document_rewrites_one_active_uidx
  ON document_rewrites (document_id) WHERE status IN ('queued','running');
CREATE INDEX document_rewrites_document_catalog_idx
  ON document_rewrites (account_id, document_id, created_at DESC, id DESC);
CREATE INDEX document_rewrites_claim_idx
  ON document_rewrites (created_at, id) WHERE status = 'queued';
`;

// Schema v24 — chunk keyword-search shadow index for inspectable source
// search (M14 stage 3). The schema v23 slot is the parallel in-flight M13
// document_rewrites branch (pending merge, never applied after this entry);
// the coordinator allocated v24 to this slice, and at merge the array reads
// 22, 23, 24. This migration is append-only and never depends on v23.
//
// `chunks_fts` is the SQLite-side keyword index over ready-generation chunk
// text. It contains text and opaque identity columns only — never vectors,
// paths, or credentials. The v1 `chunks` primary key is TEXT, so SQLite's
// external-content FTS5 cannot key rows through `content='chunks'` (its
// content_rowid must be an integer alias that this table does not have and
// that a STRICT TEXT-keyed table cannot gain without a full v1 rebuild). The
// shadow structure is therefore a regular-content FTS5 table whose UNINDEXED
// scope columns let the account and exact `(source_id, generation)` predicates
// ride inside the FTS5 search itself, mirrored row-for-row from `chunks` by
// the three triggers below.
//
// Two-store protocol: the triggers are part of `chunks` statement processing,
// so every FTS addition/deletion commits or rolls back inside the exact same
// SQLite transaction as the chunk mutation it mirrors. Promotion replaces the
// source's chunks with one transaction, so its FTS rows flip atomically with
// the authoritative `ready_generation` update; source deletion (explicit or
// FK-cascade) removes chunk rows and the delete trigger removes the FTS rows
// in the same transaction; a failed promotion rolls both back together.
// Staged chunks live only in `ingestion_chunk_staging`, which has no triggers:
// staged vectors are never keyword-visible before SQLite promotion commits.
// Search callers additionally pin the exact captured `(source_id, generation)`
// pairs, so a refresh promoting mid-search can only make captured text vanish
// (honest `source_changed`), never leak newer text.
//
// The backfill copies every already-promoted chunk into the index at upgrade
// time, so a workspace that upgrades from v22 or earlier does not silently
// lose keyword hits for content it indexed before the index existed. Legacy
// chunks simply carry no locator in their existing meta JSON — an honest
// location-unavailable state — and are never reingested by this migration.
export const SCHEMA_V24 = `
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  account_id UNINDEXED,
  source_id UNINDEXED,
  generation UNINDEXED
);

CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, content, chunk_id, account_id, source_id, generation)
  VALUES (new.rowid, new.content, new.id, new.account_id, new.source_id, CAST(new.generation AS TEXT));
END;

CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER chunks_fts_au AFTER UPDATE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.rowid;
  INSERT INTO chunks_fts (rowid, content, chunk_id, account_id, source_id, generation)
  VALUES (new.rowid, new.content, new.id, new.account_id, new.source_id, CAST(new.generation AS TEXT));
END;

INSERT INTO chunks_fts (rowid, content, chunk_id, account_id, source_id, generation)
  SELECT rowid, content, id, account_id, source_id, CAST(generation AS TEXT) FROM chunks ORDER BY rowid;
`;

// Schema v25 — durable local research and comparison tables (M15 stage 1).
// Eight account-scoped typed ledger entities: optimistic-revisioned definition
// heads over immutable full-content revisions, durable runs that freeze the
// pinned revision, the concrete ready source/generation set, the model/provider
// authorization snapshot, and the budget copy at acceptance (mirroring the
// v18/v20 frozen-provenance pattern — a run never re-reads mutable rows),
// ordered bounded steps with persisted outcomes, immutable-at-capture evidence
// with the M14 locator shape, claims/gaps that reference only this run's own
// evidence, machine table cells beside user correction overlays with the
// original machine output immutable, and an append-only review operation log.
// Invariant placement follows the spec exactly: selected-empty is legal for a
// stored draft revision, and Start admission — not storage — is what rejects
// it; the durable CHECKs bound shapes and aggregate budgets, while the store
// enforces the stricter orchestration limits in `researchSchemas.ts`. One
// active (queued/running/cancelling) run per definition is the partial unique
// index; the per-account queued cap and the per-run claim/gap/evidence/table
// caps are store-side because they count across child rows. Deleting a
// definition cascades its runs and dossiers; deleting a run is never a public
// operation — cancellation is the durable flag, and terminal rows keep their
// frozen provenance forever. Run instructions, questions, excerpts, and review
// notes are content that must never reach logs.
export const SCHEMA_V25 = `
CREATE TABLE research_definitions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  output_kind TEXT NOT NULL CHECK (output_kind IN ('memo','comparison')),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id)
) STRICT;
CREATE INDEX research_definitions_account_catalog_idx ON research_definitions (account_id, created_at DESC, id DESC);

CREATE TABLE research_definition_revisions (
  definition_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  account_id TEXT NOT NULL,
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 4000),
  -- The explicit selected source set. An empty array is a legal stored draft
  -- (selected-empty); only Start admission rejects it. Library ids are bounded
  -- provenance only: expansion happens at save time and later library
  -- membership changes never implicitly join a run.
  source_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(source_ids)='array' AND json_array_length(source_ids) <= 100),
  library_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(library_ids)='array' AND json_array_length(library_ids) <= 20),
  chat_model TEXT NOT NULL CHECK (length(chat_model) BETWEEN 1 AND 256),
  output_kind TEXT NOT NULL CHECK (output_kind IN ('memo','comparison')),
  -- Bounded column declarations (comparison output). The typed
  -- type/unit/enum-choice semantics live in researchSchemas.ts; this CHECK
  -- is the durable last-line aggregate bound.
  columns TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(columns)='array' AND json_array_length(columns) <= 20 AND length(columns) <= 65536),
  plan TEXT NOT NULL DEFAULT '{"steps":[]}'
    CHECK (json_valid(plan) AND json_type(plan)='object' AND length(plan) <= 32768),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (definition_id, revision),
  FOREIGN KEY (definition_id, account_id) REFERENCES research_definitions(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX research_definition_revisions_definition_idx
  ON research_definition_revisions (definition_id, revision DESC);

CREATE TRIGGER research_definition_revisions_no_update
BEFORE UPDATE ON research_definition_revisions
BEGIN
  SELECT RAISE(ABORT, 'research definition revisions are immutable');
END;

CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 1),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','cancelling','needs_review','completed','failed','cancelled')),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  chat_model TEXT NOT NULL CHECK (length(chat_model) BETWEEN 1 AND 256),
  -- Model/provider authorization snapshot identity captured at acceptance.
  -- provider_origin is never serialized into a public response or a log.
  provider_origin TEXT NOT NULL CHECK (length(provider_origin) BETWEEN 1 AND 2048),
  provider_locality TEXT NOT NULL CHECK (provider_locality IN ('local','private','remote')),
  provider_revision INTEGER NOT NULL DEFAULT 0 CHECK (provider_revision >= 0),
  -- Frozen concrete source identities: [{"source_id":...,"generation":...}].
  -- A rerun captures current generations in its own row; the prior run keeps
  -- its own frozen set forever.
  sources TEXT NOT NULL
    CHECK (json_type(sources)='array' AND json_array_length(sources) BETWEEN 1 AND 100),
  budget_steps INTEGER NOT NULL CHECK (budget_steps BETWEEN 1 AND 8),
  budget_searches INTEGER NOT NULL CHECK (budget_searches BETWEEN 1 AND 32),
  budget_model_requests INTEGER NOT NULL CHECK (budget_model_requests BETWEEN 1 AND 40),
  budget_evidence INTEGER NOT NULL CHECK (budget_evidence BETWEEN 1 AND 100),
  budget_evidence_chars INTEGER NOT NULL CHECK (budget_evidence_chars BETWEEN 2000 AND 200000),
  budget_wall_ms INTEGER NOT NULL CHECK (budget_wall_ms BETWEEN 1000 AND 900000),
  searches_used INTEGER NOT NULL DEFAULT 0 CHECK (searches_used BETWEEN 0 AND 32),
  model_requests_used INTEGER NOT NULL DEFAULT 0 CHECK (model_requests_used BETWEEN 0 AND 40),
  rerun_of TEXT REFERENCES research_runs(id) ON DELETE SET NULL,
  rerun_selection TEXT CHECK (rerun_selection IS NULL OR (json_valid(rerun_selection) AND length(rerun_selection) <= 16384)),
  review_revision INTEGER NOT NULL DEFAULT 1 CHECK (review_revision >= 1),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  error_reason TEXT CHECK (error_reason IS NULL OR length(error_reason) <= 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (id, account_id),
  FOREIGN KEY (definition_id, account_id) REFERENCES research_definitions(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX research_runs_one_active_uidx
  ON research_runs (definition_id) WHERE status IN ('queued','running','cancelling');
CREATE INDEX research_runs_definition_activity_idx
  ON research_runs (account_id, definition_id, created_at DESC, id DESC);
CREATE INDEX research_runs_account_queue_idx
  ON research_runs (account_id, created_at, id) WHERE status='queued';

CREATE TABLE research_steps (
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  account_id TEXT NOT NULL,
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 500),
  questions TEXT NOT NULL
    CHECK (json_type(questions)='array' AND json_array_length(questions) BETWEEN 1 AND 8 AND length(questions) <= 8192),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','source_changed','failed','skipped')),
  outcome TEXT CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 2000),
  -- At-most-once restart retry identity: 0 untried, 1 in flight/once used,
  -- 2 consumed restart retry that may never be re-dispatched.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, ordinal),
  CHECK (status <> 'running' OR started_at IS NOT NULL),
  CHECK (status IN ('pending','running') OR finished_at IS NOT NULL),
  FOREIGN KEY (run_id, account_id) REFERENCES research_runs(id, account_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE research_evidence (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- Frozen capture identity: never a live join into the sources table. Removal
  -- may make navigation unavailable; the captured quote stays readable.
  source_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  chunk_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  -- M14 locator shape (bounded typed locator array), captured at retrieval.
  locators TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(locators)='array' AND json_array_length(locators) <= 8 AND length(locators) <= 8192),
  excerpt TEXT NOT NULL CHECK (length(excerpt) BETWEEN 1 AND 2000),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash = lower(content_hash) AND content_hash GLOB '[0-9a-f]*'),
  retrieved_at TEXT NOT NULL,
  step_ordinal INTEGER NOT NULL CHECK (step_ordinal BETWEEN 0 AND 7),
  query TEXT NOT NULL CHECK (length(query) BETWEEN 1 AND 1000),
  irrelevant INTEGER NOT NULL DEFAULT 0 CHECK (irrelevant IN (0,1)),
  UNIQUE (run_id, source_id, generation, chunk_id, content_hash),
  UNIQUE (id, account_id),
  FOREIGN KEY (run_id, account_id) REFERENCES research_runs(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX research_evidence_run_catalog_idx
  ON research_evidence (account_id, run_id, retrieved_at DESC, id DESC);

CREATE TABLE research_claims (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- Gaps are separate rows: kind 'gap' carries no classification and no
  -- evidence references ("not found in selected evidence", never proof of
  -- absence).
  kind TEXT NOT NULL CHECK (kind IN ('claim','gap')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  corrected_text TEXT CHECK (corrected_text IS NULL OR (length(corrected_text) BETWEEN 1 AND 2000)),
  classification TEXT CHECK (classification IS NULL OR classification IN ('supported','conflicting','unsupported')),
  evidence_refs TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(evidence_refs)='array' AND json_array_length(evidence_refs) <= 5),
  user_note TEXT CHECK (user_note IS NULL OR (length(user_note) BETWEEN 0 AND 2000)),
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','accepted','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  CHECK (kind = 'claim' OR classification IS NULL),
  CHECK (kind = 'gap' OR classification IS NOT NULL),
  CHECK (kind = 'claim' OR evidence_refs = '[]'),
  CHECK (classification <> 'conflicting' OR json_array_length(evidence_refs) >= 2),
  FOREIGN KEY (run_id, account_id) REFERENCES research_runs(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX research_claims_run_catalog_idx ON research_claims (account_id, run_id, created_at DESC, id DESC);

CREATE TABLE research_table_cells (
  run_id TEXT NOT NULL,
  column_id TEXT NOT NULL CHECK (length(column_id) BETWEEN 36 AND 64),
  row_source_id TEXT NOT NULL,
  row_generation INTEGER NOT NULL CHECK (row_generation >= 0),
  -- 'machine' rows are the immutable original output; 'correction' rows are
  -- the user overlay. The merged view is computed by the store, never by
  -- rewriting machine history.
  origin TEXT NOT NULL CHECK (origin IN ('machine','correction')),
  account_id TEXT NOT NULL,
  value TEXT CHECK (value IS NULL OR json_valid(value)),
  status TEXT NOT NULL CHECK (status IN ('supported','conflicting','not_found','invalid')),
  evidence_refs TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(evidence_refs)='array' AND json_array_length(evidence_refs) <= 5),
  explanation TEXT CHECK (explanation IS NULL OR (length(explanation) BETWEEN 1 AND 1000)),
  corrected_at TEXT,
  corrected_from_run_id TEXT REFERENCES research_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, column_id, row_source_id, row_generation, origin),
  CHECK (origin = 'machine' OR corrected_at IS NOT NULL),
  CHECK (origin <> 'machine' OR corrected_at IS NULL),
  CHECK (status <> 'not_found' OR value IS NULL),
  FOREIGN KEY (run_id, account_id) REFERENCES research_runs(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX research_table_cells_run_row_idx
  ON research_table_cells (account_id, run_id, row_source_id, column_id, origin);
CREATE INDEX research_table_cells_run_column_idx
  ON research_table_cells (account_id, run_id, column_id, row_source_id);

CREATE TRIGGER research_table_cells_machine_no_update
BEFORE UPDATE ON research_table_cells
WHEN OLD.origin = 'machine'
BEGIN
  SELECT RAISE(ABORT, 'machine table cells are immutable');
END;

CREATE TABLE research_reviews (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  account_id TEXT NOT NULL,
  review_revision INTEGER NOT NULL CHECK (review_revision >= 1),
  op TEXT NOT NULL CHECK (op IN ('accept_claim','reject_claim','add_note','correct_claim_text','correct_cell','flag_evidence')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('claim','evidence','cell','run')),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 512),
  detail TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(detail) AND json_type(detail)='object' AND length(detail) <= 4000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id, account_id) REFERENCES research_runs(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX research_reviews_run_catalog_idx ON research_reviews (account_id, run_id, seq DESC);

CREATE TRIGGER research_reviews_no_update
BEFORE UPDATE ON research_reviews
BEGIN
  SELECT RAISE(ABORT, 'research reviews are immutable');
END;
`;

const migrations = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
  { version: 5, sql: SCHEMA_V5 },
  { version: 6, sql: SCHEMA_V6 },
  { version: 7, sql: SCHEMA_V7 },
  { version: 8, sql: SCHEMA_V8 },
  { version: 9, sql: SCHEMA_V9 },
  { version: 10, sql: SCHEMA_V10 },
  { version: 11, sql: SCHEMA_V11 },
  { version: 12, sql: SCHEMA_V12 },
  { version: 13, sql: SCHEMA_V13 },
  { version: 14, sql: SCHEMA_V14 },
  { version: 15, sql: SCHEMA_V15 },
  { version: 16, sql: SCHEMA_V16 },
  { version: 17, sql: SCHEMA_V17 },
  { version: 18, sql: SCHEMA_V18 },
  { version: 19, sql: SCHEMA_V19 },
  { version: 20, sql: SCHEMA_V20 },
  { version: 21, sql: SCHEMA_V21 },
  { version: 22, sql: SCHEMA_V22 },
  { version: 23, sql: SCHEMA_V23 },
  { version: 24, sql: SCHEMA_V24 },
  { version: 25, sql: SCHEMA_V25 },
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
