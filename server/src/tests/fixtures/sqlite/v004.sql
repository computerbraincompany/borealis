-- Immutable historical fixture for SQLite schema version 4: the exact shipped SCHEMA_V4 delta from server/src/db/migrations.ts. Never rewrite this file after release.

ALTER TABLE users ADD COLUMN remote_egress_ack_at TEXT;
