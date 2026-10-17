-- Schema v4 (ADR-0031): the emitter of every trace record, as two indexed columns so that both
-- `uav-002/*` (owner) and `*/planner` (component) filters use an index. Queries and exports combine them
-- into the `source` string. Existing (F0 sample) rows are backfilled as world/sim by the defaults; new
-- rows always provide both values.
-- The indexes end in `seq` (ADR-0031 amendment): records are paged by seq; time windows are mapped to a
-- seq range through trace_records_run_time first (seq order = sim-time order within a run).

ALTER TABLE trace_records ADD COLUMN source_owner TEXT NOT NULL DEFAULT 'world';
ALTER TABLE trace_records ADD COLUMN source_component TEXT NOT NULL DEFAULT 'sim';
CREATE INDEX trace_records_run_owner_seq ON trace_records (run_id, source_owner, seq);
CREATE INDEX trace_records_run_component_seq ON trace_records (run_id, source_component, seq);
