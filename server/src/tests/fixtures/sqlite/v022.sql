
CREATE TABLE document_templates (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot) AND length(snapshot) BETWEEN 1 AND 400000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, account_id),
  UNIQUE (account_id, name)
) STRICT;
CREATE INDEX document_templates_account_catalog_idx ON document_templates (account_id, created_at DESC, id DESC);
