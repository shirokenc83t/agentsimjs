-- Schema v11 (F3b M2, ADR-0035 section 3 and its addition of 2026-10-17, item 10): a run made by re-simulating a window of another run says so: its parent, the window
-- and whether the checkpoints of the window were reproduced, as the JSON of the header's `derived` object.
ALTER TABLE runs ADD COLUMN derived TEXT;
