"""Deployment executor against a fake workspace that answers like the Lakeflow APIs (ids, errors)."""
import pytest

from conftest import as_user
from core import config, repo

ADMIN = as_user("deployer@example.com")


class FakeAPI:
    def __init__(self, fail_on: str | None = None):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.fail_on = fail_on
        self.n = 0
        self.validate_state = "COMPLETED"

    def do(self, method, path, body=None, query=None):
        self.calls.append((method, path, body))
        if self.fail_on and self.fail_on in path and method == "POST":
            raise RuntimeError("PERMISSION_DENIED: simulated failure")
        if method == "POST" and path == "/api/2.0/pipelines":
            if (body or {}).get("dry_run"):
                return {"effective_settings": body}
            self.n += 1
            kind = "gw" if "gateway_definition" in (body or {}) else "pl"
            return {"pipeline_id": f"{kind}-{self.n}"}
        if path == "/api/2.2/jobs/create":
            return {"job_id": 777}
        if path.endswith("/updates"):
            return {"update_id": "upd-1"}
        if "/updates/" in path and method == "GET":
            return {"update": {"state": self.validate_state}}
        return {}


class FakeW:
    def __init__(self, api):
        self.api_client = api


@pytest.fixture()
def fake(monkeypatch):
    from core import lakebase
    from modules.deploy import executor

    api = FakeAPI()
    monkeypatch.setattr(executor, "VALIDATE_POLL_S", 0.0)
    monkeypatch.setattr(lakebase, "workspace_client", lambda: FakeW(api))
    monkeypatch.setattr(executor, "workspace_client", lambda: FakeW(api))
    return api


def approved(client, title="Finance journals", cursor=None, **src):
    c = {"title": title, "source": {"connector": "postgresql", "pattern": "cdc", "connection": "conn_a", "database": "erp", **src},
         "objects": [{"schema": "finance", "table": "journal_header", "primary_keys": ["doc_id"], "cursor_column": cursor}],
         "destination": {"environment": "dev", "catalog": "cat", "schema": "foundation_dev"},
         "schedule": {"mode": "interval", "interval_minutes": 15, "sla_minutes": 30},
         "ownership": {"owner": "deployer@example.com", "classification": "internal", "domain": "finance"}}
    client.put("/api/admin/policies/auto_deploy_on_approval", json={"value": False}, headers=ADMIN)
    rid = client.post("/api/requests", json={"config": c}, headers=ADMIN).json()["request"]["id"]
    assert client.post(f"/api/requests/{rid}/submit", headers=ADMIN).status_code == 200
    assert client.post(f"/api/requests/{rid}/approve", json={"reason": "approved by owner"}, headers=ADMIN).status_code == 200
    return rid


def run(rid, store):
    from modules.deploy import executor

    r = repo.get_request(store, rid)
    assert repo.update_request(store, rid, {"status": "deploying"}, expect_status=("approved", "failed"))
    executor._run(rid, "deployer@example.com")
    return repo.get_request(store, rid), repo.list_steps(store, rid, r["version"])


def test_cdc_deploy_creates_gateway_pipeline_job_and_first_run(client, store, fake):
    rid = approved(client)
    r, steps = run(rid, store)
    assert r["status"] == "live", steps
    assert r["gateway_id"] == "gw-1" and r["pipeline_id"] == "pl-2" and r["job_id"] == "777"
    assert [s["status"] for s in steps] == ["done"] * 7 + ["skipped"]  # qualify is skipped: not a GxP request
    grants = [b for m, p, b in fake.calls if m == "PATCH" and "/unity-catalog/permissions/" in p]
    assert {g["changes"][0]["add"][0] for g in grants} == {"USE_CATALOG", "USE_SCHEMA", "SELECT"}  # read only, nothing else
    creates = [b for m, p, b in fake.calls if m == "POST" and p == "/api/2.0/pipelines" and not (b or {}).get("dry_run")]
    assert "gateway_definition" in creates[0] and creates[1]["ingestion_definition"]["ingestion_gateway_id"] == "gw-1"
    job = next(b for m, p, b in fake.calls if p == "/api/2.2/jobs/create")
    assert job["tasks"][0]["pipeline_task"]["pipeline_id"] == "pl-2"
    assert repo.gateway_for(store, "conn_a", "erp")["pipeline_id"] == "gw-1"


def test_second_request_reuses_the_shared_gateway(client, store, fake):
    run(approved(client), store)
    r2, steps = run(approved(client, title="Vendors"), store)
    assert r2["status"] == "live" and r2["gateway_id"] == "gw-1"
    gw_creates = [b for m, p, b in fake.calls if p == "/api/2.0/pipelines" and "gateway_definition" in (b or {}) and not b.get("dry_run")]
    assert len(gw_creates) == 1
    assert "Shared gateway" in next(s["detail"] for s in steps if s["step"] == "gateway")


def test_failure_is_visible_and_retry_does_not_duplicate(client, store, fake):
    rid = approved(client)
    fake.fail_on = "/api/2.2/jobs/create"
    r, steps = run(rid, store)
    assert r["status"] == "failed"
    assert {s["step"]: s["status"] for s in steps}["schedule"] == "failed"
    assert "PERMISSION_DENIED" in {s["step"]: s["detail"] for s in steps}["schedule"]
    fake.fail_on = None
    before = len([1 for m, p, b in fake.calls if p == "/api/2.0/pipelines" and not (b or {}).get("dry_run")])
    r, steps = run(rid, store)
    after = len([1 for m, p, b in fake.calls if p == "/api/2.0/pipelines" and not (b or {}).get("dry_run")])
    assert r["status"] == "live" and after == before  # gateway + pipeline were not created twice


def test_allow_deploy_off_stops_at_dry_run(client, store, fake, monkeypatch):
    monkeypatch.setattr(config, "ALLOW_DEPLOY", False)
    r, steps = run(approved(client), store)
    assert r["status"] == "approved" and r["pipeline_id"] is None
    assert [s["status"] for s in steps][1:] == ["skipped"] * 7


def test_query_based_without_cursor_never_reaches_approval(client, store):
    c = {"title": "q", "source": {"connector": "postgresql", "pattern": "query", "connection": "conn_a", "database": "erp"},
         "objects": [{"schema": "finance", "table": "journal_header", "primary_keys": ["doc_id"]}],
         "destination": {"environment": "dev", "catalog": "cat", "schema": "foundation_dev"},
         "ownership": {"owner": "deployer@example.com", "classification": "internal"}}
    rid = client.post("/api/requests", json={"config": c}, headers=ADMIN).json()["request"]["id"]
    r = client.post(f"/api/requests/{rid}/submit", headers=ADMIN)
    assert r.status_code == 409 and "cursor" in r.json()["detail"].lower()


def test_query_based_deploys_one_serverless_pipeline(client, store, fake):
    r, steps = run(approved(client, pattern="query", cursor="updated_at"), store)
    assert r["status"] == "live" and r["gateway_id"] is None
    assert {s["step"]: s["status"] for s in steps}["gateway"] == "skipped"
    created = [b for m, p, b in fake.calls if p == "/api/2.0/pipelines" and not (b or {}).get("dry_run")]
    assert len(created) == 1 and created[0]["ingestion_definition"]["connector_type"] == "QUERY_BASED"


def test_lakeflow_validation_failure_stops_before_schedule(client, store, fake):
    fake.validate_state = "FAILED"
    r, steps = run(approved(client), store)
    st = {s["step"]: s for s in steps}
    assert r["status"] == "failed" and st["pipeline"]["status"] == "failed" and "validation failed" in st["pipeline"]["detail"]
    assert st.get("schedule", {}).get("status") in (None, "pending")
    assert not [1 for m, p, b in fake.calls if p == "/api/2.2/jobs/create"]


# --- pause / unpause ------------------------------------------------------------------------------------------------
def _live(client, store, fake, title="Finance journals"):
    rid = approved(client, title=title, pattern="query", cursor="updated_at")
    r, _ = run(rid, store)
    assert r["status"] == "live" and r["pipeline_id"] and r["job_id"]
    fake.calls.clear()
    return r


def _schedule_calls(fake):
    return [b["new_settings"]["schedule"]["pause_status"] for m, p, b in fake.calls if p == "/api/2.2/jobs/update"]


def test_pause_then_unpause_runs_again(client, store, fake):
    r = _live(client, store, fake)
    rid, pid = r["id"], r["pipeline_id"]
    p = client.post(f"/api/pipelines/{rid}/pause", headers=ADMIN)
    assert p.status_code == 200, p.text
    assert _schedule_calls(fake) == ["PAUSED"]
    paths = [c[1] for c in fake.calls]
    assert "/api/2.2/jobs/runs/cancel-all" in paths and f"/api/2.0/pipelines/{pid}/stop" in paths
    snap = repo.snapshots(store)[rid]
    assert snap["paused_at"] and snap["paused_by"] == "deployer@example.com"
    card = next(i for i in client.get("/api/pipelines", headers=ADMIN).json()["items"] if i["request_id"] == rid)
    assert card["health"] == "paused" and card["state"] == "PAUSED" and card["paused_by"] == "deployer@example.com"

    # Run now on a paused pipeline is a one-off update: the schedule stays off, the pipeline stays paused
    fake.calls.clear()
    assert client.post(f"/api/pipelines/{rid}/run", headers=ADMIN).status_code == 200
    assert _schedule_calls(fake) == [] and repo.snapshots(store)[rid]["paused_at"]

    fake.calls.clear()
    u = client.post(f"/api/pipelines/{rid}/unpause", headers=ADMIN)
    assert u.status_code == 200, u.text
    assert _schedule_calls(fake) == ["UNPAUSED"]
    assert ("POST", f"/api/2.0/pipelines/{pid}/updates", {"full_refresh": False}) in fake.calls
    assert u.json()["update_id"] == "upd-1" and "update started" in u.json()["done"]
    assert not repo.snapshots(store)[rid]["paused_at"]
    actions = [a["action"] for a in repo.list_audit(store, "request", rid)]
    assert "pipeline.pause" in actions and "pipeline.unpause" in actions


def test_pause_all_is_admin_only_and_skips_paused(client, store, fake):
    a = _live(client, store, fake, "Orders A")
    b = _live(client, store, fake, "Orders B")
    assert client.post(f"/api/pipelines/{a['id']}/pause", headers=ADMIN).status_code == 200
    assert client.post("/api/pipelines/pause-all", headers=as_user("alice@example.com")).status_code == 403
    out = client.post("/api/pipelines/pause-all", headers=ADMIN).json()
    assert b["id"] in out["paused"] and a["id"] in out["already_paused"] and not out["failed"]
    assert all(repo.snapshots(store)[x]["paused_at"] for x in (a["id"], b["id"]))


def test_unpause_needs_an_operator(client, store, fake):
    r = _live(client, store, fake)
    assert client.post(f"/api/pipelines/{r['id']}/pause", headers=ADMIN).status_code == 200
    assert client.post(f"/api/pipelines/{r['id']}/unpause", headers=as_user("bob@example.com")).status_code == 403
    assert repo.snapshots(store)[r["id"]]["paused_at"]
