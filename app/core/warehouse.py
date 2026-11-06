"""SQL warehouse access through the Statement Execution API (the lakehouse tier, history and federation browsing).

``wait_timeout`` must be 5-50 s (60 s is rejected); longer statements are polled up to ``timeout`` seconds.
Rows come back as typed Python values (the API returns strings).
"""
from __future__ import annotations

import time
from typing import Any

from core import config
from core.errors import Unavailable
from core.lakebase import workspace_client


class WarehouseUnavailable(Unavailable):
    pass


def _coerce(v: Any, t: str) -> Any:
    if v is None:
        return None
    t = (t or "").upper()
    try:
        if t in ("INT", "BIGINT", "SMALLINT", "TINYINT", "LONG", "SHORT", "BYTE"):
            return int(v)
        if t in ("DOUBLE", "FLOAT", "DECIMAL"):
            return float(v)
        if t == "BOOLEAN":
            return str(v).lower() == "true"
    except (TypeError, ValueError):
        return v
    return v


def _user_client(token: str):
    """A client acting AS the signed-in user (Databricks Apps user authorization): the statement runs with their
    permissions and appears in system.query.history under their name."""
    from databricks.sdk import WorkspaceClient

    return WorkspaceClient(host=config.host(), token=token, auth_type="pat")


def query(sql: str, params: dict[str, Any] | None = None, timeout: float = 45.0, token: str | None = None) -> list[dict[str, Any]]:
    if config.OFFLINE or not config.WAREHOUSE_ID:
        raise WarehouseUnavailable("SQL warehouse is not configured")
    w = _user_client(token) if token else workspace_client()
    body: dict[str, Any] = {"warehouse_id": config.WAREHOUSE_ID, "statement": sql, "wait_timeout": "30s",
                            "on_wait_timeout": "CONTINUE", "format": "JSON_ARRAY", "disposition": "INLINE"}
    if params:
        body["parameters"] = [{"name": k, "value": None if v is None else str(v)} for k, v in params.items()]
    try:
        r = w.api_client.do("POST", "/api/2.0/sql/statements", body=body)
        deadline = time.monotonic() + timeout
        while (r.get("status") or {}).get("state") in ("PENDING", "RUNNING"):
            if time.monotonic() > deadline:
                w.api_client.do("POST", f"/api/2.0/sql/statements/{r['statement_id']}/cancel")
                raise WarehouseUnavailable(f"statement timed out after {timeout:.0f}s")
            time.sleep(1.5)
            r = w.api_client.do("GET", f"/api/2.0/sql/statements/{r['statement_id']}")
    except WarehouseUnavailable:
        raise
    except Exception as e:  # noqa: BLE001
        if token and ("PERMISSION" in str(e).upper() or "403" in str(e)):
            raise PermissionError(" ".join(str(e).split())[:300]) from e
        raise WarehouseUnavailable(f"warehouse call failed: {type(e).__name__}: {str(e)[:200]}") from e
    st = r.get("status") or {}
    if st.get("state") != "SUCCEEDED":
        err = (st.get("error") or {}).get("message", st.get("state"))
        if token and any(k in str(err).upper() for k in ("PERMISSION", "INSUFFICIENT_PRIVILEGES", "DOES NOT HAVE")):
            raise PermissionError(str(err)[:300])
        raise WarehouseUnavailable(f"statement {st.get('state')}: {str(err)[:300]}")
    cols = [(c["name"], c.get("type_name", "")) for c in (r.get("manifest") or {}).get("schema", {}).get("columns", [])]
    rows = (r.get("result") or {}).get("data_array") or []
    return [{n: _coerce(v, t) for (n, t), v in zip(cols, row)} for row in rows]
