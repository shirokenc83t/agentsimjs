-- Schema v9 (F3a M3, ADR-0035 addition item 9): replay reads one agent's records or one kind of record, paged by seq. The two indexes that
-- served that before ended in sim_time (agent) or had no order at all (kind), so a page needed a sort of everything the agent or kind owns.
-- They are replaced, one for one, by indexes that end in seq (the source indexes of v4 already do): the filter and the seq order come
-- from the same index, and the number of indexes (so the cost of an append) does not change. Nothing queried by (agent, sim_time).
DROP INDEX trace_records_run_agent_time;
DROP INDEX trace_records_run_kind;
CREATE INDEX trace_records_run_agent_seq ON trace_records (run_id, agent_id, seq);
CREATE INDEX trace_records_run_kind_seq ON trace_records (run_id, kind, seq);
