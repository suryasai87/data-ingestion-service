"""GxP e-signatures + promotion, ServiceNow (Table API simulator), per-user usage capture, OBO preview guard."""
import pytest

from conftest import as_user

ADMIN = as_user("deployer@example.com")
ALICE = as_user("alice@example.com")
BOB = as_user("bob@example.com")


def cfg(**kw):
    c = {"title": "Batch records", "source": {"connector": "postgresql", "pattern": "cdc", "connection": "conn_a", "database": "erp"},
         "objects": [{"schema": "quality", "table": "inspection_lot", "primary_keys": ["lot_id"]}],
         "destination": {"environment": "dev", "catalog": "cat", "schema": "foundation_dev"},
         "schedule": {"mode": "interval", "interval_minutes": 60, "sla_minutes": 120},
         "ownership": {"owner": "alice@example.com", "classification": "internal", "domain": "quality", "cost_center": "CC-QA"}}
    for k, v in kw.items():
        c[k] = {**c.get(k, {}), **v} if isinstance(v, dict) else v
    return c


@pytest.fixture()
def manual(client, store):
    assert client.put("/api/admin/policies/auto_deploy_on_approval", json={"value": False}, headers=ADMIN).status_code == 200


# --- e-signatures -------------------------------------------------------------------------------------------------
def test_pin_hash_and_seal():
    from modules.gxp import esign
    h = esign.hash_pin("482913")
    assert esign.check_pin("482913", h) and not esign.check_pin("482914", h) and "482913" not in h
    a = esign.manifest_hash("x@y.com", "Approved", "2026-11-01T10:00:00+00:00", "IR-1", 1, "abc")
    assert a != esign.manifest_hash("x@y.com", "Approved", "2026-11-01T10:00:00+00:00", "IR-1", 1, "abd")


def test_pin_rules_and_lockout(client, store):
    assert client.put("/api/gxp/pin", json={"pin": "12ab"}, headers=BOB).status_code == 400
    assert client.put("/api/gxp/pin", json={"pin": "246810"}, headers=BOB).json()["has_pin"] is True
    assert client.put("/api/gxp/pin", json={"pin": "135791"}, headers=BOB).status_code == 403  # needs the current PIN
    assert client.put("/api/gxp/pin", json={"pin": "135791", "current_pin": "246810"}, headers=BOB).status_code == 200
    from core.identity import Caller
    from modules.gxp import esign
    bob = Caller(email="bob@example.com", name="Bob")
    for _ in range(3):
        with pytest.raises(Exception):
            esign.verify(bob, "000000")
    with pytest.raises(Exception) as e:
        esign.verify(bob, "135791")  # right PIN, but locked
    assert "locked" in str(e.value).lower()


def test_gxp_approval_is_e_signed_and_independent(client, store, manual):
    c = cfg(ownership={"gxp": True})
    rid = client.post("/api/requests", json={"config": c}, headers=ALICE).json()["request"]["id"]
    assert client.post(f"/api/requests/{rid}/submit", headers=ALICE).status_code == 200
    client.post("/api/admin/approvers", json={"email": "bob@example.com", "scope": "domain:quality", "reason": "QA data owner"}, headers=ADMIN)
    # no PIN yet -> 409; requester can never sign -> 403
    assert client.post(f"/api/requests/{rid}/approve", json={"reason": "QA release", "signature": {"pin": "111111"}}, headers=BOB).status_code == 409
    client.put("/api/gxp/pin", json={"pin": "246810"}, headers=BOB)
    assert client.post(f"/api/requests/{rid}/approve", json={"reason": "QA release", "signature": {"pin": "999999"}}, headers=BOB).status_code == 403
    r = client.post(f"/api/requests/{rid}/approve", json={"reason": "QA release", "signature": {"pin": "246810", "printed_name": "Bob Builder"}}, headers=BOB)
    assert r.status_code == 200, r.text
    sigs = r.json()["gxp"]["signatures"]
    assert len(sigs) == 1 and sigs[0]["meaning"] == "Approved" and sigs[0]["printed_name"] == "Bob Builder" and sigs[0]["intact"]
    assert sigs[0]["config_hash"] == r.json()["versions"][0]["hash"]
    # tampering with the signature row is detected
    from core import repo
    store.execute(f"UPDATE {repo.S()}.e_signature SET meaning = 'Reviewed' WHERE request_id = %s", (rid,))
    from modules.gxp import esign
    assert esign.signatures(rid)[0]["intact"] is False


def test_gxp_request_cannot_target_prod_directly(client, store):
    store_cfg = cfg(ownership={"gxp": True}, destination={"environment": "prod", "catalog": "cat", "schema": "foundation_prod"})
    v = client.post("/api/validate", json={"config": store_cfg}, headers=ALICE).json()["checks"]
    assert {c["key"]: c["status"] for c in v}["gxp.promotion"] == "fail"


def test_promotion_needs_live_and_qualification(client, store, manual):
    from core import repo
    rid = client.post("/api/requests", json={"config": cfg(ownership={"gxp": True})}, headers=ALICE).json()["request"]["id"]
    assert client.post(f"/api/requests/{rid}/promote", json={"to": "uat"}, headers=ALICE).status_code == 409  # not live
    store.execute(f"UPDATE {repo.S()}.request SET status = 'live' WHERE id = %s", (rid,))
    r = client.post(f"/api/requests/{rid}/promote", json={"to": "prod"}, headers=ALICE)
    assert r.status_code == 409 and "one step" in r.json()["detail"]
    r = client.post(f"/api/requests/{rid}/promote", json={"to": "uat"}, headers=ALICE)
    assert r.status_code == 409 and "qualification" in r.json()["detail"]
    # a non-GxP live request promotes without qualification and keeps provenance
    rid2 = client.post("/api/requests", json={"config": cfg(title="Lots")}, headers=ALICE).json()["request"]["id"]
    store.execute(f"UPDATE {repo.S()}.request SET status = 'live' WHERE id = %s", (rid2,))
    import os
    os.environ.setdefault("DESTINATIONS_JSON", "")
    from core import config
    config.DESTINATIONS.append({"environment": "uat", "label": "Foundation · UAT", "catalog": "cat", "schema": "foundation_uat"}) \
        if not any(d["environment"] == "uat" for d in config.DESTINATIONS) else None
    client.put("/api/admin/policies/destinations", json={"value": config.DESTINATIONS}, headers=ADMIN)
    p = client.post(f"/api/requests/{rid2}/promote", json={"to": "uat"}, headers=ALICE)
    assert p.status_code == 200, p.text
    d = p.json()
    assert d["request"]["parent_id"] == rid2 and d["config"]["destination"]["schema"] == "foundation_uat"
    assert d["config"]["_promotion"]["from"] == rid2


# --- ServiceNow -----------------------------------------------------------------------------------------------------
def test_request_lifecycle_creates_and_updates_a_servicenow_request(client, store, manual):
    rid = client.post("/api/requests", json={"config": cfg()}, headers=ALICE).json()["request"]["id"]
    d = client.get(f"/api/requests/{rid}", headers=ALICE).json()
    link = [l for l in d["itsm"] if l["kind"] == "request"][0]
    assert link["number"].startswith("REQ") and d["request"]["ticket_number"] == link["number"]
    client.post(f"/api/requests/{rid}/submit", headers=ALICE)
    client.post("/api/admin/approvers", json={"email": "bob@example.com", "scope": "domain:*", "reason": "data owner"}, headers=ADMIN)
    client.post(f"/api/requests/{rid}/approve", json={"reason": "owner sign-off"}, headers=BOB)
    from modules.itsm import simulator
    rec = simulator.get("sc_request", link["sys_id"])
    assert rec["approval"] == "approved" and rec["request_state"] == "in_process"
    notes = [n["note"] for n in rec["work_notes_journal"]]
    assert any("pending approval" in n for n in notes) and any("approved" in n for n in notes)
    # the HTTP face of the simulator speaks the Table API
    q = client.get("/api/snow-sim/api/now/table/sc_request", params={"sysparm_query": f"u_dis_request={rid}"}).json()["result"]
    assert [x["number"] for x in q] == [link["number"]]


def test_cmdb_prefill_and_inbound_request(client, store):
    apps = client.get("/api/itsm/cmdb", params={"q": "quality"}).json()
    assert apps["source"] == "simulator" and apps["items"][0]["domain"] == "quality" and apps["items"][0]["gxp"] is True
    payload = {"table": "sc_req_item", "sys_id": "abc123", "number": "RITM0012345", "short_description": "Inspection lots to Foundation",
               "requested_for": "alice@example.com",
               "variables": {"connector": "postgresql", "connection": "conn_a", "database": "erp", "tables": "quality.inspection_lot",
                             "environment": "dev", "interval_minutes": 60, "owner": "alice@example.com", "classification": "internal", "domain": "quality"}}
    d = client.post("/api/itsm/servicenow/inbound", json=payload, headers=ALICE).json()
    assert d["request"]["channel"] == "servicenow" and d["request"]["ticket_number"] == "RITM0012345"
    assert d["config"]["objects"][0] == {**d["config"]["objects"][0], "schema": "quality", "table": "inspection_lot"}
    assert d["config"]["destination"]["schema"] == "foundation_dev"


def test_servicenow_outage_never_blocks_and_is_backfilled(client, store, monkeypatch):
    from modules.itsm import servicenow
    def down(*a, **k):
        raise servicenow.SnowError("ServiceNow POST -> 503")
    with monkeypatch.context() as m:
        m.setattr(servicenow, "call", down)
        rid = client.post("/api/requests", json={"config": cfg()}, headers=ALICE).json()["request"]["id"]  # still created
    assert servicenow.sync_missing() >= 1
    assert [l for l in servicenow.links(rid) if l["kind"] == "request" and l["sys_id"]]


def test_incident_opens_and_resolves_in_servicenow(store):
    from core import repo
    from modules.itsm import service as itsm, simulator, servicenow
    store.execute(f"INSERT INTO {repo.S()}.request (id, title, status, requester) VALUES ('IR-77', 't', 'live', 'a@x.com')")
    iid = repo.open_incident(store, "IR-77", "p1", "actionable", "open", "Needs action", "PERMISSION_DENIED on source")
    itsm.incident_opened("IR-77", iid, "Needs action", "PERMISSION_DENIED")
    inc = [l for l in servicenow.links("IR-77") if l["kind"] == "incident"][0]
    assert inc["number"].startswith("INC")
    itsm.incident_resolved("IR-77", iid, "fixed")
    assert simulator.get("incident", inc["sys_id"])["state"] == "6"


# --- usage + OBO -------------------------------------------------------------------------------------------------------
def test_every_call_is_attributed_to_the_user(client, store):
    from modules.usage import service as usage
    usage._last_seen.clear()  # process-wide session memory: start this test from "nobody seen yet"
    while not usage._q.empty():
        usage._q.get_nowait()
    client.get("/api/requests", headers=ALICE)
    client.post("/api/forecast", json={"config": cfg()}, headers=ALICE)
    client.get("/api/requests", headers={**BOB, "x-forwarded-access-token": "user-token"})
    usage.flush()
    a = client.get("/api/admin/usage", headers=ADMIN).json()
    by = {u["user_email"]: u for u in a["users"]}
    assert by["alice@example.com"]["api_calls"] >= 2 and by["alice@example.com"]["sessions"] >= 1
    assert by["bob@example.com"]["obo_calls"] >= 1
    assert client.get("/api/admin/usage", headers=ALICE).status_code == 403


def test_preview_needs_the_users_own_token(client, store):
    from core import repo
    rid = client.post("/api/requests", json={"config": cfg()}, headers=ALICE).json()["request"]["id"]
    store.execute(f"UPDATE {repo.S()}.request SET status = 'live' WHERE id = %s", (rid,))
    r = client.get(f"/api/requests/{rid}/preview", headers=ALICE)
    assert r.status_code == 403 and "on your behalf" in r.json()["detail"]


def test_access_summary_is_read_only_for_people(client, store):
    rid = client.post("/api/requests", json={"config": cfg(ownership={"readers": ["group:finance-analysts"]})}, headers=ALICE).json()["request"]["id"]
    a = client.get(f"/api/requests/{rid}/access", headers=ALICE).json()
    assert a["target"]["privileges"] == ["USE CATALOG", "USE SCHEMA", "SELECT"]
    assert set(a["target"]["readers"]) == {"alice@example.com", "group:finance-analysts"}
    assert a["source"]["who"] == "service principal only"
