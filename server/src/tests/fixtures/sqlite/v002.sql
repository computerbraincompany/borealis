-- Immutable historical fixture for SQLite schema version 2: the exact shipped SCHEMA_V2 delta from server/src/db/migrations.ts. Never rewrite this file after release.

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
