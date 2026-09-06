-- Immutable historical fixture for SQLite schema version 16: the exact shipped SCHEMA_V16 delta from server/src/db/migrations.ts. Never rewrite this file after release.

CREATE UNIQUE INDEX sources_id_connector_account_uidx ON sources(id, connector, account_id);

CREATE TABLE connector_refresh_states (
  repair_ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  refresh_version TEXT NOT NULL CHECK (length(refresh_version) BETWEEN 1 AND 512),
  phase TEXT NOT NULL CHECK (phase IN ('preparing','prepared','activating','activated','cleanup_pending')),
  candidate_location TEXT CHECK (candidate_location IS NULL OR length(candidate_location) BETWEEN 1 AND 32768),
  activation_previous_location TEXT CHECK (activation_previous_location IS NULL OR length(activation_previous_location) BETWEEN 1 AND 32768),
  cleanup_previous_location TEXT CHECK (cleanup_previous_location IS NULL OR length(cleanup_previous_location) BETWEEN 1 AND 32768),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (phase <> 'preparing' OR candidate_location IS NULL),
  CHECK (phase = 'preparing' OR candidate_location IS NOT NULL),
  CHECK (phase <> 'preparing' OR (activation_previous_location IS NULL AND cleanup_previous_location IS NULL)),
  CHECK (phase <> 'cleanup_pending' OR activation_previous_location IS NULL),
  CHECK (phase <> 'cleanup_pending' OR (cleanup_previous_location IS NOT NULL AND cleanup_previous_location <> candidate_location)),
  CHECK (cleanup_previous_location IS NULL OR cleanup_previous_location <> candidate_location),
  FOREIGN KEY (source_id, connector_id, account_id) REFERENCES sources(id, connector, account_id) ON DELETE CASCADE,
  FOREIGN KEY (connector_id, account_id) REFERENCES connectors(id, account_id) ON DELETE CASCADE
) STRICT;

WITH protocol_rows AS (
  SELECT
    s.id AS source_id,
    s.account_id AS account_id,
    s.connector AS connector,
    s.status AS source_status,
    s.file_path AS file_path,
    s.ready_generation AS ready_generation,
    j.status AS job_status,
    j.generation AS job_generation,
    json_type(s.meta,'$.connector_refresh_version') AS version_type,
    json_type(s.meta,'$.connector_candidate_location') AS candidate_type,
    json_type(s.meta,'$.connector_activation_previous_location') AS activation_type,
    json_type(s.meta,'$.connector_previous_location') AS cleanup_type,
    json_extract(s.meta,'$.connector_refresh_version') AS version_value,
    json_extract(s.meta,'$.connector_candidate_location') AS candidate_value,
    json_extract(s.meta,'$.connector_activation_previous_location') AS activation_value,
    json_extract(s.meta,'$.connector_previous_location') AS cleanup_value
  FROM sources s
  LEFT JOIN ingestion_jobs j ON j.source_id=s.id AND j.account_id=s.account_id
  WHERE json_type(s.meta,'$.connector_refresh_version') IS NOT NULL
     OR json_type(s.meta,'$.connector_candidate_location') IS NOT NULL
     OR json_type(s.meta,'$.connector_activation_previous_location') IS NOT NULL
     OR json_type(s.meta,'$.connector_previous_location') IS NOT NULL
),
classified AS (
  SELECT r.*,
    CASE
      WHEN NOT (
        (r.version_type IS NULL OR (r.version_type='text' AND r.version_value<>''))
        AND (r.candidate_type IS NULL OR (r.candidate_type='text' AND r.candidate_value<>''))
        AND (r.activation_type IS NULL OR r.activation_type='null' OR (r.activation_type='text' AND r.activation_value<>''))
        AND (r.cleanup_type IS NULL OR (r.cleanup_type='text' AND r.cleanup_value<>''))
      ) THEN 'invalid'
      WHEN r.version_type IS NOT NULL AND r.candidate_type IS NULL
           AND r.activation_type IS NULL AND r.cleanup_type IS NULL
      THEN CASE
        WHEN r.connector IS NOT NULL AND r.source_status='index'
             AND r.job_status='preparing' AND r.job_generation >= 1
        THEN 'preparing' ELSE 'invalid' END
      WHEN r.version_type IS NOT NULL AND r.candidate_type IS NOT NULL
      THEN CASE
        WHEN r.connector IS NOT NULL AND r.job_status IN ('pending','running','error')
             AND r.job_generation >= 1
             AND (r.cleanup_type IS NULL OR r.cleanup_value <> r.candidate_value)
        THEN 'activating' ELSE 'invalid' END
      WHEN r.version_type IS NULL AND r.candidate_type IS NULL AND r.activation_type IS NULL
           AND r.cleanup_type IS NOT NULL
      THEN CASE
        WHEN r.connector IS NOT NULL AND r.source_status='ready'
             AND r.ready_generation >= 1 AND r.file_path IS NOT NULL
             AND r.cleanup_value <> r.file_path
        THEN 'cleanup_pending' ELSE 'invalid' END
      ELSE 'invalid'
    END AS resolved_phase
  FROM protocol_rows r
)
INSERT INTO connector_refresh_states (
  source_id,account_id,connector_id,generation,refresh_version,phase,
  candidate_location,activation_previous_location,cleanup_previous_location
)
SELECT
  c.source_id,c.account_id,c.connector,
  CASE WHEN c.resolved_phase='cleanup_pending' THEN c.ready_generation ELSE c.job_generation END,
  CASE WHEN c.resolved_phase='cleanup_pending' THEN 'legacy:' || c.source_id ELSE c.version_value END,
  c.resolved_phase,
  CASE WHEN c.resolved_phase='preparing' THEN NULL
       WHEN c.resolved_phase='cleanup_pending' THEN c.file_path
       ELSE c.candidate_value END,
  CASE WHEN c.resolved_phase='activating' THEN c.activation_value ELSE NULL END,
  CASE WHEN c.resolved_phase IN ('activating','cleanup_pending') THEN c.cleanup_value ELSE NULL END
FROM classified c;

UPDATE sources
   SET meta=json_remove(meta,
     '$.connector_refresh_version',
     '$.connector_candidate_location',
     '$.connector_activation_previous_location',
     '$.connector_previous_location')
 WHERE json_type(meta,'$.connector_refresh_version') IS NOT NULL
    OR json_type(meta,'$.connector_candidate_location') IS NOT NULL
    OR json_type(meta,'$.connector_activation_previous_location') IS NOT NULL
    OR json_type(meta,'$.connector_previous_location') IS NOT NULL;

CREATE INDEX connector_refresh_states_repair_idx ON connector_refresh_states (attempts, updated_at, source_id);
CREATE INDEX pending_source_deletes_periodic_idx ON pending_source_deletes (attempts, updated_at, account_id, source_id);
CREATE INDEX pending_vector_ops_periodic_idx ON pending_vector_ops (attempts, updated_at, source_id, operation, generation);
CREATE INDEX dataset_cache_cleanup_jobs_periodic_idx ON dataset_cache_cleanup_jobs (attempts, updated_at, account_id, name, location);
