-- Immutable historical fixture for SQLite schema version 3: the exact shipped SCHEMA_V3 delta from server/src/db/migrations.ts. Never rewrite this file after release.

ALTER TABLE reports ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reports ADD COLUMN supersedes TEXT REFERENCES reports(id);
ALTER TABLE reports ADD COLUMN payload TEXT CHECK (payload IS NULL OR json_valid(payload));
CREATE INDEX reports_chat_published_idx
  ON reports (account_id, chat_id, version DESC)
  WHERE status='published' AND chat_id IS NOT NULL;
