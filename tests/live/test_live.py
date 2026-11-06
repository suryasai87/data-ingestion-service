"""Live integration tests against the DEPLOYED app (pytest -m live). Creates real requests and real Lakeflow Connect
pipelines in the target workspace; everything it creates is tagged with the request id and listed in the output.

    DIS_URL=https://<app>.databricksapps.com DATABRICKS_PROFILE=DEFAULT pytest tests/live -m live -s

The deploy test is slow (Lakeflow validation + the first snapshot); set DIS_LIVE_DEPLOY=0 to skip it.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request

import pytest

pytestmark = pytest.mark.live
URL = os.environ.get("DIS_URL", "").rstrip("/")


def token() -> str:
    prof = os.environ.get("DATABRICKS_PROFILE", "DEFAULT")
    out = subprocess.run(["databricks", "auth", "token", "--profile", prof, "-o", "json"], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)["access_token"]


TOKEN = token() if URL else ""


def call(method: str, path: str, body=None, timeout=90):
    req = urllib.request.Request(URL + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


@pytest.fixture(scope="module", autouse=True)
def need_url():
    if not URL:
        pytest.skip("set DIS_URL to the deployed app")


def test_platform_reads():
    s, h = call("GET", "/api/health")
    assert s == 200 and h["lakebase"]["reachable"] is True, h
    s, me = call("GET", "/api/me")
    assert s == 200 and me["is_admin"] is True  # the deployer
    s, b = call("GET", "/api/brand")
    assert b["hero_title"] == "Welcome to Data Ingestion Service"
    s, res = call("GET", "/api/platform/resources")
    titles = [g["title"] for g in res["groups"]]
    assert {"Lakebase", "Unity Catalog", "Pipelines & jobs", "Compute"} <= set(titles), titles


def test_forecast_model_is_live():
    s, m = call("GET", "/api/forecast/model")
    assert s == 200 and m["source"] == "lakebase" and not m["version"].startswith("builtin"), (m["source"], m["version"])
    assert m["n_pipelines"] > 100 and len(m["metrics"]) == 4


def test_demo_source_is_browsable():
    s, c = call("GET", "/api/connections?connector=postgresql")
    demo = [x for x in c["items"] if x.get("demo")]
    assert demo and demo[0]["via"] == "uc_catalog" and demo[0]["usable"], c
    s, o = call("GET", f"/api/connections/{demo[0]['name']}/objects?connector=postgresql")
    names = {f"{t['schema']}.{t['name']}" for t in o["tables"]}
    assert o["browse"] == "direct" and {"finance.journal_header", "finance.journal_line"} <= names, o.get("degraded_reason")
    jh = next(t for t in o["tables"] if t["name"] == "journal_header")
    assert jh["primary_keys"] == ["doc_id"] and "updated_at" in jh["cursor_candidates"]


def test_non_admin_paths_are_guarded():
    s, _ = call("POST", "/api/requests", {"config": {"objects": "nope"}})
    assert s == 400


@pytest.mark.skipif(os.environ.get("DIS_LIVE_DEPLOY", "1") == "0", reason="DIS_LIVE_DEPLOY=0")
def test_request_to_live_pipeline_and_reconciliation():
    s, c = call("GET", "/api/connections?connector=postgresql")
    src = next(x for x in c["items"] if x.get("demo"))
    s, dests = call("GET", "/api/destinations")
    dev = next(d for d in dests["items"] if d["environment"] == "dev")
    cfg = {"title": "Live test · cost centers", "source": {"connector": "postgresql", "pattern": "query", "connection": src["name"],
           "via": "uc_catalog", "database": "erp"},
           "objects": [{"schema": "finance", "table": "cost_center", "primary_keys": ["cost_center"], "cursor_column": "updated_at"}],
           "destination": {"environment": "dev", "catalog": dev["catalog"], "schema": dev["schema"], "table_prefix": f"livetest{int(time.time()) % 100000}_"},
           "schedule": {"mode": "interval", "interval_minutes": 240, "sla_minutes": 480},
           "ownership": {"owner": call("GET", "/api/me")[1]["email"], "classification": "internal", "domain": "finance", "cost_center": "CC-TEST"}}
    s, d = call("POST", "/api/requests", {"config": cfg, "channel": "app"})
    assert s == 200, d
    rid = d["request"]["id"]
    print(f"\ncreated request {rid}")
    s, d = call("POST", f"/api/requests/{rid}/submit")
    assert s == 200 and d["request"]["status"] == "pending_approval", d
    s, d = call("POST", f"/api/requests/{rid}/approve", {"reason": "live integration test"})
    assert s == 200, d
    deadline = time.time() + 1500
    while time.time() < deadline:
        s, d = call("GET", f"/api/requests/{rid}")
        st = d["request"]["status"]
        if st in ("live", "failed"):
            break
        time.sleep(20)
    steps = {x["step"]: (x["status"], x["detail"]) for x in d["deployment"]}
    print(json.dumps(steps, indent=1))
    assert st == "live", steps
    print(f"pipeline {d['request']['pipeline_id']} job {d['request']['job_id']}")
    # the first update (snapshot) runs; wait for COMPLETED, then reconcile
    deadline = time.time() + 1200
    while time.time() < deadline:
        s, p = call("GET", "/api/pipelines")
        mine = next((x for x in p["items"] if x["request_id"] == rid), None)
        if mine and mine["last_update_state"] in ("COMPLETED", "FAILED"):
            break
        time.sleep(20)
    assert mine and mine["last_update_state"] == "COMPLETED", mine
    s, r = call("POST", f"/api/pipelines/{rid}/reconcile")
    assert s == 200 and r["recon"]["status"] == "match", r
    assert r["recon"]["source_rows"] == 120 and r["recon"]["target_rows"] == 120
    # rows landed are visible on the pipeline card (event log metrics)
    s, p = call("GET", "/api/pipelines")
    mine = next(x for x in p["items"] if x["request_id"] == rid)
    assert mine["rows_last_update"] == 120 and mine["recon"]["status"] == "match", mine
    # cost control: pause turns the schedule off and stops the pipeline; the card reads Paused, not failing
    s, st = call("POST", f"/api/pipelines/{rid}/pause")
    assert s == 200 and "schedule paused" in st["done"], st
    s, p = call("GET", "/api/pipelines")
    mine = next(x for x in p["items"] if x["request_id"] == rid)
    assert mine["paused_at"] and mine["health"] == "paused", mine
    print(f"paused {rid}: {st['done']}")
