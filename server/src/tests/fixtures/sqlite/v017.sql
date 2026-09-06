-- Immutable historical fixture for SQLite schema version 17: the exact shipped SCHEMA_V17 delta from server/src/db/migrations.ts. Never rewrite this file after release.

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('mcp_http','mcp_stdio')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  discovery_revision INTEGER NOT NULL DEFAULT 0 CHECK (discovery_revision >= 0),
  config TEXT NOT NULL CHECK (json_valid(config)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  status TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','ready','disconnected','error')),
  status_code TEXT CHECK (status_code IS NULL OR length(status_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, name)
) STRICT;

CREATE INDEX connections_account_catalog_idx ON connections (account_id, created_at DESC, id DESC);

CREATE TABLE connection_tool_snapshots (
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  discovery_revision INTEGER NOT NULL CHECK (discovery_revision >= 1),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 199),
  tool_id TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 8192),
  input_schema TEXT NOT NULL CHECK (json_valid(input_schema) AND length(input_schema) <= 16384),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (connection_id, discovery_revision, position),
  UNIQUE (connection_id, discovery_revision, name),
  FOREIGN KEY (connection_id, account_id) REFERENCES connections(id, account_id) ON DELETE CASCADE
) STRICT;
