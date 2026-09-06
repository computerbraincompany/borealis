
CREATE TABLE brief_recipes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL DEFAULT 'reviewed_brief' CHECK (kind = 'reviewed_brief'),
  analysis_id TEXT,
  analysis_revision INTEGER NOT NULL CHECK (analysis_revision >= 1),
  parameter_values TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(parameter_values)='array' AND json_array_length(parameter_values) <= 20),
  report_title TEXT NOT NULL CHECK (length(report_title) BETWEEN 1 AND 200),
  report_instruction TEXT NOT NULL CHECK (length(report_instruction) BETWEEN 1 AND 8000),
  source_ids TEXT NOT NULL
    CHECK (json_type(source_ids)='array' AND json_array_length(source_ids) BETWEEN 1 AND 100),
  refresh_bindings TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(refresh_bindings)='array' AND json_array_length(refresh_bindings) <= 100),
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('daily','weekly','monthly')),
  weekday INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  day_of_month INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  minute INTEGER NOT NULL CHECK (minute BETWEEN 0 AND 59),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  next_occurrence_key TEXT NOT NULL CHECK (length(next_occurrence_key) BETWEEN 10 AND 40),
  next_run_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
  paused_reason TEXT CHECK (paused_reason IS NULL OR length(paused_reason) <= 500),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, name),
  CHECK (
    (schedule_kind = 'daily' AND weekday IS NULL AND day_of_month IS NULL)
    OR (schedule_kind = 'weekly' AND weekday IS NOT NULL AND day_of_month IS NULL)
    OR (schedule_kind = 'monthly' AND day_of_month IS NOT NULL AND weekday IS NULL)
  ),
  FOREIGN KEY (analysis_id, account_id) REFERENCES analyses(id, account_id)
) STRICT;
CREATE INDEX brief_recipes_account_catalog_idx ON brief_recipes (account_id, created_at DESC, id DESC);
CREATE INDEX brief_recipes_claim_idx ON brief_recipes (next_run_at, id) WHERE state = 'active';

CREATE TRIGGER brief_recipes_pause_on_analysis_delete
BEFORE DELETE ON analyses
BEGIN
  UPDATE brief_recipes
     SET analysis_id = NULL,
         state = 'paused',
         paused_reason = 'the bound analysis was deleted',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE analysis_id = OLD.id AND account_id = OLD.account_id;
END;

CREATE TABLE brief_recipe_revisions (
  recipe_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  account_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  analysis_id TEXT NOT NULL CHECK (length(analysis_id) BETWEEN 1 AND 64),
  analysis_revision INTEGER NOT NULL CHECK (analysis_revision >= 1),
  parameter_values TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(parameter_values)='array' AND json_array_length(parameter_values) <= 20),
  report_title TEXT NOT NULL CHECK (length(report_title) BETWEEN 1 AND 200),
  report_instruction TEXT NOT NULL CHECK (length(report_instruction) BETWEEN 1 AND 8000),
  source_ids TEXT NOT NULL
    CHECK (json_type(source_ids)='array' AND json_array_length(source_ids) BETWEEN 1 AND 100),
  refresh_bindings TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(refresh_bindings)='array' AND json_array_length(refresh_bindings) <= 100),
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('daily','weekly','monthly')),
  weekday INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  day_of_month INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  minute INTEGER NOT NULL CHECK (minute BETWEEN 0 AND 59),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (recipe_id, revision),
  FOREIGN KEY (recipe_id, account_id) REFERENCES brief_recipes(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX brief_recipe_revisions_recipe_idx ON brief_recipe_revisions (recipe_id, revision DESC);

CREATE TRIGGER brief_recipe_revisions_no_update
BEFORE UPDATE ON brief_recipe_revisions
BEGIN
  SELECT RAISE(ABORT, 'brief recipe revisions are immutable');
END;

CREATE TABLE brief_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id TEXT NOT NULL CHECK (length(recipe_id) BETWEEN 1 AND 64),
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','manual')),
  operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 64),
  occurrence_key TEXT NOT NULL CHECK (length(occurrence_key) BETWEEN 10 AND 128),
  recipe_revision INTEGER NOT NULL CHECK (recipe_revision >= 1),
  recipe_snapshot TEXT NOT NULL CHECK (json_valid(recipe_snapshot) AND length(recipe_snapshot) <= 131072),
  stage TEXT NOT NULL DEFAULT 'queued'
    CHECK (stage IN ('queued','refreshing','waiting_ready','analyzing','drafting','awaiting_review','publishing','failed','cancelled','skipped','approved','rejected')),
  stage_operation_id TEXT CHECK (stage_operation_id IS NULL OR length(stage_operation_id) BETWEEN 1 AND 64),
  stage_attempts INTEGER NOT NULL DEFAULT 0 CHECK (stage_attempts >= 0),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  deadline_at TEXT NOT NULL,
  refresh_deadline_at TEXT,
  refresh_receipts TEXT NOT NULL DEFAULT '[]'
    CHECK (json_type(refresh_receipts)='array' AND json_array_length(refresh_receipts) <= 100),
  source_snapshot TEXT
    CHECK (source_snapshot IS NULL OR (json_type(source_snapshot)='array' AND json_array_length(source_snapshot) <= 100)),
  analysis_id TEXT CHECK (analysis_id IS NULL OR length(analysis_id) BETWEEN 1 AND 64),
  analysis_revision INTEGER CHECK (analysis_revision IS NULL OR analysis_revision >= 1),
  parameter_hash TEXT CHECK (parameter_hash IS NULL OR length(parameter_hash) = 64),
  source_set_hash TEXT CHECK (source_set_hash IS NULL OR length(source_set_hash) = 64),
  analysis_run_id TEXT CHECK (analysis_run_id IS NULL OR length(analysis_run_id) BETWEEN 1 AND 64),
  baseline_run_id TEXT CHECK (baseline_run_id IS NULL OR length(baseline_run_id) BETWEEN 1 AND 64),
  analysis_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (analysis_succeeded IN (0,1)),
  comparison_summary TEXT
    CHECK (comparison_summary IS NULL OR (json_valid(comparison_summary) AND length(comparison_summary) <= 32768)),
  document_id TEXT CHECK (document_id IS NULL OR length(document_id) BETWEEN 1 AND 64),
  document_revision_id TEXT
    CHECK (document_revision_id IS NULL OR length(document_revision_id) BETWEEN 1 AND 64),
  publication_operation_id TEXT
    CHECK (publication_operation_id IS NULL OR length(publication_operation_id) BETWEEN 1 AND 64),
  reviewed_revision_id TEXT
    CHECK (reviewed_revision_id IS NULL OR length(reviewed_revision_id) BETWEEN 1 AND 64),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64),
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 500),
  coalesced_count INTEGER NOT NULL DEFAULT 1 CHECK (coalesced_count >= 1),
  missed_through_key TEXT CHECK (missed_through_key IS NULL OR length(missed_through_key) BETWEEN 10 AND 40),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  stage_updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  UNIQUE (recipe_id, occurrence_key),
  UNIQUE (id, account_id),
  CHECK (trigger <> 'manual' OR (operation_id IS NOT NULL AND occurrence_key = 'manual:' || operation_id)),
  CHECK (trigger <> 'scheduled' OR occurrence_key NOT LIKE 'manual:%'),
  CHECK (operation_id IS NULL OR trigger = 'manual'),
  CHECK (stage NOT IN ('failed','cancelled','skipped','approved','rejected') OR finished_at IS NOT NULL),
  CHECK (stage IN ('failed','cancelled','skipped','approved','rejected') OR finished_at IS NULL),
  CHECK (stage <> 'failed' OR failure_reason IS NOT NULL),
  CHECK (stage <> 'awaiting_review' OR (document_id IS NOT NULL AND document_revision_id IS NOT NULL)),
  CHECK (stage <> 'approved' OR reviewed_revision_id IS NOT NULL),
  CHECK (stage <> 'publishing' OR publication_operation_id IS NOT NULL),
  CHECK (analysis_run_id IS NULL OR (analysis_id IS NOT NULL AND analysis_revision IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX brief_runs_one_active_uidx
  ON brief_runs (recipe_id)
  WHERE stage IN ('queued','refreshing','waiting_ready','analyzing','drafting','publishing');
CREATE UNIQUE INDEX brief_runs_operation_uidx
  ON brief_runs (recipe_id, operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX brief_runs_recipe_activity_idx ON brief_runs (account_id, recipe_id, created_at DESC, id DESC);
CREATE INDEX brief_runs_recovery_idx ON brief_runs (stage_updated_at, id)
  WHERE stage IN ('queued','refreshing','waiting_ready','analyzing','drafting','publishing');

CREATE TABLE brief_review_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL CHECK (length(recipe_id) BETWEEN 1 AND 64),
  document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 64),
  document_revision_id TEXT NOT NULL CHECK (length(document_revision_id) BETWEEN 1 AND 64),
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  FOREIGN KEY (run_id, account_id) REFERENCES brief_runs(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX brief_review_events_run_idx ON brief_review_events (run_id, created_at DESC, id DESC);

CREATE TRIGGER brief_review_events_no_update
BEFORE UPDATE ON brief_review_events
BEGIN
  SELECT RAISE(ABORT, 'brief review events are immutable');
END;

CREATE TABLE brief_notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL CHECK (length(recipe_id) BETWEEN 1 AND 64),
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('first_draft','meaningful_change','attention','paused')),
  state TEXT NOT NULL DEFAULT 'unread' CHECK (state IN ('unread','read','dismissed')),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT,
  UNIQUE (run_id, kind),
  UNIQUE (id, account_id),
  FOREIGN KEY (run_id, account_id) REFERENCES brief_runs(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX brief_notifications_account_catalog_idx
  ON brief_notifications (account_id, created_at DESC, id DESC);
