
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
