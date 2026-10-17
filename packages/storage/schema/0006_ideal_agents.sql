-- Schema v6 (ADR-0028 addition of 2026-10-10): the agents whose beliefs were `ideal` (ground truth), as resolved
-- when the run started: a JSON array of agent IDs, sorted. Recorded rather than re-derived, because resolving the
-- stored run configuration with a newer simulator could give another answer. NULL for runs without a scenario
-- and for runs stored before this migration.
ALTER TABLE runs ADD COLUMN ideal_agents TEXT;
