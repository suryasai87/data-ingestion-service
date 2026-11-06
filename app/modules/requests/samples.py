"""Labelled sample requests: the last read tier (source = "synthetic") when neither Lakebase nor the UC mirror
answers. Generic, non-customer content; ids start with IR-SAMPLE so they can never be mistaken for real requests."""
from __future__ import annotations

from typing import Any

_T = "2026-10-30T14:00:00+00:00"


def _sample(rid: str, title: str, status: str, connector: str, pattern: str, tables: list[tuple[str, str, list[str]]],
            interval: int, sla: int, cost: float, classification: str) -> dict[str, Any]:
    cfg = {
        "title": title,
        "source": {"connector": connector, "pattern": pattern, "connection": "sample_connection", "database": "erp"},
        "objects": [{"schema": s, "table": t, "primary_keys": pk, "cursor_column": None, "destination_table": None, "rows_est": None}
                    for s, t, pk in tables],
        "schema": {"scd_type": "SCD_TYPE_1", "evolution": "add_new_columns"},
        "destination": {"environment": "dev", "catalog": "foundation", "schema": "landing_dev", "table_prefix": ""},
        "schedule": {"mode": "interval", "interval_minutes": interval, "sla_minutes": sla},
        "ownership": {"owner": "data.owner@example.com", "classification": classification, "domain": "finance",
                      "cost_center": "CC-0000", "justification": "Sample request shown while the live store is unavailable."},
        "operations": {"retries": 3, "recovery": "auto_retry_then_ticket", "reconciliation": True, "alert_emails": []},
    }
    req = {"id": rid, "title": title, "status": status, "channel": "app", "requester": "requester@example.com",
           "owner": "data.owner@example.com", "classification": classification, "environment": "dev", "connector": connector,
           "pattern": pattern, "n_objects": len(tables), "version": 1, "created_at": _T, "updated_at": _T, "pipeline_id": None,
           "gateway_id": None, "job_id": None, "forecast_month_usd": cost, "sla_minutes": sla}
    return {"request": req, "config": cfg, "versions": [{"version": 1, "created_at": _T, "created_by": "requester@example.com", "hash": "sample"}],
            "checks": [], "forecast": None, "timeline": [{"at": _T, "actor": "requester@example.com", "action": "request.create", "detail": "sample"}],
            "deployment": [], "links": [], "can": {k: False for k in ("edit", "submit", "approve", "deploy", "cancel")}}


SAMPLES: list[dict[str, Any]] = [
    _sample("IR-SAMPLE-1", "Finance journals (sample)", "live", "postgresql", "cdc",
            [("finance", "journal_header", ["doc_id"]), ("finance", "journal_line", ["doc_id", "line_no"])], 15, 30, 812.0, "confidential"),
    _sample("IR-SAMPLE-2", "CRM accounts (sample)", "pending_approval", "salesforce", "saas",
            [("objects", "Account", ["Id"]), ("objects", "Opportunity", ["Id"])], 60, 120, 96.0, "internal"),
    _sample("IR-SAMPLE-3", "Incident tickets (sample)", "draft", "servicenow", "saas", [("tables", "incident", ["sys_id"])], 60, 180, 41.0, "internal"),
]
