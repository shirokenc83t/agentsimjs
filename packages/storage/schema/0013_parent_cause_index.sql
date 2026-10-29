-- Schema v13 (F3c M3, T-100): the trace graph and the agent history read the children (`parent:#N`) and the effects (`cause:#N`) of a record. Neither had an index: the parent
-- filter scanned every record of the run and the cause filter probed the causes of every record. Two indexes serve them (nothing else changes: the tables, the queries' results and the export
-- are the same). The parent index covers only the records that have a parent (the majority of a run, but not the roots and the pose samples), ending in seq like the others so a page comes
-- in order; the cause index leads with the cause so the lookup starts from it.
CREATE INDEX trace_records_run_parent_seq ON trace_records (run_id, parent_id, seq) WHERE parent_id IS NOT NULL;
CREATE INDEX trace_causes_run_cause ON trace_causes (run_id, cause_id, record_id);
