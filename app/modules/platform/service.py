"""Platform: brand pack, who am I, health, home KPIs and the "Where it runs" deep links."""
from __future__ import annotations

import json
import pathlib
import statistics
from datetime import datetime, timezone
from typing import Any

from core import access, config, lakebase, repo, tiers, warehouse
from core.identity import Caller
from modules.requests import samples
from modules.requests import service as rs

BRANDING = [pathlib.Path(__file__).resolve().parents[2] / "branding"]


def brand() -> dict[str, Any]:
    for key in (config.BRAND, "databricks"):
        for base in BRANDING:
            f = base / key / "brand.json"
            if f.exists():
                return json.loads(f.read_text())
    return {"key": "databricks", "company": "Databricks", "product": "Data Ingestion Service",
            "hero_title": "Welcome to Data Ingestion Service", "hero_subtitle": "", "destination_label": "Bronze",
            "logo_url": None, "powered_by": "Powered by Databricks Lakeflow Connect", "palette": {"brand_h": 6, "brand_s": "100%"}}


def me(caller: Caller) -> dict[str, Any]:
    lb = lakebase.get()
    scopes = access.approver_scopes(lb, caller.email)
    return {"email": caller.email, "name": caller.name, "is_admin": access.is_admin(lb, caller.email),
            "is_approver": bool(scopes), "approver_scopes": scopes, "kiosk": not config.ALLOW_MUTATIONS,
            "environment_note": None if config.ALLOW_DEPLOY else "Deployments stop at the dry run (ALLOW_DEPLOY=false)."}


def health() -> dict[str, Any]:
    lb = lakebase.get()
    ok_lb = False
    if lb.configured:
        try:
            lb.query("SELECT 1 AS ok")
            ok_lb = True
        except Exception:  # noqa: BLE001
            ok_lb = False
    return {"ok": True, "version": config.VERSION, "lakebase": {**lb.circuit(), "reachable": ok_lb},
            "warehouse": bool(config.WAREHOUSE_ID), "brand": config.BRAND, "allow_deploy": config.ALLOW_DEPLOY,
            "allow_mutations": config.ALLOW_MUTATIONS}


def _hours(a: str, b: str) -> float:
    return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 3600.0


def home(caller: Caller) -> dict[str, Any]:
    lb = lakebase.get()

    def from_lb() -> dict[str, Any]:
        rows = repo.list_requests(lb, limit=1000)
        snaps = repo.snapshots(lb)
        live = [r for r in rows if r["status"] == "live"]
        open_ = [r for r in rows if r["status"] in ("draft", "pending_approval", "approved", "deploying")]
        to_live = []
        for r in live:
            ev = [a for a in repo.list_audit(lb, "request", r["id"]) if a["action"] == "request.live"]
            if ev:
                to_live.append(_hours(r["created_at"], ev[-1]["at"]))
        fresh = [(s.get("freshness_min"), next((r.get("sla_minutes") for r in live if r["id"] == k), None)) for k, s in snaps.items()]
        fresh = [(f, s) for f, s in fresh if f is not None and s]
        cost = [s.get("cost_mtd_usd") for s in snaps.values() if s.get("cost_mtd_usd") is not None]
        day = datetime.now(timezone.utc).day
        acc = []
        for r in live:
            s = snaps.get(r["id"]) or {}
            fc = rs._public(r)["forecast_month_usd"]
            if fc and s.get("cost_mtd_usd"):
                expected = fc * day / 30.0
                acc.append(max(0.0, 100.0 - abs(s["cost_mtd_usd"] - expected) / max(expected, 1e-6) * 100.0))
        return {"requests_open": len(open_), "pipelines_live": len(live), "tables_live": sum(r.get("n_objects") or 0 for r in live),
                "median_hours_to_live": round(statistics.median(to_live), 3) if to_live else None,
                "sla_attainment_pct": round(sum(1 for f, s in fresh if f <= s) / len(fresh) * 100, 1) if fresh else None,
                "cost_mtd_usd": round(sum(cost), 2) if cost else None,
                "forecast_accuracy_pct": round(statistics.mean(acc), 1) if acc else None,
                "recent": [rs._public(r) for r in rows[:6]]}

    def from_samples() -> dict[str, Any]:
        reqs = [s["request"] for s in samples.SAMPLES]
        return {"requests_open": 2, "pipelines_live": 1, "tables_live": 2, "median_hours_to_live": 3.5, "sla_attainment_pct": 99.0,
                "cost_mtd_usd": 640.0, "forecast_accuracy_pct": 92.0, "recent": reqs}

    data, source, reason = tiers.read(("lakebase", from_lb if lb.configured else None), ("synthetic", from_samples))
    return {**data, "source": source, "degraded_reason": reason}


def resources() -> dict[str, Any]:
    h = config.host()

    def link(path: str) -> str | None:
        return f"{h}{path}" if h else None

    groups: list[dict[str, Any]] = []
    lbi = []
    if config.LAKEBASE_ENDPOINT:
        parts = config.LAKEBASE_ENDPOINT.split("/")
        proj = parts[1] if len(parts) > 1 else config.LAKEBASE_ENDPOINT
        lbi.append({"label": "Service store (project)", "value": proj, "url": link(f"/lakebase/projects/{proj}")})
        lbi.append({"label": "Branch · endpoint", "value": "/".join(parts[2:]) or "—", "url": None})
        lbi.append({"label": "Database · schema", "value": f"{config.LAKEBASE_DATABASE} · {config.LAKEBASE_SCHEMA}", "url": None})
    if config.DEMO_SOURCE_PROJECT:
        lbi.append({"label": "Demo source (ERP Postgres)", "value": config.DEMO_SOURCE_PROJECT,
                    "url": link(f"/lakebase/projects/{config.DEMO_SOURCE_PROJECT}")})
    if lbi:
        groups.append({"title": "Lakebase", "items": lbi})
    uci = []
    if config.UC_CATALOG:
        uci.append({"label": "History · model · event logs", "value": f"{config.UC_CATALOG}.{config.UC_SCHEMA}",
                    "url": link(f"/explore/data/{config.UC_CATALOG}/{config.UC_SCHEMA}")})
        uci.append({"label": "Gateway staging", "value": f"{config.UC_CATALOG}.{config.GATEWAY_STORAGE_SCHEMA}",
                    "url": link(f"/explore/data/{config.UC_CATALOG}/{config.GATEWAY_STORAGE_SCHEMA}")})
    try:
        for d in rs.destinations():
            uci.append({"label": d["label"], "value": f"{d['catalog']}.{d['schema']}", "url": link(f"/explore/data/{d['catalog']}/{d['schema']}")})
    except Exception:  # noqa: BLE001
        pass
    if config.DEMO_CONNECTION:
        uci.append({"label": "Demo source connection", "value": config.DEMO_CONNECTION, "url": link(f"/explore/connections/{config.DEMO_CONNECTION}")})
    if uci:
        groups.append({"title": "Unity Catalog", "items": uci})
    jobs = [(n, j) for n, j in (("Setup", config.SETUP_JOB_ID), ("History + forecast model", config.HISTORY_JOB_ID),
                                ("Guardian (reconcile · retry · tickets)", config.GUARDIAN_JOB_ID)) if j]
    pj = [{"label": n, "value": j, "url": link(f"/jobs/{j}")} for n, j in jobs]
    try:
        lb = lakebase.get()
        if lb.configured:
            for r in repo.list_requests(lb, statuses=["live"], limit=20):
                if r.get("pipeline_id"):
                    pj.append({"label": f"Pipeline · {r['id']}", "value": r["title"], "url": link(f"/pipelines/{r['pipeline_id']}")})
    except Exception:  # noqa: BLE001
        pass
    if pj:
        groups.append({"title": "Pipelines & jobs", "items": pj})
    ai = []
    if config.LLM_ENDPOINT:
        ai.append({"label": "Assistant model", "value": config.LLM_ENDPOINT, "url": link(f"/ml/endpoints/{config.LLM_ENDPOINT}")})
    if config.MLFLOW_EXPERIMENT:
        ai.append({"label": "Forecast experiment (MLflow)", "value": config.MLFLOW_EXPERIMENT, "url": None})
    if ai:
        groups.append({"title": "AI", "items": ai})
    comp = []
    comp.append({"label": "This app", "value": config.APP_NAME, "url": link(f"/apps/{config.APP_NAME}")})
    if config.WAREHOUSE_ID:
        comp.append({"label": "SQL warehouse", "value": config.WAREHOUSE_ID, "url": link(f"/sql/warehouses/{config.WAREHOUSE_ID}")})
    groups.append({"title": "Compute", "items": comp})
    return {"groups": groups}


def warehouse_ok() -> bool:
    try:
        warehouse.query("SELECT 1 AS ok", timeout=20)
        return True
    except Exception:  # noqa: BLE001
        return False
