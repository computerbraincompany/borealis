-- Immutable historical fixture for SQLite schema version 11: the exact shipped SCHEMA_V11 delta from server/src/db/migrations.ts. Never rewrite this file after release.

ALTER TABLE users ADD COLUMN default_chat_model TEXT CHECK (default_chat_model IS NULL OR length(default_chat_model) <= 200);
