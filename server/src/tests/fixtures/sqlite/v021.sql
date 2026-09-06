-- Immutable historical fixture for SQLite schema version 21: the exact shipped SCHEMA_V21 delta from server/src/db/migrations.ts. Never rewrite this file after release.

ALTER TABLE chat_runs ADD COLUMN agent_mcp_tools TEXT
  CHECK (agent_mcp_tools IS NULL OR (json_valid(agent_mcp_tools) AND length(agent_mcp_tools) <= 524288));
