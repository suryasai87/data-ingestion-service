"""API contract against a real (throwaway) Postgres: lifecycle, error order, degradation, admin delegation."""
import pytest

from conftest import as_user
from core import config

ADMIN = as_user("deployer@example.com")
ALICE = as_user("alice@example.com")
BOB = as_user("bob@example.com")


def cfg(**kw):
    c = {"title": "Finance journals", "source": {"connector": "postgresql", "pattern": "cdc", "connection": "conn_a", "database": "erp"},
         "objects": [{"schema": "finance", "table": "journal_header", "primary_keys": ["doc_id"]}],
         "destination": {"environment": "dev", "catalog": "cat", "schema": "foundation_dev"},
         "schedule": {"mode": "interval", "interval_minutes": 15, "sla_minutes": 30},
         "ownership": {"owner": "alice@example.com", "classification": "internal", "domain": "finance", "cost_center": "CC-1"}}
    for k, v in kw.items():
        c[k] = {**c.get(k, {}), **v} if isinstance(v, dict) else v
    return c


@pytest.fixture()
def manual_deploy(client, store):
    r = client.put("/api/admin/policies/auto_deploy_on_approval", json={"value": False}, headers=ADMIN)
    assert r.status_code == 200, r.text


# --- reads never 500 ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize("path", ["/api/health", "/api/brand", "/api/me", "/api/home", "/api/requests", "/api/connectors",
                                  "/api/forecast/model", "/api/platform/resources", "/api/destinations", "/api/pipelines"])
def test_reads_degrade_when_store_is_down(client, no_store, path):
    r = client.get(path, headers=ALICE)
    assert r.status_code == 200, (path, r.text)
    body = r.json()
    if "source" in body:
        assert body["source"] in ("synthetic", "warehouse", "workspace", "lakebase")


def test_requests_fall_back_to_labelled_samples(client, no_store):
    body = client.get("/api/requests", headers=ALICE).json()
    assert body["source"] == "synthetic" and all(i["id"].startswith("IR-SAMPLE") for i in body["items"])


# --- write error order: 400 -> 503 -> 403 -> 409 ---------------------------------------------------------------------
def test_400_before_503(client, no_store):
    assert client.post("/api/requests", json={"config": {"objects": "nope"}}, headers=ALICE).status_code == 400
    assert client.post("/api/requests", json={"config": cfg()}, headers=ALICE).status_code == 503


def test_kiosk_is_503(client, store, monkeypatch):
    monkeypatch.setattr(config, "ALLOW_MUTATIONS", False)
    assert client.post("/api/requests", json={"config": cfg()}, headers=ALICE).status_code == 503
    assert client.get("/api/me", headers=ALICE).json()["kiosk"] is True


def test_admin_endpoints_403_for_non_admin(client, store):
    assert client.get("/api/admin/admins", headers=ALICE).status_code == 403
    assert client.post("/api/admin/admins", json={"email": "x@y.com", "reason": "because"}, headers=ALICE).status_code == 403


# --- lifecycle ----------------------------------------------------------------------------------------------------
def test_lifecycle_versioning_and_approval(client, store, manual_deploy):
    d = client.post("/api/requests", json={"config": cfg(), "channel": "app"}, headers=ALICE).json()
    rid = d["request"]["id"]
    assert d["request"]["status"] == "draft" and d["request"]["version"] == 1 and d["can"]["edit"]
    assert d["forecast"] and d["forecast"]["cost"]["month"]["p50"] > 0

    d2 = client.put(f"/api/requests/{rid}", json={"config": cfg(schedule={"interval_minutes": 30})}, headers=ALICE).json()
    assert d2["request"]["version"] == 2
    assert [v["version"] for v in d2["versions"]] == [2, 1] and d2["versions"][0]["hash"] != d2["versions"][1]["hash"]
    assert client.put(f"/api/requests/{rid}", json={"config": cfg()}, headers=BOB).status_code == 403

    s = client.post(f"/api/requests/{rid}/submit", headers=ALICE)
    assert s.status_code == 200, s.text
    assert s.json()["request"]["status"] == "pending_approval"
    assert client.put(f"/api/requests/{rid}", json={"config": cfg()}, headers=ALICE).status_code == 409

    # Bob is not an approver yet: 403; reason required first: 400
    assert client.post(f"/api/requests/{rid}/approve", json={"reason": "x"}, headers=BOB).status_code == 400
    assert client.post(f"/api/requests/{rid}/approve", json={"reason": "looks right"}, headers=BOB).status_code == 403
    g = client.post("/api/admin/approvers", json={"email": "bob@example.com", "scope": "domain:finance", "reason": "finance data owner"}, headers=ADMIN)
    assert g.status_code == 200, g.text
    appr = client.get("/api/requests?scope=approvals", headers=BOB).json()["items"]
    assert [a["id"] for a in appr] == [rid]
    a = client.post(f"/api/requests/{rid}/approve", json={"reason": "owner sign-off"}, headers=BOB)
    assert a.status_code == 200, a.text
    body = a.json()
    assert body["request"]["status"] == "approved"
    actions = [t["action"] for t in body["timeline"]]
    assert actions[:1] == ["request.create"] and "request.submit" in actions and "request.approve" in actions
    assert client.post(f"/api/requests/{rid}/approve", json={"reason": "again please"}, headers=BOB).status_code == 409


def test_independent_approval_for_confidential(client, store, manual_deploy):
    c = cfg(ownership={"classification": "confidential", "justification": "month-end close reporting for finance"})
    rid = client.post("/api/requests", json={"config": c}, headers=ADMIN).json()["request"]["id"]
    assert client.post(f"/api/requests/{rid}/submit", headers=ADMIN).status_code == 200
    r = client.post(f"/api/requests/{rid}/approve", json={"reason": "self approval"}, headers=ADMIN)
    assert r.status_code == 403 and "someone other" in r.json()["detail"]


def test_submit_blocked_by_failing_checks(client, store):
    rid = client.post("/api/requests", json={"config": cfg(objects=[])}, headers=ALICE).json()["request"]["id"]
    r = client.post(f"/api/requests/{rid}/submit", headers=ALICE)
    assert r.status_code == 409 and "Configuration complete" in r.json()["detail"]


def test_cancel_needs_reason_and_owner(client, store):
    rid = client.post("/api/requests", json={"config": cfg()}, headers=ALICE).json()["request"]["id"]
    assert client.post(f"/api/requests/{rid}/cancel", json={}, headers=ALICE).status_code == 400
    assert client.post(f"/api/requests/{rid}/cancel", json={"reason": "not needed"}, headers=BOB).status_code == 403
    assert client.post(f"/api/requests/{rid}/cancel", json={"reason": "not needed"}, headers=ALICE).json()["request"]["status"] == "cancelled"


def test_spec_endpoint(client, store):
    rid = client.post("/api/requests", json={"config": cfg()}, headers=ALICE).json()["request"]["id"]
    s = client.get(f"/api/requests/{rid}/spec", headers=ALICE).json()
    assert s["gateway"]["gateway_definition"]["connection_name"] == "conn_a"
    assert "resources:" in s["bundle_yaml"]


# --- admin delegation -----------------------------------------------------------------------------------------------
def test_admin_grant_takes_effect_immediately_and_guards(client, store):
    assert client.get("/api/me", headers=ALICE).json()["is_admin"] is False
    assert client.post("/api/admin/admins", json={"email": "alice@example.com"}, headers=ADMIN).status_code == 400  # reason
    r = client.post("/api/admin/admins", json={"email": "alice@example.com", "reason": "platform team lead"}, headers=ADMIN)
    assert r.status_code == 200
    assert client.get("/api/me", headers=ALICE).json()["is_admin"] is True  # no redeploy
    items = {i["email"]: i for i in client.get("/api/admin/admins", headers=ALICE).json()["items"]}
    assert items["deployer@example.com"]["source"] == "deployer" and not items["deployer@example.com"]["removable"]
    assert items["alice@example.com"]["granted_by"] == "deployer@example.com"
    assert client.request("DELETE", "/api/admin/admins/deployer@example.com", json={"reason": "try it"}, headers=ALICE).status_code == 409
    assert client.request("DELETE", "/api/admin/admins/alice@example.com", json={"reason": "role change"}, headers=ADMIN).status_code == 200
    assert client.get("/api/me", headers=ALICE).json()["is_admin"] is False
    audit = [a["action"] for a in client.get("/api/admin/audit", headers=ADMIN).json()["items"]]
    assert "admin.grant" in audit and "admin.revoke" in audit


def test_bootstrap_admin_works_when_store_is_down(client, no_store):
    assert client.get("/api/me", headers=ADMIN).json()["is_admin"] is True
    assert client.post("/api/admin/admins", json={"email": "x@y.com", "reason": "need help"}, headers=ADMIN).status_code == 503


def test_policy_validation(client, store):
    assert client.put("/api/admin/policies/min_interval_minutes", json={"value": "abc"}, headers=ADMIN).status_code == 400
    assert client.put("/api/admin/policies/nope", json={"value": 1}, headers=ADMIN).status_code == 400
    r = client.put("/api/admin/policies/min_interval_minutes", json={"value": 30}, headers=ADMIN)
    assert r.status_code == 200
    v = client.post("/api/validate", json={"config": cfg()}, headers=ALICE).json()["checks"]
    assert {c["key"]: c["status"] for c in v}["policy.schedule"] == "fail"


def test_connector_toggle_blocks_requests(client, store):
    assert client.put("/api/connectors/postgresql", json={"enabled": False}, headers=ALICE).status_code == 403
    assert client.put("/api/connectors/postgresql", json={"enabled": False}, headers=ADMIN).json()["enabled"] is False
    v = client.post("/api/validate", json={"config": cfg()}, headers=ALICE).json()["checks"]
    assert {c["key"]: c["status"] for c in v}["connector.available"] == "fail"


# --- assistant (rules mode: no LLM offline) ------------------------------------------------------------------------
def test_assistant_rules_mode_drafts_and_asks(client, store):
    r = client.post("/api/assistant/chat", json={"message": "Ingest postgres tables finance.journal_header and finance.journal_line into Foundation dev every 15 minutes"}, headers=ALICE).json()
    assert r["llm"] == "rules"
    d = r["draft"]
    assert d["source"]["connector"] == "postgresql" and d["schedule"]["interval_minutes"] == 15
    assert [o["table"] for o in d["objects"]] == ["journal_header", "journal_line"]
    assert "data owner" in r["missing"] and r["ready"] is False
    r2 = client.post("/api/assistant/chat", json={"session_id": r["session_id"], "message": "Owner alice@example.com, internal, finance"}, headers=ALICE).json()
    assert r2["draft"]["ownership"]["owner"] == "alice@example.com" and r2["draft"]["ownership"]["classification"] == "internal"
    assert "data owner" not in r2["missing"]
    # another user cannot continue Alice's session
    r3 = client.post("/api/assistant/chat", json={"session_id": r["session_id"], "message": "hello"}, headers=BOB).json()
    assert r3["session_id"] != r["session_id"]


def test_assistant_explains_sap_is_an_extension(client, store):
    r = client.post("/api/assistant/chat", json={"message": "Ingest SAP HANA tables BKPF and BSEG into Foundation every 15 minutes"}, headers=ALICE).json()
    assert r["draft"]["source"]["connector"] == "sap"
    assert any(c["key"] == "connector.available" and c["status"] == "fail" for c in r["checks"])


def test_forecast_endpoint_and_model_card(client, store):
    f = client.post("/api/forecast", json={"config": cfg()}, headers=ALICE).json()
    assert f["source"] == "synthetic" and f["model_version"].startswith("builtin")
    m = client.get("/api/forecast/model").json()
    assert m["n_pipelines"] > 100 and len(m["metrics"]) == 4 and m["benchmarks"]


def test_partial_snapshot_upsert_on_a_new_row(store):
    from core import repo
    repo.upsert_snapshot(store, "IR-X", {"pipeline_id": "p1", "recon": {"status": "match"}})  # no incidents_open
    repo.upsert_snapshot(store, "IR-X", {"pipeline_id": "p1", "incidents_open": 2})
    repo.upsert_snapshot(store, "IR-X", {"pipeline_id": "p1", "health": "healthy"})
    s = repo.snapshots(store)["IR-X"]
    assert s["incidents_open"] == 2 and s["recon"] == {"status": "match"} and s["health"] == "healthy"


def test_uc_catalog_source_never_gets_a_cdc_suggestion(client, store):
    c = cfg(source={"pattern": "query", "via": "uc_catalog", "connection": "dis_erp_source"},
            objects=[{"schema": "finance", "table": "journal_header", "primary_keys": ["doc_id"], "cursor_column": "updated_at"}])
    f = client.post("/api/forecast", json={"config": c}, headers=ALICE).json()
    assert not [r for r in f["recommendations"] if r["id"] == "cdc"]


def test_unexpected_write_error_is_json(client, store, monkeypatch):
    from modules.requests import service as rs
    def boom(*a, **k):
        raise RuntimeError("kaboom")
    monkeypatch.setattr(rs, "create", boom)
    r = TestClientNoRaise(client).post("/api/requests", json={"config": cfg()}, headers=ALICE)
    assert r.status_code == 500 and "kaboom" in r.json()["detail"]


def TestClientNoRaise(client):
    from fastapi.testclient import TestClient
    return TestClient(client.app, raise_server_exceptions=False)


def test_paused_pipeline_reads_as_paused_not_failing(store, monkeypatch):
    from core import repo
    from modules.monitor import service as monitor
    monkeypatch.setattr(monitor, "_pipeline", lambda pid: {"state": "IDLE", "latest_updates": [{"state": "COMPLETED", "creation_time": "2026-10-31T10:00:00Z", "update_id": "u"}]})
    monkeypatch.setattr(monitor, "_rows_last_update", lambda rid, uid: None)
    r = {"id": "IR-9", "title": "t", "pipeline_id": "p9", "status": "live", "sla_minutes": 60, "job_id": "1", "forecast": None,
         "channel": "app", "requester": "a@x.com", "created_at": "2026-10-31T09:00:00+00:00", "updated_at": "2026-10-31T09:00:00+00:00"}
    p = monitor.health_of(r, {"state": "PAUSED", "paused_at": "2026-11-01T10:00:00+00:00", "paused_by": "a@x.com"})
    assert (p["health"], p["state"], p["paused_by"]) == ("paused", "PAUSED", "a@x.com")
    assert monitor.health_of(r, None)["health"] in ("healthy", "degraded")
    # started by hand while paused: shows the real state, still flagged paused (the schedule is off)
    monkeypatch.setattr(monitor, "_pipeline", lambda pid: {"state": "RUNNING", "latest_updates": [{"state": "RUNNING", "creation_time": "2026-11-01T11:00:00Z", "update_id": "v"}]})
    p = monitor.health_of(r, {"paused_at": "2026-11-01T10:00:00+00:00"})
    assert p["state"] == "RUNNING" and p["health"] == "healthy" and p["paused_at"]


def test_a_pause_in_another_worker_invalidates_the_cached_pipeline_read():
    from datetime import datetime, timedelta, timezone
    from modules.monitor import service as monitor
    monitor._cache["p-x"] = (0.0, {"state": "RUNNING"})
    monitor._fetched["p-x"] = datetime.now(timezone.utc) - timedelta(seconds=5)
    monitor._drop_if_older("p-x", (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat())
    assert "p-x" in monitor._cache  # read taken after the pause: keep it
    monitor._drop_if_older("p-x", datetime.now(timezone.utc).isoformat())
    assert "p-x" not in monitor._cache and "p-x" not in monitor._fetched
