-- Immutable historical fixture for SQLite schema version 7: the exact shipped SCHEMA_V7 delta from server/src/db/migrations.ts. Never rewrite this file after release.

CREATE TABLE egress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('consent_acknowledged','remote_turn','remote_ingest')),
  endpoint_host TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX egress_events_account_idx ON egress_events (account_id, created_at DESC);
