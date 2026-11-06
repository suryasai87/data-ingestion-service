"""A ServiceNow Table API simulator (used only when no ServiceNow instance is configured; labelled "Simulator").

It speaks the same JSON as /api/now/table/{table}: POST creates and returns {"result": {...sys_id, number}}, GET with
sysparm_query (field=value, fieldLIKEvalue, joined with ^) lists, PATCH updates. Records live in Lakebase
(snow_sim_record) so tickets survive restarts. A small generic CMDB of business applications is seeded on first use.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from psycopg.types.json import Jsonb

from core import config, lakebase, repo

PREFIX = {"sc_request": "REQ", "incident": "INC", "sc_task": "SCTASK", "cmdb_ci_business_app": "APM", "change_request": "CHG"}
_seeded = False


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _seed() -> None:
    global _seeded
    if _seeded:
        return
    lb = lakebase.get()
    if lb.query(f"SELECT 1 FROM {repo.S()}.snow_sim_record WHERE table_name = 'cmdb_ci_business_app' LIMIT 1"):
        _seeded = True
        return
    owner = (config.PLATFORM_ADMINS or ["data.owner@example.com"])[0]
    apps = [("Finance Close & Consolidation", "finance", "CC-FIN-100", "Finance Data Office"),
            ("Supply Chain Planning", "supply chain", "CC-SCM-200", "Supply Chain Analytics"),
            ("Quality Management System", "quality", "CC-QA-300", "Quality IT"),
            ("Manufacturing Execution", "manufacturing", "CC-MFG-400", "Manufacturing IT"),
            ("Commercial CRM", "sales", "CC-COM-500", "Commercial IT")]
    for name, domain, cc, group in apps:
        create("cmdb_ci_business_app", {"name": name, "owned_by": owner, "u_data_domain": domain, "cost_center": cc,
                                         "support_group": group, "operational_status": "1", "u_gxp_relevant": "true" if domain in ("quality", "manufacturing") else "false"})
    _seeded = True


def create(table: str, fields: dict[str, Any]) -> dict[str, Any]:
    lb = lakebase.get()
    sys_id = uuid.uuid4().hex
    n = lb.query(f"SELECT nextval('{repo.S()}.snow_sim_seq') AS n")[0]["n"]
    number = f"{PREFIX.get(table, 'REC')}{int(n):07d}"
    rec = {**{k: ("" if v is None else str(v) if not isinstance(v, (dict, list)) else v) for k, v in fields.items()},
           "sys_id": sys_id, "number": number, "sys_created_on": _now(), "sys_updated_on": _now()}
    lb.execute(f"INSERT INTO {repo.S()}.snow_sim_record (table_name, sys_id, number, data) VALUES (%s,%s,%s,%s)",
               (table, sys_id, number, Jsonb(rec)))
    return rec


def update(table: str, sys_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
    lb = lakebase.get()
    r = lb.query(f"SELECT data FROM {repo.S()}.snow_sim_record WHERE table_name = %s AND sys_id = %s", (table, sys_id))
    if not r:
        return None
    rec = dict(r[0]["data"])
    for k, v in fields.items():
        if k == "work_notes" and v:  # journal field: appended, like ServiceNow
            rec["work_notes_journal"] = (rec.get("work_notes_journal") or []) + [{"at": _now(), "note": str(v)}]
        else:
            rec[k] = "" if v is None else str(v)
    rec["sys_updated_on"] = _now()
    lb.execute(f"UPDATE {repo.S()}.snow_sim_record SET data = %s, updated_at = now() WHERE table_name = %s AND sys_id = %s",
               (Jsonb(rec), table, sys_id))
    return rec


def _match(rec: dict[str, Any], q: str) -> bool:
    for term in [t for t in (q or "").split("^") if t]:
        m = re.match(r"^(\w+)(LIKE|=|!=)(.*)$", term)
        if not m:
            continue
        f, op, val = m.groups()
        cur = str(rec.get(f, ""))
        if op == "=" and cur != val or op == "!=" and cur == val or op == "LIKE" and val.lower() not in cur.lower():
            return False
    return True


def query(table: str, q: str = "", limit: int = 20) -> list[dict[str, Any]]:
    if table == "cmdb_ci_business_app":
        _seed()
    rows = lakebase.get().query(f"SELECT data FROM {repo.S()}.snow_sim_record WHERE table_name = %s ORDER BY created_at DESC LIMIT 500", (table,))
    return [r["data"] for r in rows if _match(r["data"], q)][:limit]


def get(table: str, sys_id: str) -> dict[str, Any] | None:
    r = lakebase.get().query(f"SELECT data FROM {repo.S()}.snow_sim_record WHERE table_name = %s AND sys_id = %s", (table, sys_id))
    return r[0]["data"] if r else None


def handle(method: str, path: str, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    """Table API contract: /api/now/table/{table}[/{sys_id}]; Service Catalog: /api/sn_sc/servicecatalog/items/{id}/order_now"""
    oc = re.match(r"^/api/sn_sc/servicecatalog/items/(\w+)/order_now$", path)
    if oc and method == "POST":
        v = (body or {}).get("variables") or {}
        req = create("sc_request", {"short_description": v.get("short_description", "Data ingestion request"), "requested_for": v.get("requested_for", ""),
                                    "request_state": "requested", "approval": "requested", "u_dis_request": v.get("u_dis_request", "")})
        create("sc_req_item", {"request": req["sys_id"], "cat_item": oc.group(1), "variables": v, "u_dis_request": v.get("u_dis_request", "")})
        return 200, {"result": {"request_number": req["number"], "request_id": req["sys_id"], "sys_id": req["sys_id"], "number": req["number"]}}
    m = re.match(r"^/api/now/table/(\w+)(?:/(\w+))?$", path)
    if not m:
        return 404, {"error": {"message": "Not found", "detail": path}}
    table, sys_id = m.groups()
    params = params or {}
    if method == "POST" and not sys_id:
        return 201, {"result": create(table, body or {})}
    if method in ("PATCH", "PUT") and sys_id:
        rec = update(table, sys_id, body or {})
        return (200, {"result": rec}) if rec else (404, {"error": {"message": "No Record found"}})
    if method == "GET" and sys_id:
        rec = get(table, sys_id)
        return (200, {"result": rec}) if rec else (404, {"error": {"message": "No Record found"}})
    if method == "GET":
        return 200, {"result": query(table, params.get("sysparm_query", ""), int(params.get("sysparm_limit", 20)))}
    return 405, {"error": {"message": "Method not allowed"}}
