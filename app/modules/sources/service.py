"""Sources: the UC connections the service can use, and the objects inside them.

Browse modes for a connection's tables (best first):
- direct     the demo source (a Lakebase Postgres the app SP can sign in to): pg_catalog gives exact primary keys,
             row estimates, sizes and timestamp cursor candidates
- federation a Lakehouse Federation foreign catalog on the same connection: information_schema through the warehouse
- manual     nothing to browse (SaaS objects, no foreign catalog): the user types object names
"""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

from core import config, lakebase, warehouse
from core.lakebase import Lakebase
from modules.catalog import registry

log = logging.getLogger("dis.sources")
_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
TTL = 120.0
CURSOR_HINTS = ("updated_at", "modified_at", "last_modified", "changed_at", "update_ts", "last_updated", "modified", "aedat")

SAAS_OBJECTS: dict[str, list[tuple[str, str, list[str]]]] = {
    # (source_schema, object, primary keys) suggestions: standard objects of the application, not customer data
    "salesforce": [("objects", n, ["Id"]) for n in ("Account", "Contact", "Opportunity", "Lead", "Case", "User", "Product2", "Order")],
    "servicenow": [("tables", n, ["sys_id"]) for n in ("incident", "problem", "change_request", "cmdb_ci", "sys_user", "task")],
    "workday": [("reports", n, ["Employee_ID"]) for n in ("Worker_Report", "Org_Report", "Position_Report")],
    "dynamics365": [("dataverse", n, ["id"]) for n in ("account", "contact", "opportunity", "salesorder")],
    "netsuite": [("records", n, ["id"]) for n in ("transaction", "customer", "item", "vendor")],
    "ga4": [("events", "events", [])],
    "sharepoint": [("drives", "documents", [])],
    "google_drive": [("files", "files", [])],
}


def _cached(key: str, fn):
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < TTL:
            return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (now, val)
    return val


def _all_connections() -> list[dict[str, Any]]:
    """Raw REST, paginated: the SDK enum drops newer types (SFTP, KAFKA, COMMUNITY, ...) and returns them as None."""
    def load() -> list[dict[str, Any]]:
        w = lakebase.workspace_client()
        out, token = [], None
        for _ in range(50):
            q = {"max_results": 1000, **({"page_token": token} if token else {})}
            r = w.api_client.do("GET", "/api/2.1/unity-catalog/connections", query=q) or {}
            out += r.get("connections") or []
            token = r.get("next_page_token")
            if not token:
                break
        return out
    return _cached("all_connections", load)


def connection_info(name: str) -> dict[str, Any]:
    from urllib.parse import quote
    return lakebase.workspace_client().api_client.do("GET", f"/api/2.1/unity-catalog/connections/{quote(name, safe='')}") or {}


def enrich(cfg: dict[str, Any]) -> dict[str, Any]:
    """Resolve what the spec builder needs from the workspace: the foreign catalog of a federation connection and the
    SFTP host / port / user (non-secret options) of an SFTP connection. Best effort."""
    src = cfg.get("source") or {}
    name = src.get("connection")
    if not name or config.OFFLINE:
        return cfg
    try:
        if src.get("pattern") == "federation" and not src.get("foreign_catalog"):
            fc = _foreign_catalogs().get(name)
            if fc:
                src["foreign_catalog"] = fc
        if src.get("connector") == "sftp" and not src.get("endpoint"):
            opts = (connection_info(name).get("options") or {})
            src["endpoint"] = {"host": opts.get("host"), "port": opts.get("port", "22"),
                               **({"user": opts["user"]} if opts.get("user") and "secret" not in str(opts.get("user")) else {})}
    except Exception as e:  # noqa: BLE001
        log.info("enrich %s failed: %s", name, e)
    return cfg


def list_connections(connector_id: str) -> list[dict[str, Any]]:
    """Connections of the connector's type that the service may use: the demo connection first, then the ones
    whose owner granted the app SP USE CONNECTION (connections.get succeeds), capped to keep the call fast."""
    c = registry.get(connector_id)
    if not c or not c.get("connection_type"):
        return []
    ctype = c["connection_type"]

    def load() -> list[dict[str, Any]]:
        w = lakebase.workspace_client()
        out: list[dict[str, Any]] = []
        foreign = _foreign_catalogs()
        types = {ctype} | ({"GENERIC_LAKEFLOW_CONNECT"} if ctype == "COMMUNITY" else set())
        for conn in _all_connections():
            ct = str(conn.get("connection_type") or "")
            if ct not in types:
                continue
            name = conn["name"]
            opts = conn.get("options") or {}
            demo = bool(config.DEMO_CONNECTION) and name == config.DEMO_CONNECTION
            pats = list(c["patterns"])
            if c["category"] == "warehouse" and not foreign.get(name):
                pats = []  # federation needs a foreign catalog on the connection
            out.append({"name": name, "connection_type": ct, "host": opts.get("host") or opts.get("url") or opts.get("base_path"),
                        "owner": conn.get("owner"), "usable": demo, "foreign_catalog": foreign.get(name), "comment": conn.get("comment"),
                        "demo": demo, "via": "connection", "patterns": pats})
        out.sort(key=lambda x: (not x["demo"], x["name"]))
        if connector_id == "postgresql" and config.DEMO_SOURCE_CATALOG:
            out.insert(0, {"name": config.DEMO_SOURCE_CATALOG, "connection_type": "UC_DATABASE_CATALOG", "host": None, "owner": None,
                           "usable": True, "foreign_catalog": config.DEMO_SOURCE_CATALOG, "demo": True, "via": "uc_catalog",
                           "patterns": ["query"],
                           "comment": "Demo ERP source (Lakebase Postgres) registered in Unity Catalog: query-based ingestion"})
        # usability: the demo connection is granted by the setup job; check the next few through connections.get
        me = (w.current_user.me().user_name or "").lower()
        for item in out[:40]:
            if item["usable"]:
                continue
            item["usable"] = (item["owner"] or "").lower() == me or _can_use(item)
        return out[:200]

    return _cached(f"conns:{ctype}", load)


def _can_use(item: dict[str, Any]) -> bool:
    """USE CONNECTION is granted to the app SP (or to account users)."""
    try:
        w = lakebase.workspace_client()
        perms = w.grants.get_effective("connection", item["name"])
        me = (w.current_user.me().user_name or "").lower()
        for a in perms.privilege_assignments or []:
            if (a.principal or "").lower() in (me, "account users"):
                if any(str(getattr(p.privilege, "value", p.privilege)) in ("USE_CONNECTION", "ALL_PRIVILEGES") for p in a.privileges or []):
                    return True
    except Exception:  # noqa: BLE001
        return False
    return False


def _foreign_catalogs() -> dict[str, str]:
    def load() -> dict[str, str]:
        w = lakebase.workspace_client()
        out: dict[str, str] = {}
        for cat in w.catalogs.list():
            cn = getattr(cat, "connection_name", None)
            if cn and cn not in out:
                out[cn] = cat.name
        return out
    try:
        return _cached("foreign", load)
    except Exception:  # noqa: BLE001
        return {}


# --- objects -----------------------------------------------------------------------------------------------------
_src: Lakebase | None = None


def demo_source() -> Lakebase | None:
    """The demo source database (DEMO_SOURCE_ENDPOINT), reachable with the app SP's OAuth role."""
    global _src
    if not config.DEMO_SOURCE_ENDPOINT or config.OFFLINE:
        return None
    if _src is None:
        _src = Lakebase(endpoint=config.DEMO_SOURCE_ENDPOINT, database=config.DEMO_SOURCE_DATABASE, schema="public", pool_max=3)
    return _src


def ensure_demo_slot(slot_name: str = "dis_slot") -> str:
    """Lakebase drops a replication slot after ~40 h without a consumer: (re)create it before a new gateway starts.
    Signs in as the replication role with the password from the app's secret resource (never logged)."""
    import psycopg

    if not (config.DEMO_SOURCE_ENDPOINT and config.DEMO_REPLICATION_PASSWORD):
        return "skipped (no demo source credentials in this deployment)"
    w = lakebase.workspace_client()
    ep = w.api_client.do("GET", f"/api/2.0/postgres/{config.DEMO_SOURCE_ENDPOINT}") or {}
    host = ((ep.get("status") or {}).get("hosts") or {}).get("host")
    with psycopg.connect(host=host, port=5432, dbname=config.DEMO_SOURCE_DATABASE, user="dis_replication",
                         password=config.DEMO_REPLICATION_PASSWORD, sslmode="require", autocommit=True, connect_timeout=15) as c:
        if c.execute("SELECT 1 FROM pg_replication_slots WHERE slot_name = %s", (slot_name,)).fetchone():
            return f"slot {slot_name} present"
        c.execute("SELECT pg_create_logical_replication_slot(%s, 'pgoutput')", (slot_name,))
        return f"slot {slot_name} created"


DIRECT_SQL = """
SELECT n.nspname AS schema, c.relname AS name,
       GREATEST(c.reltuples, 0)::bigint AS rows_est, pg_total_relation_size(c.oid) AS size_bytes,
       (SELECT array_agg(a.attname ORDER BY a.attnum) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = c.oid AND i.indisprimary) AS pk,
       (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
       (SELECT array_agg(a.attname ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         AND format_type(a.atttypid, a.atttypmod) LIKE 'timestamp%%') AS ts_cols,
       c.relreplident AS replident
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%%'
  AND n.nspname NOT LIKE '\\_%%'
ORDER BY 1, 2
"""


def _cursor_candidates(cols: list[str] | None) -> list[str]:
    cols = cols or []
    ranked = sorted(cols, key=lambda c: (0 if c.lower() in CURSOR_HINTS else 1, c))
    return ranked[:5]


def is_demo(name: str | None) -> bool:
    return bool(name) and name in {x for x in (config.DEMO_CONNECTION, config.DEMO_SOURCE_CATALOG) if x}


def browse(name: str) -> dict[str, Any]:
    """Tables in a connection: direct (demo) -> federation -> manual. Raises only when nothing can answer."""
    if is_demo(name):
        src = demo_source()
        if src is not None:
            rows = src.query(DIRECT_SQL)
            tables = []
            for r in rows:
                pk = list(r["pk"] or [])
                issues = []
                if not pk and r["replident"] != "f":
                    issues.append("No primary key: CDC needs REPLICA IDENTITY FULL")
                tables.append({"schema": r["schema"], "name": r["name"], "rows_est": int(r["rows_est"] or 0),
                               "size_bytes": int(r["size_bytes"] or 0), "primary_keys": pk, "columns": int(r["columns"] or 0),
                               "cursor_candidates": _cursor_candidates(r["ts_cols"]), "cdc_ready": bool(pk) or r["replident"] == "f",
                               "issues": issues})
            return {"connection": name, "schemas": sorted({t["schema"] for t in tables}), "tables": tables, "browse": "direct",
                    "database": config.DEMO_SOURCE_DATABASE}
    fc = _foreign_catalogs().get(name) or (name if name == config.DEMO_SOURCE_CATALOG else None)
    if fc:
        cols = warehouse.query(
            "SELECT table_schema, table_name, count(*) AS columns, "
            "collect_list(CASE WHEN lower(data_type) LIKE 'timestamp%' THEN column_name END) AS ts_cols "
            f"FROM `{fc}`.information_schema.columns WHERE table_schema <> 'information_schema' "
            "GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 2000")
        tables = []
        for r in cols:
            ts = r["ts_cols"]
            if isinstance(ts, str):
                try:
                    ts = json.loads(ts)
                except ValueError:
                    ts = []
            tables.append({"schema": r["table_schema"], "name": r["table_name"], "rows_est": None, "size_bytes": None,
                           "primary_keys": [], "columns": int(r["columns"] or 0), "cursor_candidates": _cursor_candidates([t for t in ts or [] if t]),
                           "cdc_ready": True, "issues": ["Primary keys not visible through federation: confirm them below"]})
        return {"connection": name, "schemas": sorted({t["schema"] for t in tables}), "tables": tables, "browse": "federation"}
    return {"connection": name, "schemas": [], "tables": [], "browse": "manual"}


def saas_suggestions(connector_id: str) -> list[dict[str, Any]]:
    return [{"schema": s, "name": n, "rows_est": None, "size_bytes": None, "primary_keys": pk, "columns": 0,
             "cursor_candidates": [], "cdc_ready": True, "issues": []} for s, n, pk in SAAS_OBJECTS.get(connector_id, [])]
