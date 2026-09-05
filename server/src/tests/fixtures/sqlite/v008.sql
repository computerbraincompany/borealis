-- Immutable historical fixture for SQLite schema version 8: the exact shipped SCHEMA_V8 delta from server/src/db/migrations.ts. Never rewrite this file after release.

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
