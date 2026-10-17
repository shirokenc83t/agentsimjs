-- Schema v5 (ADR-0015 clarification of 2026-10-04): researcher commands recorded as run inputs. Like the seed and
-- the run configuration, they are part of what a run ran: replaying them reproduces the run. Append-only.
CREATE TABLE run_inputs (
  run_id   TEXT    NOT NULL REFERENCES runs (run_id),
  input_id TEXT    NOT NULL,
  tick     INTEGER NOT NULL CHECK (tick >= 1),
  agent_id TEXT    NOT NULL,
  name     TEXT    NOT NULL,
  params   TEXT    NOT NULL,
  PRIMARY KEY (run_id, input_id)
) WITHOUT ROWID;
