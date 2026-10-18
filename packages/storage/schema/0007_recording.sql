-- Schema v7 (ADR-0004 and ADR-0035 additions of 2026-10-17 and 2026-10-18): recording. The run header gains the recording
-- state and the resolved recording profile; snapshots keep their root (a container whose large sections live outside it) and
-- refer to blobs by their 128-bit content id; belief-map keyframes and deltas are stored per agent. A blob is stored once per
-- run and shared by snapshots and belief keyframes (a snapshot tick is also a keyframe tick). NULL `recording` = a run stored
-- before recording existed.
ALTER TABLE runs ADD COLUMN recording TEXT CHECK (recording IS NULL OR recording IN ('stored', 'none'));
ALTER TABLE runs ADD COLUMN recording_profile TEXT;
ALTER TABLE runs ADD COLUMN recording_profile_hash TEXT;

-- `id` is the snapshot's content hash (32 hex digits); `seq` is the trace seq of its `snapshot` record; `data` is the container.
ALTER TABLE snapshots ADD COLUMN tick INTEGER NOT NULL DEFAULT 0;

CREATE TABLE blobs (
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  id     TEXT NOT NULL,
  data   BLOB NOT NULL,
  PRIMARY KEY (run_id, id)
);

-- A frame names the chunks it covers (ascending chunk indices, JSON) and holds its bytes either inline (deltas) or as a blob (keyframes).
CREATE TABLE belief_frames (
  run_id   TEXT    NOT NULL REFERENCES runs (run_id),
  agent_id TEXT    NOT NULL,
  seq      INTEGER NOT NULL,
  tick     INTEGER NOT NULL,
  sim_time REAL    NOT NULL,
  kind     TEXT    NOT NULL CHECK (kind IN ('keyframe', 'delta')),
  chunks   TEXT    NOT NULL,
  blob_id  TEXT,
  data     BLOB,
  PRIMARY KEY (run_id, agent_id, seq),
  CHECK ((blob_id IS NULL) <> (data IS NULL)),
  FOREIGN KEY (run_id, blob_id) REFERENCES blobs (run_id, id)
);
CREATE INDEX belief_frames_run_agent_tick ON belief_frames (run_id, agent_id, tick);
