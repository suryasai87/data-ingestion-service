"""Forecast engine: properties every forecast must satisfy, on the shipped built-in model."""
import json
import math
from pathlib import Path

import pytest

from modules.forecast import engine

PARAMS = json.loads((Path(__file__).resolve().parents[2] / "app/modules/forecast/priors.json").read_text())
CDC_META = {"patterns": ["cdc", "query"], "cdc_architecture": "gateway", "min_interval_minutes": 5}


def cfg(**kw):
    base = {"source": {"connector": "postgresql", "pattern": "cdc"},
            "objects": [{"schema": "finance", "table": "t1"}, {"schema": "finance", "table": "t2"}],
            "schema": {"scd_type": "SCD_TYPE_1"}, "schedule": {"mode": "interval", "interval_minutes": 15, "sla_minutes": 30},
            "operations": {"retries": 3}}
    for k, v in kw.items():
        base[k] = {**base.get(k, {}), **v} if isinstance(v, dict) else v
    return base


def test_deterministic():
    a = engine.predict(cfg(), PARAMS, CDC_META)
    b = engine.predict(cfg(), PARAMS, CDC_META)
    assert a == b


def test_more_frequent_costs_more_and_is_fresher():
    f5 = engine.predict(cfg(schedule={"interval_minutes": 5}), PARAMS, CDC_META)
    f60 = engine.predict(cfg(schedule={"interval_minutes": 60}), PARAMS, CDC_META)
    assert f5["cost"]["month"]["p50"] > f60["cost"]["month"]["p50"]
    assert f5["freshness_min"]["p90"] < f60["freshness_min"]["p90"]


def test_p90_at_least_p50():
    f = engine.predict(cfg(), PARAMS, CDC_META)
    for k in ("first_data_min", "freshness_min"):
        assert f[k]["p90"] >= f[k]["p50"]
    assert f["cost"]["month"]["p90"] >= f["cost"]["month"]["p50"]


def test_gateway_cost_only_for_gateway_cdc():
    gw = engine.predict(cfg(), PARAMS, CDC_META)
    assert any("gateway" in b["label"].lower() for b in gw["cost"]["breakdown"])
    integrated = engine.predict(cfg(source={"connector": "mysql"}), PARAMS, {**CDC_META, "cdc_architecture": "integrated"})
    assert not any("gateway" in b["label"].lower() for b in integrated["cost"]["breakdown"])
    query = engine.predict(cfg(source={"pattern": "query"}), PARAMS, CDC_META)
    assert not any("gateway" in b["label"].lower() for b in query["cost"]["breakdown"])
    assert query["cost"]["month"]["p50"] < gw["cost"]["month"]["p50"]


def test_shared_gateway_is_free_at_the_margin():
    new = engine.predict(cfg(), PARAMS, CDC_META)
    shared = engine.predict(cfg(), PARAMS, {**CDC_META, "gateway_shared": True})
    assert shared["cost"]["month"]["p50"] < new["cost"]["month"]["p50"]
    assert any(b["usd_month"] == 0 and "shared" in b["label"].lower() for b in shared["cost"]["breakdown"])
    assert shared["first_data_min"]["p50"] < new["first_data_min"]["p50"]  # no gateway start-up


def test_tighter_sla_is_harder_to_meet():
    loose = engine.predict(cfg(schedule={"sla_minutes": 120}), PARAMS, CDC_META)
    tight = engine.predict(cfg(schedule={"sla_minutes": 10}), PARAMS, CDC_META)
    assert tight["sla"]["attainment_pct"] < loose["sla"]["attainment_pct"]
    assert 0 <= tight["sla"]["attainment_pct"] <= 100


def test_rows_drive_first_data():
    small = engine.predict(cfg(objects=[{"schema": "s", "table": "a", "rows_est": 1000}]), PARAMS, CDC_META)
    big = engine.predict(cfg(objects=[{"schema": "s", "table": "a", "rows_est": 500_000_000}]), PARAMS, CDC_META)
    assert big["first_data_min"]["p50"] > small["first_data_min"]["p50"] * 10


def test_resolve_falls_back_family_pattern_global():
    _, m1 = engine.resolve(PARAMS, "salesforce", "saas")
    _, m2 = engine.resolve(PARAMS, "nonexistent", "saas")
    _, m3 = engine.resolve(PARAMS, "nonexistent", "nonexistent")
    assert (m1, m2, m3) == ("family", "pattern", "global")


def test_heal_probability_formula():
    st = engine.Stats.of({**PARAMS["global"], "retry_success": 0.5})
    assert engine.heal_probability(st, 1) == pytest.approx(0.5)
    assert engine.heal_probability(st, 3) == pytest.approx(0.875)
    assert engine.heal_probability(st, 0) == pytest.approx(st.heal_rate)


def test_recommendation_patches_are_reforecast():
    f = engine.predict(cfg(), PARAMS, CDC_META)
    q = [r for r in f["recommendations"] if r["id"] == "query"]
    assert q and q[0]["patch"] == {"source": {"pattern": "query"}}
    assert q[0]["delta"]["cost_month"] < 0  # no gateway = cheaper


def test_tighten_recommendation_when_sla_missed():
    f = engine.predict(cfg(schedule={"interval_minutes": 240, "sla_minutes": 30}), PARAMS, CDC_META)
    assert f["sla"]["attainment_pct"] < 95
    assert any(r["id"] in ("tighten", "continuous") for r in f["recommendations"])


def test_confidence_reflects_basis():
    sf = engine.predict(cfg(source={"connector": "salesforce", "pattern": "saas"}), PARAMS, {"patterns": ["saas"]})
    unknown = engine.predict(cfg(source={"connector": "nope", "pattern": "nope"}), PARAMS, {})
    assert unknown["confidence"] == "low" and unknown["basis"]["match"] == "global"
    assert sf["basis"]["match"] == "family" and sf["confidence"] in ("high", "medium")
    assert all(math.isfinite(x) for x in (sf["cost"]["month"]["p50"], sf["freshness_min"]["p90"]))


def test_incidents_count_episodes_not_failed_runs():
    p = json.loads(json.dumps(PARAMS))
    p["global"]["episode_rate"] = 0.001  # rare streaks
    for k in list(p["families"]) + list(p["patterns"]):
        (p["families"].get(k) or p["patterns"].get(k))["episode_rate"] = 0.001
    rare = engine.predict(cfg(), p, CDC_META)["reliability"]["expected_tickets_month"]
    base = engine.predict(cfg(), PARAMS, CDC_META)["reliability"]["expected_tickets_month"]
    assert rare < base
