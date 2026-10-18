-- Schema v10 (F3a M3, ADR-0035 addition of 2026-10-17, item 11): a run imported from a file is added to the database under a fresh run ID (IDs are never
-- reused) and keeps the ID it had where it was recorded, here.
ALTER TABLE runs ADD COLUMN imported_from TEXT;
