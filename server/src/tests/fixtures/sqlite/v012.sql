-- Immutable historical fixture for SQLite schema version 12: the exact shipped SCHEMA_V12 delta from server/src/db/migrations.ts. Never rewrite this file after release.

CREATE INDEX sources_account_catalog_idx ON sources (account_id, created_at DESC, id DESC);
CREATE INDEX connectors_account_catalog_idx ON connectors (account_id, created_at DESC, id DESC);
CREATE INDEX libraries_account_catalog_idx ON libraries (account_id, created_at DESC, id DESC);
CREATE INDEX agents_account_catalog_idx ON agents (account_id, created_at DESC, id DESC);
CREATE INDEX automations_account_catalog_idx ON automations (account_id, created_at DESC, id DESC);
CREATE INDEX reports_account_catalog_idx
  ON reports (account_id, created_at DESC, id DESC)
  WHERE status='published';
DROP INDEX report_shares_recipient_idx;
CREATE INDEX report_shares_recipient_idx
  ON report_shares (recipient_account_id, shared_at DESC, report_id DESC);
