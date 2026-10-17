-- Schema v1 (ADR-0010, ADR-0020). Shared by the browser (sqlite-wasm), Node tests and the backend (FB).
-- Only the tables needed by the F0 ports; later phases add tables by migration.

CREATE TABLE schema_migrations (
  version            INTEGER PRIMARY KEY,
  name               TEXT    NOT NULL,
  applied_at_wall_ms INTEGER NOT NULL
);

CREATE TABLE runs (
  run_id             TEXT    PRIMARY KEY,
  schema_version     INTEGER NOT NULL,
  created_at_wall_ms INTEGER NOT NULL,
  label              TEXT    NOT NULL,
  scenario           TEXT,
  seed               INTEGER,
  status             TEXT    NOT NULL CHECK (status IN ('running', 'completed', 'aborted'))
);

CREATE TABLE trace_records (
  run_id     TEXT    NOT NULL REFERENCES runs (run_id),
  seq        INTEGER NOT NULL,
  id         TEXT    NOT NULL,
  parent_id  TEXT,
  sim_time   REAL    NOT NULL,
  wall_time  REAL    NOT NULL,
  agent_id   TEXT,
  group_id   TEXT,
  kind       TEXT    NOT NULL,
  tier       TEXT,
  detail     TEXT,
  payload    TEXT    NOT NULL,
  belief_ref TEXT,
  world_ref  TEXT,
  PRIMARY KEY (run_id, seq)
);
CREATE UNIQUE INDEX trace_records_run_id_id ON trace_records (run_id, id);
CREATE INDEX trace_records_run_time ON trace_records (run_id, sim_time);
CREATE INDEX trace_records_run_agent_time ON trace_records (run_id, agent_id, sim_time);
CREATE INDEX trace_records_run_kind ON trace_records (run_id, kind);

CREATE TABLE trace_causes (
  run_id    TEXT NOT NULL,
  record_id TEXT NOT NULL,
  cause_id  TEXT NOT NULL,
  PRIMARY KEY (run_id, record_id, cause_id)
);

CREATE TABLE snapshots (
  run_id   TEXT    NOT NULL REFERENCES runs (run_id),
  id       TEXT    NOT NULL,
  seq      INTEGER NOT NULL,
  sim_time REAL    NOT NULL,
  data     BLOB    NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE response_cache (
  key                TEXT    PRIMARY KEY,
  model              TEXT    NOT NULL,
  value              TEXT    NOT NULL,
  created_at_wall_ms INTEGER NOT NULL
);

CREATE TABLE user_data (
  namespace          TEXT    NOT NULL,
  key                TEXT    NOT NULL,
  value              TEXT    NOT NULL,
  updated_at_wall_ms INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);
