"""ServiceNow integration: request tickets, lifecycle updates, incidents, CMDB prefill, inbound requests.

Transport (SNOW_MODE):
- "rest"       a real instance: SNOW_INSTANCE (https://<name>.service-now.com) + basic auth (SNOW_USER / SNOW_PASSWORD) or
               OAuth client credentials (SNOW_CLIENT_ID / SNOW_CLIENT_SECRET); credentials come from app secret
               resources (secret scope), never from code.
- "simulator"  the built-in Table API simulator (modules/itsm/simulator.py), same JSON contract, labelled in the UI.
Calls are best effort: a ServiceNow outage never blocks a request; the link is recorded with state "error" and the
guardian creates missing tickets on its next run.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from core import config, lakebase, repo

log = logging.getLogger("dis.servicenow")

MODE = os.environ.get("SNOW_MODE", "simulator").strip().lower() or "simulator"
INSTANCE = "" if os.environ.get("SNOW_INSTANCE", "").strip() in ("", "none") else os.environ["SNOW_INSTANCE"].strip().rstrip("/")
REQUEST_TABLE = os.environ.get("SNOW_REQUEST_TABLE", "sc_request")
INCIDENT_TABLE = os.environ.get("SNOW_INCIDENT_TABLE", "incident")
ASSIGNMENT_GROUP = os.environ.get("SNOW_ASSIGNMENT_GROUP", "Data Platform")
CATALOG_ITEM = "" if os.environ.get("SNOW_CATALOG_ITEM", "").strip() in ("", "none") else os.environ["SNOW_CATALOG_ITEM"].strip()
CLOSE_CODE = os.environ.get("SNOW_CLOSE_CODE", "Solution provided")  # must be a valid sys_choice value on the instance
TIMEOUT = float(os.environ.get("SNOW_TIMEOUT_S", "10"))

# request lifecycle -> sc_request fields
STATE = {
    "draft": {"request_state": "requested", "approval": "not requested"},
    "pending_approval": {"request_state": "requested", "approval": "requested"},
    "approved": {"request_state": "in_process", "approval": "approved"},
    "deploying": {"request_state": "in_process", "approval": "approved"},
    "live": {"request_state": "closed_complete", "approval": "approved", "state": "3"},
    "rejected": {"request_state": "closed_rejected", "approval": "rejected", "state": "4"},
    "failed": {"request_state": "in_process"},
    "cancelled": {"request_state": "closed_cancelled", "state": "7"},
}


class SnowError(RuntimeError):
    pass


def mode() -> str:
    return "rest" if MODE == "rest" and INSTANCE else "simulator"


def record_url(table: str, sys_id: str) -> str | None:
    if mode() == "rest":
        return f"{INSTANCE}/nav_to.do?uri={table}.do?sys_id={sys_id}"
    return None


_token: dict[str, Any] = {}


def _auth_headers() -> dict[str, str]:
    import requests

    cid, secret = os.environ.get("SNOW_CLIENT_ID", ""), os.environ.get("SNOW_CLIENT_SECRET", "")
    if cid and secret:
        if not _token or _token.get("exp", 0) < time.time() + 60:
            r = requests.post(f"{INSTANCE}/oauth_token.do", data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret},
                              timeout=TIMEOUT)
            r.raise_for_status()
            j = r.json()
            _token.update({"access": j["access_token"], "exp": time.time() + int(j.get("expires_in", 1800))})
        return {"Authorization": f"Bearer {_token['access']}"}
    return {}


def call(method: str, path: str, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """One Table API call; returns the parsed JSON ({"result": ...}) or raises SnowError."""
    if mode() == "simulator":
        from modules.itsm import simulator

        status, out = simulator.handle(method, path, params, body)
    else:
        import requests

        auth = None
        if os.environ.get("SNOW_USER") and not os.environ.get("SNOW_CLIENT_ID"):
            auth = (os.environ["SNOW_USER"], os.environ.get("SNOW_PASSWORD", ""))
        r = requests.request(method, INSTANCE + path, params=params, json=body, auth=auth, timeout=TIMEOUT,
                             headers={"Accept": "application/json", "Content-Type": "application/json", **_auth_headers()})
        status = r.status_code
        try:
            out = r.json()
        except ValueError:
            out = {"error": {"message": r.text[:300]}}
    if status >= 400:
        raise SnowError(f"ServiceNow {method} {path} -> {status}: {json.dumps(out.get('error', out))[:300]}")
    return out


def _link(rid: str, kind: str) -> dict[str, Any] | None:
    r = lakebase.get().query(f"SELECT * FROM {repo.S()}.itsm_link WHERE request_id = %s AND kind = %s ORDER BY id DESC LIMIT 1", (rid, kind))
    return repo.row(r[0]) if r else None


def links(rid: str) -> list[dict[str, Any]]:
    return [repo.row(x) for x in lakebase.get().query(f"SELECT kind, table_name, sys_id, number, url, state, synced_at, incident_id "
                                                     f"FROM {repo.S()}.itsm_link WHERE request_id = %s ORDER BY id", (rid,))]


def _save_link(rid: str, kind: str, table: str, rec: dict[str, Any], state: str, incident_id: int | None = None) -> None:
    lakebase.get().execute(f"INSERT INTO {repo.S()}.itsm_link (request_id, kind, incident_id, table_name, sys_id, number, url, state) "
                           f"VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                           (rid, kind, incident_id, table, rec.get("sys_id", ""), rec.get("number"), record_url(table, rec.get("sys_id", "")), state))


def open_request(rid: str) -> dict[str, Any] | None:
    """Create the ServiceNow request for an ingestion request (idempotent)."""
    lb = lakebase.get()
    if _link(rid, "request"):
        return _link(rid, "request")
    r = repo.get_request(lb, rid)
    if not r:
        return None
    v = repo.get_version(lb, rid) or {}
    cfg = v.get("config") or {}
    own = cfg.get("ownership") or {}
    src, dest = cfg.get("source") or {}, cfg.get("destination") or {}
    desc = (f"Data Ingestion Service request {rid} (v{r['version']}, config sha256 {str(v.get('config_hash'))[:16]})\n"
            f"Source: {src.get('connector')} · {src.get('connection')} · {src.get('pattern')}\n"
            f"Objects: {', '.join(o.get('table', '') for o in cfg.get('objects') or [])}\n"
            f"Destination: {dest.get('catalog')}.{dest.get('schema')} ({dest.get('environment')})\n"
            f"Owner: {own.get('owner')} · classification {own.get('classification')} · cost center {own.get('cost_center')}\n"
            f"Forecast: ${((r.get('forecast') or {}).get('cost') or {}).get('month', {}).get('p50', '?')}/month\n"
            f"App: {config.host()}/requests/{rid}")
    try:
        if CATALOG_ITEM:  # Service Catalog: runs the instance's own workflow (REQ + RITM), the recommended path
            res = call("POST", f"/api/sn_sc/servicecatalog/items/{CATALOG_ITEM}/order_now", body={"sysparm_quantity": "1", "variables": {
                "short_description": f"[{rid}] Ingestion: {r['title']}"[:160], "requested_for": r["requester"], "u_dis_request": rid,
                "description": desc, "classification": own.get("classification"), "gxp": "true" if r.get("gxp") else "false"}})["result"]
            rec = {"sys_id": res.get("request_id") or res.get("sys_id"), "number": res.get("request_number") or res.get("number")}
        else:
            rec = call("POST", f"/api/now/table/{REQUEST_TABLE}", body={
                "short_description": f"[{rid}] Ingestion: {r['title']}"[:160], "description": desc, "requested_for": r["requester"],
                "opened_by": r["requester"], "assignment_group": ASSIGNMENT_GROUP, "u_dis_request": rid, "u_classification": own.get("classification"),
                "u_gxp": "true" if r.get("gxp") else "false", **STATE.get(r["status"], {})})["result"]
        _save_link(rid, "request", REQUEST_TABLE, rec, r["status"])
        lb.execute(f"UPDATE {repo.S()}.request SET ticket_number = %s WHERE id = %s", (rec.get("number"), rid))
        repo.audit(lb, "service", "itsm.request_opened", "request", rid, {"number": rec.get("number"), "mode": mode()})
        return _link(rid, "request")
    except Exception as e:  # noqa: BLE001
        log.warning("ServiceNow request for %s failed: %s", rid, e)
        _save_link(rid, "request", REQUEST_TABLE, {"sys_id": ""}, "error")
        return None


def sync_status(rid: str, status: str, note: str = "") -> None:
    link = _link(rid, "request")
    if not link or not link.get("sys_id"):
        link = open_request(rid)
        if not link or not link.get("sys_id"):
            return
    try:
        call("PATCH", f"/api/now/table/{link['table_name']}/{link['sys_id']}", body={**STATE.get(status, {}),
             "work_notes": f"Data Ingestion Service: {status.replace('_', ' ')}{' · ' + note if note else ''}"})
        lakebase.get().execute(f"UPDATE {repo.S()}.itsm_link SET state = %s, synced_at = now() WHERE request_id = %s AND kind = 'request'",
                               (status, rid))
    except Exception as e:  # noqa: BLE001
        log.warning("ServiceNow sync %s/%s failed: %s", rid, status, e)


def work_note(rid: str, note: str) -> None:
    link = _link(rid, "request")
    if not link or not link.get("sys_id"):
        return
    try:
        call("PATCH", f"/api/now/table/{link['table_name']}/{link['sys_id']}", body={"work_notes": f"Data Ingestion Service: {note}"})
    except Exception as e:  # noqa: BLE001
        log.warning("ServiceNow note %s failed: %s", rid, e)


def open_incident(rid: str, incident_id: int, title: str, detail: str, urgency: str = "2") -> dict[str, Any] | None:
    lb = lakebase.get()
    r = repo.get_request(lb, rid) or {}
    try:
        rec = call("POST", f"/api/now/table/{INCIDENT_TABLE}", body={
            "short_description": f"[{rid}] {title}"[:160], "description": detail[:3500], "caller_id": r.get("owner") or r.get("requester"),
            "assignment_group": ASSIGNMENT_GROUP, "urgency": urgency, "impact": "2", "category": "Data", "u_dis_request": rid,
            "u_pipeline_id": r.get("pipeline_id")})["result"]
        _save_link(rid, "incident", INCIDENT_TABLE, rec, "open", incident_id)
        lb.execute(f"UPDATE {repo.S()}.incident SET ticket_ref = %s WHERE id = %s", (rec.get("number"), incident_id))
        return rec
    except Exception as e:  # noqa: BLE001
        log.warning("ServiceNow incident for %s failed: %s", rid, e)
        return None


def resolve_incident(rid: str, incident_id: int, notes: str) -> None:
    lb = lakebase.get()
    rows = lb.query(f"SELECT table_name, sys_id FROM {repo.S()}.itsm_link WHERE request_id = %s AND kind = 'incident' AND incident_id = %s",
                    (rid, incident_id))
    for x in rows:
        try:
            call("PATCH", f"/api/now/table/{x['table_name']}/{x['sys_id']}", body={"state": "6", "close_code": CLOSE_CODE,
                 "close_notes": notes[:1000]})
            lb.execute(f"UPDATE {repo.S()}.itsm_link SET state = 'resolved', synced_at = now() WHERE sys_id = %s", (x["sys_id"],))
        except Exception as e:  # noqa: BLE001
            log.warning("ServiceNow resolve %s failed: %s", x["sys_id"], e)


def cmdb_search(q: str) -> list[dict[str, Any]]:
    q = (q or "").replace("^", " ").strip()[:60]
    res = call("GET", "/api/now/table/cmdb_ci_business_app",
               params={"sysparm_query": f"nameLIKE{q}" if q else "", "sysparm_limit": 20,
                       "sysparm_fields": "sys_id,name,owned_by,u_data_domain,cost_center,support_group,u_gxp_relevant"})["result"]
    out = []
    for a in res:
        owner = a.get("owned_by")
        if isinstance(owner, dict):  # a real instance returns a reference {link, value}
            owner = owner.get("display_value") or owner.get("value")
        out.append({"sys_id": a.get("sys_id"), "name": a.get("name"), "owner": owner, "domain": a.get("u_data_domain") or "",
                    "cost_center": a.get("cost_center") if not isinstance(a.get("cost_center"), dict) else a["cost_center"].get("display_value"),
                    "support_group": a.get("support_group") if not isinstance(a.get("support_group"), dict) else a["support_group"].get("display_value"),
                    "gxp": str(a.get("u_gxp_relevant", "")).lower() == "true"})
    return out


def status() -> dict[str, Any]:
    return {"mode": mode(), "instance": INSTANCE if mode() == "rest" else None, "request_table": REQUEST_TABLE,
            "catalog_item": CATALOG_ITEM or None, "close_code": CLOSE_CODE,
            "incident_table": INCIDENT_TABLE, "assignment_group": ASSIGNMENT_GROUP}


def sync_missing(limit: int = 50) -> int:
    """Guardian: every request gets its ServiceNow ticket even if ServiceNow was down when it was created."""
    lb = lakebase.get()
    rows = lb.query(f"SELECT r.id, r.status FROM {repo.S()}.request r WHERE NOT EXISTS (SELECT 1 FROM {repo.S()}.itsm_link l "
                    f"WHERE l.request_id = r.id AND l.kind = 'request' AND l.sys_id <> '') ORDER BY r.created_at LIMIT %s", (limit,))
    n = 0
    for r in rows:
        lb.execute(f"DELETE FROM {repo.S()}.itsm_link WHERE request_id = %s AND kind = 'request' AND sys_id = ''", (r["id"],))
        if open_request(r["id"]):
            n += 1
    return n
