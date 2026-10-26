-- Schema v12 (ADR-0035 section 4 and its addition of 2026-10-17, item 4): the metrics channel. A metric sample is one point of a series named in the
-- trusted metric registry: its source (ADR-0031 form), its name, the tick it was taken after (unique per series, the series' order), the sim time and the value.
CREATE TABLE metrics (
  run_id   TEXT    NOT NULL REFERENCES runs (run_id),
  source   TEXT    NOT NULL,
  name     TEXT    NOT NULL,
  tick     INTEGER NOT NULL,
  sim_time REAL    NOT NULL,
  value    REAL    NOT NULL,
  PRIMARY KEY (run_id, source, name, tick)
);
CREATE INDEX metrics_run_name_time ON metrics (run_id, name, sim_time);
