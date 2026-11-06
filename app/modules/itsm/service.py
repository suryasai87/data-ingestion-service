"""Hooks from the request lifecycle into ServiceNow (best effort, off the request thread in production)."""
from __future__ import annotations

import logging
import threading
from typing import Any, Callable

from core import config
from modules.itsm import servicenow

log = logging.getLogger("dis.itsm")


def _run(fn: Callable[..., Any], *args: Any) -> None:
    def go() -> None:
        try:
            fn(*args)
        except Exception:  # noqa: BLE001 - ServiceNow never breaks a request
            log.exception("itsm hook failed")
    if config.OFFLINE or not config.ITSM_ASYNC:
        go()
    else:
        threading.Thread(target=go, daemon=True, name="itsm").start()


def request_created(rid: str) -> None:
    if config.ITSM_ENABLED:
        _run(servicenow.open_request, rid)


def request_status(rid: str, status: str, note: str = "") -> None:
    if config.ITSM_ENABLED:
        _run(servicenow.sync_status, rid, status, note)


def pipeline_note(rid: str, note: str) -> None:
    """Operational events (pause / unpause) as a work note on the request ticket; the ticket state is unchanged."""
    if config.ITSM_ENABLED:
        _run(servicenow.work_note, rid, note)


def incident_opened(rid: str, incident_id: int, title: str, detail: str) -> None:
    if config.ITSM_ENABLED:
        servicenow.open_incident(rid, incident_id, title, detail)


def incident_resolved(rid: str, incident_id: int, notes: str) -> None:
    if config.ITSM_ENABLED:
        servicenow.resolve_incident(rid, incident_id, notes)


def from_servicenow(payload: dict[str, Any]) -> dict[str, Any]:
    """Map a ServiceNow catalog item (RITM) payload to an IngestionConfig. Variables use the config's own names."""
    v = payload.get("variables") or {}
    objs = v.get("objects") or [{"schema": t.split(".", 1)[0] if "." in t else "", "table": t.split(".", 1)[-1]}
                                for t in str(v.get("tables", "")).replace(";", ",").split(",") if t.strip()]
    return {
        "title": payload.get("short_description") or v.get("title") or "ServiceNow request",
        "source": {"connector": v.get("connector", ""), "pattern": v.get("pattern", "cdc"), "connection": v.get("connection"),
                   "database": v.get("database"), "via": v.get("via", "connection")},
        "objects": [{"schema": (o.get("schema") or "").strip(), "table": o["table"].strip(), "primary_keys": o.get("primary_keys") or [],
                     "cursor_column": o.get("cursor_column")} for o in objs],
        "destination": {"environment": v.get("environment", "dev")},
        "schedule": {"mode": v.get("mode", "interval"), "interval_minutes": int(v.get("interval_minutes", 60)),
                     "sla_minutes": int(v.get("sla_minutes", 120))},
        "ownership": {"owner": v.get("owner") or payload.get("requested_for", ""), "classification": v.get("classification", "internal"),
                      "domain": v.get("domain", ""), "cost_center": v.get("cost_center", ""), "justification": v.get("justification", ""),
                      "gxp": str(v.get("gxp", "false")).lower() == "true"},
    }
