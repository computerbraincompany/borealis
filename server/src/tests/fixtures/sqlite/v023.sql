
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
    CHECK (json_valid(evidence_refs) AND json_type(evidence_refs)='array' AND length(evidence_refs) <= 3802),
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
