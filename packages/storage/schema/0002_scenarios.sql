-- Schema v2 (ADR-0025): scenario documents, one row per saved version.
-- `document` is the canonical JSON; it is validated by @agentsim/scenarios whenever it is loaded.
-- Saved versions are never modified, so updated_at_wall_ms equals created_at_wall_ms (kept per ADR-0025).
-- Deletion leaves a tombstone: the document is dropped, the row (version number and content hash) stays,
-- so an (id, version) pair is never reused, even if an exported file still carries the old document.

CREATE TABLE scenarios (
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
