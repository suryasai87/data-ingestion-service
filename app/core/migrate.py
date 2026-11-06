"""Apply app/migrations/*.sql in order, once each (schema_migrations). Used by the setup job and local dev/tests."""
from __future__ import annotations

import pathlib
import re

from core.lakebase import Lakebase

MIGRATIONS = pathlib.Path(__file__).resolve().parent.parent / "migrations"
_SAFE = re.compile(r"^[a-z_][a-z0-9_]*$")


def apply(lb: Lakebase, schema: str) -> list[str]:
    if not _SAFE.match(schema):
        raise ValueError(f"unsafe schema name: {schema!r}")
    applied: list[str] = []
    files = sorted(MIGRATIONS.glob("*.sql"))
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        cur.execute(f"CREATE TABLE IF NOT EXISTS {schema}.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        cur.execute(f"SELECT version FROM {schema}.schema_migrations")
        done = {r["version"] for r in cur.fetchall()}
    for f in files:
        if f.stem in done:
            continue
        sql = f.read_text().replace("{schema}", schema)
        with lb.connection() as c, c.cursor() as cur:
            cur.execute(sql)
            cur.execute(f"INSERT INTO {schema}.schema_migrations (version) VALUES (%s) ON CONFLICT DO NOTHING", (f.stem,))
        applied.append(f.stem)
    return applied
