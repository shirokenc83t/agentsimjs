-- Schema v16 (F4 M5b, ADR-0036 section 7, T-133): the response cache is kept per run. An entry carries the run it was recorded in (`run_id`, empty for an entry written before v16), the key is the
-- same as before, and a replay reads the entries of its own run first: two live runs that start from the same request each keep their own answers, and a later live run no longer writes over the answer
-- a replay of an earlier one needs. A read without a preference gets the latest entry for the key, as before.
CREATE TABLE response_cache_v16 (
  key                TEXT    NOT NULL,
  run_id             TEXT    NOT NULL DEFAULT '',
  model              TEXT    NOT NULL,
  value              TEXT    NOT NULL,
  created_at_wall_ms INTEGER NOT NULL,
  provider_kind      TEXT,
  tools_hash         TEXT,
  outcome            TEXT CHECK (outcome IS NULL OR outcome IN ('ok', 'invalid', 'timeout', 'error')),
  usage              TEXT,
  latency_ms         INTEGER,
  PRIMARY KEY (key, run_id)
);
INSERT INTO response_cache_v16 (key, run_id, model, value, created_at_wall_ms, provider_kind, tools_hash, outcome, usage, latency_ms)
  SELECT key, '', model, value, created_at_wall_ms, provider_kind, tools_hash, outcome, usage, latency_ms FROM response_cache;
DROP TABLE response_cache;
ALTER TABLE response_cache_v16 RENAME TO response_cache;
