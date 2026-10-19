-- Schema v8 (ADR-0035 addition of 2026-10-17, item 7): a run can be deleted to free space. Its ID is kept here so that run IDs are never reused
-- (ADR-0015 spirit: a run ID names one run, ever; exported files and the trace record IDs `run-NNNNNN#seq` refer to it).
CREATE TABLE deleted_runs (
  run_id             TEXT    PRIMARY KEY,
  deleted_at_wall_ms INTEGER NOT NULL
);
