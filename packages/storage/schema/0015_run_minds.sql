-- Schema v15 (F4 M2, ADR-0036 section 7): what a run header says of its minds' answers. `minds_run_mode` is where the answers came from (live, replay-strict, replay-then-live; set when the run has an S2 mind or a mode
-- other than live); `not_reproducible_from_tick` is the tick of the first call of a replay-then-live run that missed the cache, set once when it happens. Neither is in a configuration hash.
ALTER TABLE runs ADD COLUMN minds_run_mode TEXT CHECK (minds_run_mode IS NULL OR minds_run_mode IN ('live', 'replay-strict', 'replay-then-live'));
ALTER TABLE runs ADD COLUMN not_reproducible_from_tick INTEGER CHECK (not_reproducible_from_tick IS NULL OR not_reproducible_from_tick >= 0);
