
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
