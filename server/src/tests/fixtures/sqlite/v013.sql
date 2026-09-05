-- Immutable historical fixture for SQLite schema version 13: the exact shipped SCHEMA_V13 delta from server/src/db/migrations.ts. Never rewrite this file after release.

ALTER TABLE agents ADD COLUMN configuration TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(configuration));
ALTER TABLE agent_revisions ADD COLUMN configuration TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(configuration));
ALTER TABLE chat_runs ADD COLUMN agent_tools TEXT CHECK(agent_tools IS NULL OR json_valid(agent_tools));
CREATE TABLE agent_skills (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=240),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 8000),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,name)
) STRICT;
CREATE INDEX agent_skills_account_idx ON agent_skills(account_id,name,id);
CREATE TABLE agent_skill_revisions (
  skill_id TEXT NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(skill_id,version)
) STRICT;
