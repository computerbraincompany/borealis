
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
