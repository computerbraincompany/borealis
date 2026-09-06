-- Immutable historical fixture for SQLite schema version 14: the exact shipped SCHEMA_V14 delta from server/src/db/migrations.ts. Never rewrite this file after release.

ALTER TABLE users ADD COLUMN remote_egress_ack_origin TEXT
  CHECK (remote_egress_ack_origin IS NULL OR length(remote_egress_ack_origin) <= 2048);
