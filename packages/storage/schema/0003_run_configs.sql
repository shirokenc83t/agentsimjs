-- Schema v3 (ADR-0028): run configuration presets and the reproducibility fields of a run.

-- Presets, one row per saved version; deletion leaves a tombstone so (id, version) is never reused.
CREATE TABLE run_configs (
  id                 TEXT    NOT NULL,
  version            INTEGER NOT NULL CHECK (version >= 1),
  name               TEXT    NOT NULL,
  document           TEXT,
  content_hash       TEXT    NOT NULL,
  created_at_wall_ms INTEGER NOT NULL,
  updated_at_wall_ms INTEGER NOT NULL,
  deleted_at_wall_ms INTEGER,
  PRIMARY KEY (id, version),
  CHECK ((document IS NULL) = (deleted_at_wall_ms IS NOT NULL))
);

-- Every run records what it ran: scenario version, its own copy of the run configuration (immutable once
-- the run completes), both configuration hashes and the simulator version.
ALTER TABLE runs ADD COLUMN scenario_id TEXT;
ALTER TABLE runs ADD COLUMN scenario_version INTEGER;
ALTER TABLE runs ADD COLUMN run_config TEXT;
ALTER TABLE runs ADD COLUMN run_config_hash TEXT;
ALTER TABLE runs ADD COLUMN effective_config_hash TEXT;
ALTER TABLE runs ADD COLUMN simulator_version TEXT;
CREATE INDEX runs_scenario ON runs (scenario_id, scenario_version);
