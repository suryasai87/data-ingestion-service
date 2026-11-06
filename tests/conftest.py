"""Test harness: offline (no Databricks), with a REAL throwaway Postgres for the store so the SQL is exercised.

PG binaries: $PG_BIN, else Homebrew postgresql@15/16/17, else `pg_config --bindir`. Tests that need the store are
skipped (not faked) when no Postgres is available.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
os.environ.setdefault("DIS_OFFLINE", "1")
os.environ.setdefault("IDENTITY_MODE", "header")
os.environ.setdefault("PLATFORM_ADMINS", "deployer@example.com")
os.environ.setdefault("DESTINATIONS_JSON", '[{"environment":"dev","label":"Foundation · DEV","catalog":"cat","schema":"foundation_dev","requires_approval":true},'
                      '{"environment":"prod","label":"Foundation · PROD","catalog":"cat","schema":"foundation_prod","requires_approval":true}]')


def _pg_bin() -> Path | None:
    cands = [os.environ.get("PG_BIN", "")] + [f"/opt/homebrew/opt/postgresql@{v}/bin" for v in (17, 16, 15)] + ["/usr/lib/postgresql/16/bin"]
    for c in cands:
        if c and (Path(c) / "initdb").exists():
            return Path(c)
    pc = shutil.which("pg_config")
    if pc:
        return Path(subprocess.check_output([pc, "--bindir"], text=True).strip())
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def pg_dsn():
    b = _pg_bin()
    if b is None:
        pytest.skip("no local Postgres binaries (set PG_BIN)")
    d = Path(tempfile.mkdtemp(prefix="dis-pg-"))
    port = _free_port()
    subprocess.run([b / "initdb", "-D", d / "data", "-U", "postgres", "-A", "trust", "--no-sync"], check=True, capture_output=True)
    subprocess.run([b / "pg_ctl", "-D", d / "data", "-l", d / "log", "-o", f"-p {port} -k {d} -c listen_addresses=127.0.0.1 -c fsync=off", "-w", "start"],
                   check=True, capture_output=True)
    try:
        yield f"host=127.0.0.1 port={port} dbname=postgres user=postgres"
    finally:
        subprocess.run([b / "pg_ctl", "-D", d / "data", "-m", "immediate", "stop"], capture_output=True)
        shutil.rmtree(d, ignore_errors=True)


@pytest.fixture()
def store(pg_dsn, monkeypatch):
    """A fresh schema per test, migrated; the app's lakebase handle points at it."""
    from core import access, config, lakebase, migrate
    from modules.forecast import service as fs

    schema = "t_" + uuid.uuid4().hex[:10]
    monkeypatch.setattr(config, "LAKEBASE_SCHEMA", schema)
    lb = lakebase.Lakebase(dsn=pg_dsn, schema=schema, pool_max=4)
    monkeypatch.setattr(lakebase, "_lb", lb)
    migrate.apply(lb, schema)
    access.invalidate()
    fs.invalidate()
    yield lb
    lb.close()
    access.invalidate()


@pytest.fixture()
def no_store(monkeypatch):
    """The store is configured but unreachable (closed port): reads must degrade, writes must answer 503."""
    from core import access, config, lakebase

    monkeypatch.setattr(config, "LAKEBASE_SCHEMA", "ingest")
    lb = lakebase.Lakebase(dsn=f"host=127.0.0.1 port={_free_port()} dbname=x user=x connect_timeout=1", schema="ingest")
    monkeypatch.setattr(lakebase, "_lb", lb)
    access.invalidate()
    yield lb
    access.invalidate()


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    import app as app_module

    return TestClient(app_module.app)


def as_user(email: str) -> dict[str, str]:
    return {"x-forwarded-email": email}
