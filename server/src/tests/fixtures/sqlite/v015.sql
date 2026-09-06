-- Immutable historical fixture for SQLite schema version 15: the exact shipped SCHEMA_V15 delta from server/src/db/migrations.ts. Never rewrite this file after release.

CREATE TABLE automations_v15 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connector_sync','agent_turn')),
  connector_id TEXT,
  chat_id TEXT,
  target_id TEXT GENERATED ALWAYS AS (coalesce(connector_id, chat_id)) VIRTUAL,
  prompt TEXT,
  schedule_minutes INTEGER NOT NULL CHECK (schedule_minutes BETWEEN 15 AND 10080),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, name),
  UNIQUE (id, account_id),
  CHECK (
    (kind = 'connector_sync' AND connector_id IS NOT NULL AND chat_id IS NULL)
    OR (kind = 'agent_turn' AND chat_id IS NOT NULL AND connector_id IS NULL)
  ),
  FOREIGN KEY (connector_id, account_id) REFERENCES connectors(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (chat_id, account_id) REFERENCES chats(id, account_id) ON DELETE CASCADE
) STRICT;

INSERT INTO automations_v15 (
  id,account_id,name,kind,connector_id,chat_id,prompt,schedule_minutes,
  state,consecutive_failures,last_run_at,next_run_at,created_at,updated_at
)
SELECT
  a.id,a.account_id,a.name,a.kind,
  CASE WHEN a.kind='connector_sync' THEN a.target_id END,
  CASE WHEN a.kind='agent_turn' THEN a.target_id END,
  a.prompt,a.schedule_minutes,a.state,a.consecutive_failures,a.last_run_at,a.next_run_at,a.created_at,a.updated_at
FROM automations a
WHERE
  (
    a.kind='connector_sync'
    AND EXISTS (
      SELECT 1 FROM connectors c WHERE c.id=a.target_id AND c.account_id=a.account_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM automations newer
      WHERE newer.account_id=a.account_id
        AND newer.kind='connector_sync'
        AND newer.target_id=a.target_id
        AND (newer.created_at,newer.id) > (a.created_at,a.id)
    )
  )
  OR (
    a.kind='agent_turn'
    AND EXISTS (
      SELECT 1 FROM chats h WHERE h.id=a.target_id AND h.account_id=a.account_id
    )
  );

ALTER TABLE automations RENAME TO automations_pre_v15;
ALTER TABLE automations_v15 RENAME TO automations;

CREATE TABLE automation_runs_v15 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','skipped')),
  detail TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  FOREIGN KEY (automation_id, account_id) REFERENCES automations(id, account_id) ON DELETE CASCADE
) STRICT;

INSERT INTO automation_runs_v15 (id,automation_id,account_id,outcome,detail,started_at,finished_at)
SELECT r.id,r.automation_id,r.account_id,r.outcome,r.detail,r.started_at,r.finished_at
FROM automation_runs r
WHERE EXISTS (
  SELECT 1 FROM automations a WHERE a.id=r.automation_id AND a.account_id=r.account_id
)
ORDER BY r.id;

DROP TABLE automation_runs;
DROP TABLE automations_pre_v15;
ALTER TABLE automation_runs_v15 RENAME TO automation_runs;

CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, started_at DESC);
CREATE INDEX automations_account_catalog_idx ON automations (account_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX automations_connector_target_uidx ON automations (account_id, connector_id) WHERE connector_id IS NOT NULL;
