"""Governance rules: golden vectors for checks, approval routing and lifecycle."""
import pytest

from core.errors import BadRequest, Conflict, Forbidden
from modules.catalog import registry
from modules.requests import rules

DESTS = [{"environment": "dev", "catalog": "cat", "schema": "foundation_dev", "allowed": True}]
POL = {k: v["value"] for k, v in rules.DEFAULT_POLICIES.items()}


def good(**kw):
    c = {"title": "t", "source": {"connector": "postgresql", "pattern": "cdc", "connection": "c"},
         "objects": [{"schema": "s", "table": "a", "primary_keys": ["id"]}],
         "destination": {"environment": "dev", "catalog": "cat", "schema": "foundation_dev"},
         "schedule": {"mode": "interval", "interval_minutes": 15, "sla_minutes": 30},
         "ownership": {"owner": "o@x.com", "classification": "internal"}}
    for k, v in kw.items():
        c[k] = {**c.get(k, {}), **v} if isinstance(v, dict) else v
    return rules.normalize(c)


def by_key(checks):
    return {c.key: c.status for c in checks}


def test_complete_config_passes():
    ks = by_key(rules.evaluate(good(), registry.get("postgresql"), POL, DESTS, 100))
    assert "fail" not in ks.values(), ks


@pytest.mark.parametrize("bad", [{"objects": "x"}, {"schedule": {"mode": "weekly"}}, {"ownership": {"classification": "secret"}},
                                 {"objects": [{"schema": "s"}]}, {"schema": {"scd_type": "SCD_9"}}])
def test_malformed_is_400(bad):
    base = {"title": "t", **bad}
    with pytest.raises(BadRequest):
        rules.normalize(base)


def test_incomplete_lists_what_is_missing():
    c = rules.normalize({"title": ""})
    ch = [x for x in rules.evaluate(c, None, POL, DESTS) if x.key == "config.complete"][0]
    assert ch.status == "fail" and "title" in ch.detail and "owner" in ch.detail


def test_destination_must_be_approved():
    ks = by_key(rules.evaluate(good(destination={"schema": "other"}), registry.get("postgresql"), POL, DESTS))
    assert ks["policy.destination"] == "fail"


def test_interval_floor_from_connector_and_policy():
    ks = by_key(rules.evaluate(good(source={"connector": "mysql"}, schedule={"interval_minutes": 5}), registry.get("mysql"), POL, DESTS))
    assert ks["policy.schedule"] == "fail"  # MySQL integrated CDC floor is 15
    ks = by_key(rules.evaluate(good(schedule={"interval_minutes": 5}), registry.get("postgresql"), {**POL, "min_interval_minutes": 10}, DESTS))
    assert ks["policy.schedule"] == "fail"


def test_confidential_needs_justification():
    ks = by_key(rules.evaluate(good(ownership={"classification": "confidential"}), registry.get("postgresql"), POL, DESTS))
    assert ks["policy.classification"] == "fail"
    ks = by_key(rules.evaluate(good(ownership={"classification": "confidential", "justification": "month-end close reporting"}),
                               registry.get("postgresql"), POL, DESTS))
    assert ks["policy.classification"] == "pass"


def test_query_based_needs_cursor_and_keys():
    ks = by_key(rules.evaluate(good(source={"pattern": "query"}), registry.get("postgresql"), POL, DESTS))
    assert ks["schema.cursor"] == "fail"
    c = good(source={"pattern": "query"}, objects=[{"schema": "s", "table": "a", "cursor_column": "updated_at"}])
    ks = by_key(rules.evaluate(c, registry.get("postgresql"), POL, DESTS))
    assert ks["schema.keys"] == "fail" and ks["schema.cursor"] == "pass"


def test_cdc_without_key_warns():
    ks = by_key(rules.evaluate(good(objects=[{"schema": "s", "table": "a"}]), registry.get("postgresql"), POL, DESTS))
    assert ks["schema.keys"] == "warn"


def test_extension_connector_fails_with_explanation():
    ch = [x for x in rules.evaluate(good(source={"connector": "sap", "pattern": "saas"}), {**registry.get("sap"), "enabled": True}, POL, DESTS)
          if x.key == "connector.available"][0]
    assert ch.status == "fail" and "extension" in ch.detail


def test_cost_over_cap_warns():
    ks = by_key(rules.evaluate(good(), registry.get("postgresql"), POL, DESTS, 99999))
    assert ks["policy.cost"] == "warn"


def test_duplicate_destination_tables_fail():
    c = good(objects=[{"schema": "a", "table": "x", "primary_keys": ["id"]}, {"schema": "b", "table": "x", "primary_keys": ["id"]}])
    assert by_key(rules.evaluate(c, registry.get("postgresql"), POL, DESTS))["schema.collisions"] == "fail"


REQ = {"requester": "r@x.com", "classification": "internal", "domain": "finance", "forecast_month_usd": 100}


def test_approval_routing():
    assert rules.can_approve("a@x.com", REQ, is_admin=False, approver_scopes=[], policies=POL)[0] is False
    assert rules.can_approve("a@x.com", REQ, is_admin=False, approver_scopes=["domain:finance"], policies=POL)[0] is True
    assert rules.can_approve("a@x.com", REQ, is_admin=False, approver_scopes=["domain:sales"], policies=POL)[0] is False
    assert rules.can_approve("a@x.com", REQ, is_admin=False, approver_scopes=["domain:*"], policies=POL)[0] is True
    # requester may approve internal data (owner self-service) ...
    assert rules.can_approve("r@x.com", REQ, is_admin=True, approver_scopes=[], policies=POL)[0] is True
    # ... but never confidential, even as an admin
    ok, why = rules.can_approve("r@x.com", {**REQ, "classification": "confidential"}, is_admin=True, approver_scopes=["domain:*"], policies=POL)
    assert ok is False and "someone other" in why
    # over the cost cap only an admin
    big = {**REQ, "forecast_month_usd": 5000}
    assert rules.can_approve("a@x.com", big, is_admin=False, approver_scopes=["domain:*"], policies=POL)[0] is False
    assert rules.can_approve("a@x.com", big, is_admin=True, approver_scopes=[], policies=POL)[0] is True


def test_transitions_and_reasons():
    rules.require_transition("draft", "submit")
    with pytest.raises(Conflict):
        rules.require_transition("live", "edit")
    with pytest.raises(Conflict):
        rules.require_transition("draft", "approve")
    with pytest.raises(BadRequest):
        rules.require_reason("ok", "approve")
    with pytest.raises(Forbidden):
        rules.require_actor(False, "no")


def test_cdc_is_refused_on_a_uc_catalog_source():
    c = good(source={"via": "uc_catalog", "connection": "dis_erp_source"})
    ch = {x.key: x for x in rules.evaluate(c, {**registry.get("postgresql"), "enabled": True}, POL, DESTS)}
    assert ch["pattern.supported"].status == "fail" and "query-based" in ch["pattern.supported"].detail
