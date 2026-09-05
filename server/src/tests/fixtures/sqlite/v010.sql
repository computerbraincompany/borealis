-- Immutable historical fixture for SQLite schema version 10: the exact shipped SCHEMA_V10 delta from server/src/db/migrations.ts. Never rewrite this file after release.

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
