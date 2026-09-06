
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
