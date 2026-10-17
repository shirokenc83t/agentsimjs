"""Checks that an exported AgentSimJS-NG database opens with Python's stdlib sqlite3 (F0 acceptance).

Usage: python tools/scripts/check_sqlite_export.py <file.sqlite> [expected_run_id]
Prints a JSON summary; exits non-zero on failure.
"""

from __future__ import annotations

import json
import sqlite3
import sys

REQUIRED_TABLES = {
    "schema_migrations",
    "runs",
    "trace_records",
    "trace_causes",
    "snapshots",
    "response_cache",
    "user_data",
    "scenarios",
    "run_configs",
    "run_inputs",
}


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = argv[1]
    expected_run = argv[2] if len(argv) > 2 else None
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")}
        versions = [r[0] for r in con.execute("SELECT version FROM schema_migrations ORDER BY version")]
        runs = {
            run_id: count
            for run_id, count in con.execute(
                "SELECT r.run_id, (SELECT count(*) FROM trace_records t WHERE t.run_id = r.run_id) FROM runs r"
            )
        }
        payload = con.execute("SELECT payload FROM trace_records ORDER BY run_id, seq LIMIT 1").fetchone()
    finally:
        con.close()

    summary = {
        "sqlite_version": sqlite3.sqlite_version,
        "integrity": integrity,
        "tables": sorted(tables),
        "schema_versions": versions,
        "runs": runs,
        "first_payload": json.loads(payload[0]) if payload else None,
    }
    print(json.dumps(summary))

    problems = []
    if integrity != "ok":
        problems.append(f"integrity_check: {integrity}")
    if missing := REQUIRED_TABLES - tables:
        problems.append(f"missing tables: {sorted(missing)}")
    if versions[:1] != [1]:
        problems.append(f"unexpected schema versions: {versions}")
    if expected_run is not None and runs.get(expected_run, 0) == 0:
        problems.append(f"run {expected_run} missing or empty")
    for p in problems:
        print(f"FAIL: {p}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
