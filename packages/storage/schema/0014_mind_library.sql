-- Schema v14 (F4 M1, ADR-0020 addition of 2026-10-29): the library of mind profiles and prompt templates (versions are immutable; deletion leaves a tombstone so an (id, version) is never reused,
-- as for scenarios and run configuration presets), and what the response cache keeps of every model call: the provider kind, the hash of the tool definitions, how the call ended, its usage and its wall latency.
CREATE TABLE mind_profiles (
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

CREATE TABLE prompt_templates (
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

ALTER TABLE response_cache ADD COLUMN provider_kind TEXT;
ALTER TABLE response_cache ADD COLUMN tools_hash TEXT;
ALTER TABLE response_cache ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ok', 'invalid', 'timeout', 'error'));
ALTER TABLE response_cache ADD COLUMN usage TEXT;
ALTER TABLE response_cache ADD COLUMN latency_ms INTEGER;
