"""Lakebase (autoscale Postgres) connection pool, workspace-portable.

- ``oauth`` mode (Databricks Apps, jobs, a CLI login): ``LAKEBASE_ENDPOINT`` names the endpoint
  (``projects/<p>/branches/<b>/endpoints/<e>``). A short-lived credential is minted with
  ``POST /api/2.0/postgres/credentials``; the host comes from ``GET /api/2.0/postgres/<endpoint>``; the Postgres role is
  the app SP's client id (``DATABRICKS_CLIENT_ID``) or the signed-in identity.
- ``dsn`` mode (local dev): ``LAKEBASE_URL`` is a static libpq DSN.

Rules carried over from earlier apps (they each cost an outage once):
- ``max_lifetime`` 3000 s < the ~1 h token TTL, and the pool is rebuilt 5 min before the token expires.
- A connection idle for more than 10 s is checked on checkout (scale-to-zero, idle timeouts).
- Circuit breaker: only a CONNECTION failure opens it (no SQLSTATE, class 08, 57P01-03, 53300). While open, calls fail
  in microseconds with ``LakebaseUnavailable`` (reads degrade to their next tier, writes answer 503) and the next call
  after ``BREAKER_COOLDOWN_S`` probes again. A statement error (constraint, timeout, deadlock) never opens it.
- The credential is passed to libpq as a kwarg and never logged or returned.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from core import config
from core.errors import Unavailable

log = logging.getLogger("dis.lakebase")

MAX_LIFETIME = 3000
REFRESH_CUSHION = 300
CHECK_IDLE_AFTER = 10.0
BREAKER_COOLDOWN_S = float(os.environ.get("LAKEBASE_BREAKER_COOLDOWN_S", "5"))
CONNECTION_SQLSTATES = frozenset({"57P01", "57P02", "57P03", "53300"})


class LakebaseUnavailable(Unavailable):
    """Lakebase could not be reached (not configured, credential, network, pool exhausted, breaker open)."""


def connection_lost(e: BaseException) -> bool:
    if isinstance(e, LakebaseUnavailable):
        return True
    if not isinstance(e, (psycopg.OperationalError, psycopg.InterfaceError)):
        return False
    state = getattr(e, "sqlstate", None)
    return state is None or state.startswith("08") or state in CONNECTION_SQLSTATES


_w: Any = None
_w_lock = threading.Lock()


def workspace_client():
    """The SDK default chain (Apps SP / job identity / ~/.databrickscfg); DATABRICKS_PROFILE wins locally."""
    global _w
    if config.OFFLINE:
        raise Unavailable("offline mode (DIS_OFFLINE=1): no Databricks calls")
    with _w_lock:
        if _w is None:
            from databricks.sdk import WorkspaceClient
            from databricks.sdk.config import Config

            kw = {"retry_timeout_seconds": int(os.environ.get("DATABRICKS_RETRY_TIMEOUT", "30"))}
            profile = os.environ.get("DATABRICKS_PROFILE")
            cfg = Config(profile=profile, **kw) if profile and not os.environ.get("DATABRICKS_CLIENT_ID") else Config(**kw)
            _w = WorkspaceClient(config=cfg)
        return _w


def pg_user(w: Any) -> str:
    for var in ("PGUSER", "DATABRICKS_CLIENT_ID"):
        v = os.environ.get(var, "").strip()
        if v:
            return v
    cfg = getattr(w, "config", None)
    if getattr(cfg, "auth_type", None) == "oauth-m2m" and getattr(cfg, "client_id", None):
        return cfg.client_id
    return w.current_user.me().user_name


def _mark_idle(conn: psycopg.Connection) -> None:
    conn._dis_idle_since = time.monotonic()  # type: ignore[attr-defined]


def _check(conn: psycopg.Connection) -> None:
    since = getattr(conn, "_dis_idle_since", None)
    if since is None or time.monotonic() - since >= CHECK_IDLE_AFTER:
        ConnectionPool.check_connection(conn)


class Lakebase:
    def __init__(self, endpoint: str = "", dsn: str = "", database: str = "", schema: str = "", pool_max: int = 8):
        self.endpoint = endpoint
        self.dsn = dsn
        self.database = database or "databricks_postgres"
        self.schema = schema or "public"
        self.pool_max = pool_max
        self._pool: ConnectionPool | None = None
        self._expires_at = 0.0
        self._lock = threading.Lock()
        self._open_until = 0.0
        self.last_error: str | None = None

    @property
    def configured(self) -> bool:
        """A static DSN works offline (local Postgres in tests); an endpoint needs Databricks."""
        return bool(self.dsn) or (bool(self.endpoint) and not config.OFFLINE)

    # --- pool lifecycle -------------------------------------------------------------------------------------------
    def _conn_kwargs(self) -> tuple[str, dict[str, Any], float]:
        opts = f"-c search_path={self.schema},public -c jit=off -c statement_timeout=30000"
        if self.dsn:
            return self.dsn, {"options": opts}, time.time() + 10 * 365 * 86400
        w = workspace_client()
        ep = w.api_client.do("GET", f"/api/2.0/postgres/{self.endpoint}") or {}
        host = ((ep.get("status") or {}).get("hosts") or {}).get("host")
        if not host:
            raise LakebaseUnavailable(f"endpoint {self.endpoint} reported no host")
        cred = w.api_client.do("POST", "/api/2.0/postgres/credentials", body={"endpoint": self.endpoint}) or {}
        token = cred.get("token")
        if not token:
            raise LakebaseUnavailable("no Lakebase credential returned")
        exp = cred.get("expire_time") or cred.get("expiration_time")
        try:
            expires = datetime.fromisoformat(str(exp).replace("Z", "+00:00")).timestamp() if exp else time.time() + 3600
        except ValueError:
            expires = time.time() + 3600
        conninfo = f"host={host} port=5432 dbname={self.database} sslmode=require"
        kwargs = {"user": pg_user(w), "password": token, "options": opts, "connect_timeout": 8,
                  "keepalives": 1, "keepalives_idle": 30, "keepalives_interval": 10, "keepalives_count": 3}
        return conninfo, kwargs, expires

    def _ensure_pool(self) -> ConnectionPool:
        now = time.time()
        if self._pool is not None and now < self._expires_at - REFRESH_CUSHION:
            return self._pool
        with self._lock:
            if self._pool is not None and now < self._expires_at - REFRESH_CUSHION:
                return self._pool
            conninfo, kwargs, expires = self._conn_kwargs()
            # Probe once before building the pool: an unreachable server fails in milliseconds here instead of
            # every request waiting the pool timeout while the pool retries in the background.
            probe = {k: v for k, v in kwargs.items() if k != "options"}
            probe["connect_timeout"] = min(int(probe.get("connect_timeout", 8)), 8)
            psycopg.connect(conninfo, **probe).close()
            old = self._pool
            pool = ConnectionPool(conninfo, kwargs={**kwargs, "row_factory": dict_row, "autocommit": False},
                                  min_size=0, max_size=self.pool_max, max_lifetime=MAX_LIFETIME, max_idle=300,
                                  timeout=8, check=_check, reset=_mark_idle, open=True, name="dis")
            self._pool, self._expires_at = pool, expires
            if old is not None:
                threading.Thread(target=old.close, kwargs={"timeout": 30}, daemon=True).start()
            return pool

    def _trip(self, e: BaseException) -> None:
        self._open_until = time.monotonic() + BREAKER_COOLDOWN_S
        self.last_error = f"{type(e).__name__}: {' '.join(str(e).split())[:240]}"
        log.warning("lakebase breaker open: %s", self.last_error)

    def circuit(self) -> dict[str, Any]:
        return {"configured": self.configured, "open": time.monotonic() < self._open_until, "last_error": self.last_error}

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection]:
        """One transaction: commit on success, rollback on error. Connection failures raise LakebaseUnavailable."""
        if not self.configured:
            raise LakebaseUnavailable("Lakebase is not configured")
        if time.monotonic() < self._open_until:
            raise LakebaseUnavailable(f"Lakebase unreachable (retrying shortly): {self.last_error}")
        try:
            pool = self._ensure_pool()
            cm = pool.connection()
            conn = cm.__enter__()
        except Exception as e:  # noqa: BLE001 - every failure to get a connection is a connection failure
            self._trip(e)
            raise LakebaseUnavailable(f"Lakebase unreachable: {type(e).__name__}") from e
        try:
            yield conn
            conn.commit()
        except BaseException as e:
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            if connection_lost(e):
                self._trip(e)
                cm.__exit__(type(e), e, e.__traceback__)
                raise LakebaseUnavailable(f"Lakebase connection lost: {type(e).__name__}") from e
            cm.__exit__(None, None, None)
            raise
        else:
            cm.__exit__(None, None, None)

    def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        with self.connection() as c, c.cursor() as cur:
            cur.execute(sql, params)
            return list(cur.fetchall()) if cur.description else []

    def execute(self, sql: str, params: Any = None) -> int:
        with self.connection() as c, c.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount

    def close(self) -> None:
        if self._pool is not None:
            self._pool.close()
            self._pool = None


_lb: Lakebase | None = None


def get() -> Lakebase:
    global _lb
    if _lb is None:
        _lb = Lakebase(endpoint=config.LAKEBASE_ENDPOINT, dsn=config.LAKEBASE_URL, database=config.LAKEBASE_DATABASE,
                       schema=config.LAKEBASE_SCHEMA, pool_max=config.LAKEBASE_POOL_MAX)
    return _lb
