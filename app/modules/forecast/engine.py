"""Forecast engine: predicted cost, time to first data, freshness and SLA attainment for an ingestion configuration.

Pure functions over a trained parameter set (``params``), so the same code runs in the app, the training job's holdout
evaluation and the unit tests. The parameters come from the history job (system.lakeflow.* + system.billing.usage,
account-wide, last N days), with hierarchical shrinkage already applied there:

    family stats  ->  pattern stats  ->  global stats        (basis.match says which level answered)

Model, per configuration (all durations in seconds):
- update duration D ~ LogNormal(mu_upd + ln m_T, sigma_upd), m_T = 1 + table_scale * ln(n_tables)
- DBU per update   ~ LogNormal(mu_dbu + 0.8 ln m_T, sigma_dbu); the sigma is the spread ACROSS pipelines, so the
  monthly P90 is the P90 pipeline's typical cost, not day-to-day noise
- continuous mode bills serverless hours instead of per update; CDC adds the ingestion gateway's 24x7 compute
- freshness L = wait for the next run U(0, I) + capture lag + D, plus retry/next-interval delay when an update fails
  (failure p = 1 - success_rate; it heals on one of the service's automatic retries with
  p = 1 - (1 - retry_success)^retries, otherwise it is ticketed and lasts mttr_minutes). Monte Carlo, fixed seed:
  the same input always gives the same answer
- first data = startup + rows / throughput when the row count is known, else the family's first-load distribution
- SLA attainment = P(L <= sla_minutes)
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

Z90 = 1.2815515655446004
SAMPLES = 20000


@dataclass(frozen=True)
class Stats:
    n_pipelines: int
    n_updates: int
    workspaces: int
    upd_mu: float
    upd_sigma: float
    success_rate: float
    heal_rate: float          # historical: failure healed by a success within 60 min (no retry policy)
    retry_success: float      # historical: P(next update succeeds | this one failed)
    episode_rate: float       # historical: failure streaks started per update (one streak = one incident)
    dbu_mu: float
    dbu_sigma: float
    first_mu: float
    first_sigma: float
    continuous_dbu_hour: float
    gateway_dbu_hour: float

    @staticmethod
    def of(d: dict[str, Any]) -> "Stats":
        fallback = {"retry_success": d.get("heal_rate", 0.5), "episode_rate": 1.0 - float(d.get("success_rate", 0.97))}
        vals = {k: d.get(k, fallback.get(k, 0)) for k in Stats.__dataclass_fields__}
        return Stats(**{k: (int(v) if k in ("n_pipelines", "n_updates", "workspaces") else float(v)) for k, v in vals.items()})


def heal_probability(st: Stats, retries: int) -> float:
    """The service retries a failed update automatically: P(one of `retries` attempts succeeds)."""
    if retries <= 0:
        return st.heal_rate
    p = min(0.995, max(0.0, st.retry_success))
    return 1.0 - (1.0 - p) ** retries


def _lognormal_q(mu: float, sigma: float, q: float) -> float:
    z = {0.5: 0.0, 0.9: Z90}[q]
    return math.exp(mu + z * sigma)


def resolve(params: dict[str, Any], family: str, pattern: str) -> tuple[Stats, str]:
    fam = (params.get("families") or {}).get(f"{family}|{pattern}")
    if fam and int(fam.get("n_pipelines", 0)) > 0:
        return Stats.of(fam), "family"
    pat = (params.get("patterns") or {}).get(pattern)
    if pat and int(pat.get("n_pipelines", 0)) > 0:
        return Stats.of(pat), "pattern"
    return Stats.of(params["global"]), "global"


def _n_tables(cfg: dict[str, Any]) -> int:
    return max(1, len(cfg.get("objects") or []))


def _rows(cfg: dict[str, Any]) -> float | None:
    rows = [o.get("rows_est") for o in (cfg.get("objects") or [])]
    known = [float(r) for r in rows if isinstance(r, (int, float)) and r >= 0]
    if not known:
        return None
    # unknown tables count as the median of the known ones
    med = float(np.median(known))
    return float(sum(known) + med * (len(rows) - len(known)))


def _schedule(cfg: dict[str, Any]) -> tuple[bool, float, float]:
    s = cfg.get("schedule") or {}
    continuous = s.get("mode") == "continuous"
    interval = float(s.get("interval_minutes") or 60)
    sla = float(s.get("sla_minutes") or max(30.0, interval * 2))
    return continuous, max(1.0, interval), max(1.0, sla)


def simulate_latency_min(st: Stats, cfg: dict[str, Any], params: dict[str, Any], seed: int = 7,
                         integrated: bool = False) -> np.ndarray:
    """Monte Carlo of 'minutes from a source change until it is queryable in the destination'."""
    rng = np.random.default_rng(seed)
    continuous, interval, _ = _schedule(cfg)
    pattern = (cfg.get("source") or {}).get("pattern", "cdc")
    m_t = 1.0 + float(params.get("table_scale", 0.22)) * math.log(_n_tables(cfg))
    d = rng.lognormal(st.upd_mu + math.log(m_t), st.upd_sigma, SAMPLES) / 60.0
    # gateway CDC captures continuously; integrated CDC reads the log when the update starts (no extra lag)
    lag = float(params.get("cdc_capture_lag_s", 45)) / 60.0 if pattern == "cdc" and not integrated else 0.0
    retry_delay = float(params.get("retry_delay_s", 300)) / 60.0
    if continuous:
        # micro-batches back to back: a change waits for the batch in flight, then one batch
        wait = rng.uniform(0, 1, SAMPLES) * d
        interval_eff = float(np.median(d))
    else:
        wait = rng.uniform(0, interval, SAMPLES)
        interval_eff = interval
    latency = wait + lag + d
    retries = int((cfg.get("operations") or {}).get("retries", 3))
    fail = rng.random(SAMPLES) > st.success_rate
    healed = rng.random(SAMPLES) < heal_probability(st, retries)
    # healed: one retry later (+ another update). Not healed: a persistent failure lasts until someone fixes it
    # (mttr_minutes, a stated assumption: history shows failures are sticky, ~4 % succeed on the next attempt).
    mttr = float(params.get("mttr_minutes", 240))
    extra = np.where(healed, retry_delay + d, np.maximum(mttr, interval_eff) + d)
    return latency + np.where(fail, extra, 0.0)


def predict(cfg: dict[str, Any], params: dict[str, Any], family_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    family_meta = family_meta or {}
    source = cfg.get("source") or {}
    family, pattern = str(source.get("connector") or "unknown"), str(source.get("pattern") or "cdc")
    st, match = resolve(params, family, pattern)
    continuous, interval, sla = _schedule(cfg)
    n_t = _n_tables(cfg)
    m_t = 1.0 + float(params.get("table_scale", 0.22)) * math.log(n_t)
    usd = params.get("usd_per_dbu") or {}
    usd_serverless = float(usd.get("serverless", 0.35))
    usd_gateway = float(usd.get("gateway", 0.30))
    scd2 = (cfg.get("schema") or {}).get("scd_type") == "SCD_TYPE_2"
    integrated = pattern == "cdc" and family_meta.get("cdc_architecture") == "integrated"
    scd_factor = float(params.get("scd2_cost_factor", 1.15)) if scd2 else 1.0

    # --- cost --------------------------------------------------------------------------------------------------
    breakdown: list[tuple[str, float, float]] = []  # (label, p50 $/month, p90 $/month)
    if continuous:
        h = (st.continuous_dbu_hour or float(params.get("continuous_dbu_hour_prior", 1.2))) * m_t * scd_factor
        p50 = h * 24 * 30 * usd_serverless
        breakdown.append(("Continuous ingestion (serverless)", p50, p50 * math.exp(Z90 * st.dbu_sigma * 0.6)))
        updates_day = 1440.0 / max(1.0, math.exp(st.upd_mu) / 60.0)
    else:
        updates_day = 1440.0 / interval
        mu = st.dbu_mu + 0.8 * math.log(m_t)
        if integrated:
            floor = float(params.get("integrated_min_runtime_s", 600)) / max(math.exp(st.upd_mu), 1.0)
            mu += math.log(max(1.0, floor))
        per50, per90 = _lognormal_q(mu, st.dbu_sigma, 0.5), _lognormal_q(mu, st.dbu_sigma, 0.9)
        breakdown.append((f"Ingestion updates ({updates_day:,.0f}/day, serverless)",
                          per50 * updates_day * 30 * usd_serverless * scd_factor,
                          per90 * updates_day * 30 * usd_serverless * scd_factor))
    if pattern == "cdc" and not integrated and family_meta.get("gateway_shared"):
        breakdown.append(("Shared ingestion gateway (already running for this source)", 0.0, 0.0))
    elif pattern == "cdc" and not integrated:
        g = st.gateway_dbu_hour * 24 * 30 * usd_gateway
        breakdown.append(("Ingestion gateway DBUs (CDC capture, always on)", g, g * 1.25))
        vm = float(params.get("gateway_vm_usd_hour", 0.0)) * 24 * 30
        if vm > 0:
            breakdown.append(("Gateway cloud VMs (estimate, on-demand list)", vm, vm * 1.1))
    month50 = sum(b[1] for b in breakdown)
    month90 = sum(b[2] for b in breakdown)
    dbu_day = (month50 / 30.0) / max(usd_serverless, 1e-9)

    # --- first data ---------------------------------------------------------------------------------------------
    rows = _rows(cfg)
    new_gateway = pattern == "cdc" and not integrated and not family_meta.get("gateway_shared")
    startup = float(params.get("startup_s", 120)) + (float(params.get("gateway_startup_s", 420)) if new_gateway else 0.0)
    if rows is not None:
        thr = float((params.get("throughput_rows_s") or {}).get(family, params.get("throughput_default_rows_s", 20000)))
        base = startup + rows / max(thr, 1.0)
        first50, first90 = base, startup + (rows / max(thr, 1.0)) * math.exp(Z90 * 0.55)
    else:
        first50 = startup + _lognormal_q(st.first_mu + math.log(m_t), st.first_sigma, 0.5)
        first90 = startup + _lognormal_q(st.first_mu + math.log(m_t), st.first_sigma, 0.9)

    # --- freshness + SLA ----------------------------------------------------------------------------------------
    lat = simulate_latency_min(st, cfg, params, integrated=integrated)
    fresh50, fresh90 = float(np.percentile(lat, 50)), float(np.percentile(lat, 90))
    attainment = float(np.mean(lat <= sla) * 100.0)
    retries = int((cfg.get("operations") or {}).get("retries", 3))
    heal = heal_probability(st, retries)
    # incidents = failure EPISODES that the retries don't heal (a persistent failure is one ticket, not one per run)
    tickets = updates_day * 30 * min(st.episode_rate, 1 - st.success_rate) * (1 - heal)

    conf = "high" if (match == "family" and st.n_pipelines >= 30) else "medium" if (match != "global" and st.n_pipelines >= 8) else "low"

    total50 = max(month50, 1e-9)
    drivers = []
    top = max(breakdown, key=lambda b: b[1])
    drivers.append(f"{top[0]} is {top[1] / total50 * 100:.0f}% of the monthly cost.")
    drivers.append(f"Typical update takes {math.exp(st.upd_mu + math.log(m_t)):.0f}s (P50) for {n_t} table{'s' if n_t != 1 else ''}; "
                   f"{st.success_rate * 100:.1f}% of updates succeed; with {retries} automatic retr{'y' if retries == 1 else 'ies'} {heal * 100:.0f}% of failures heal without a ticket.")
    if not continuous:
        drivers.append(f"Every {interval:.0f} min = {updates_day:,.0f} updates a day; half of all changes wait < {interval / 2:.0f} min for the next run.")
    if rows is not None:
        drivers.append(f"Initial snapshot of ~{rows:,.0f} rows at the {family} throughput prior.")

    out = {
        "model_version": str(params.get("version", "builtin")),
        "basis": {"n_pipelines": st.n_pipelines, "n_updates": st.n_updates, "workspaces": st.workspaces,
                  "window_days": int(params.get("window_days", 90)), "match": match, "family": family},
        "cost": {"month": {"p50": round(month50, 2), "p90": round(month90, 2)}, "dbu_day": round(dbu_day, 2),
                 "usd_per_dbu": usd_serverless,
                 "breakdown": [{"label": b[0], "usd_month": round(b[1], 2), "pct": round(b[1] / total50 * 100, 1)} for b in breakdown]},
        "first_data_min": {"p50": round(first50 / 60.0, 1), "p90": round(first90 / 60.0, 1)},
        "freshness_min": {"p50": round(fresh50, 1), "p90": round(fresh90, 1)},
        "sla": {"target_min": sla, "attainment_pct": round(attainment, 1)},
        "reliability": {"success_rate": round(st.success_rate * 100, 1), "auto_heal_rate": round(heal * 100, 1),
                        "expected_tickets_month": round(tickets, 1)},
        "confidence": conf,
        "drivers": drivers,
        "recommendations": [],
    }
    out["cost"]["free_tier_note"] = (f"List price before the Lakeflow Connect free tier "
                                     f"({float(params.get('free_dbu_day_workspace', 100)):.0f} DBU/day per workspace, shared by all its pipelines).")
    out["recommendations"] = recommendations(cfg, params, out, family_meta)
    return out


def _with(cfg: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    new = {**cfg}
    for k, v in patch.items():
        new[k] = {**(cfg.get(k) or {}), **v} if isinstance(v, dict) else v
    return new


def _quick(cfg: dict[str, Any], params: dict[str, Any], meta: dict[str, Any] | None = None) -> dict[str, Any]:
    return predict(cfg, params, {**(meta or {}), "_no_recs": True})


def recommendations(cfg: dict[str, Any], params: dict[str, Any], base: dict[str, Any], meta: dict[str, Any]) -> list[dict[str, Any]]:
    """Deterministic what-ifs, each re-forecast with the same model, shown as one-click patches."""
    if meta.get("_no_recs"):
        return []
    recs: list[dict[str, Any]] = []
    continuous, interval, sla = _schedule(cfg)
    pattern = (cfg.get("source") or {}).get("pattern", "cdc")
    patterns = meta.get("patterns") or []
    att = base["sla"]["attainment_pct"]
    cost = base["cost"]["month"]["p50"]
    fresh = base["freshness_min"]["p90"]
    min_interval = float(meta.get("min_interval_minutes", 5))

    def rec(rid: str, title: str, detail: str, patch: dict[str, Any]) -> None:
        alt = _quick(_with(cfg, patch), params, meta)
        recs.append({"id": rid, "title": title, "detail": detail, "patch": patch,
                     "delta": {"cost_month": round(alt["cost"]["month"]["p50"] - cost, 2),
                               "freshness_p90_min": round(alt["freshness_min"]["p90"] - fresh, 1),
                               "sla_pct": round(alt["sla"]["attainment_pct"] - att, 1)}})

    if not continuous and att < 95.0:
        for cand in (60, 30, 15, 10, 5):
            if cand >= interval or cand < min_interval:
                continue
            alt = _quick(_with(cfg, {"schedule": {"interval_minutes": cand}}), params, meta)
            if alt["sla"]["attainment_pct"] >= 97.0:
                rec("tighten", f"Run every {cand} min to meet the {sla:.0f}-min SLA",
                    f"At every {interval:.0f} min only {att:.0f}% of changes land within {sla:.0f} min.",
                    {"schedule": {"interval_minutes": cand}})
                break
        else:
            if "cdc" in patterns or pattern == "cdc":
                rec("continuous", "Switch to continuous ingestion",
                    "No interval meets the SLA; continuous mode keeps freshness to minutes.", {"schedule": {"mode": "continuous"}})
    if not continuous and att >= 99.5 and interval < 240:
        cand = int(min(240, interval * 2))
        alt = _quick(_with(cfg, {"schedule": {"interval_minutes": cand}}), params, meta)
        if alt["sla"]["attainment_pct"] >= 97.0:
            rec("relax", f"Relax to every {cand} min and still meet the SLA",
                f"Freshness has headroom: {alt['sla']['attainment_pct']:.0f}% of changes would still land within {sla:.0f} min.",
                {"schedule": {"interval_minutes": cand}})
    if pattern == "cdc" and "query" in patterns and meta.get("cdc_architecture") != "integrated":
        rec("query", "Use query-based ingestion (no gateway)",
            "Serverless cursor reads, no always-on gateway. Hard deletes need a soft-delete flag or periodic full sync.",
            {"source": {"pattern": "query"}})
    if pattern == "query" and "cdc" in patterns:
        rec("cdc", "Use log-based CDC",
            "Captures hard deletes and every intermediate change; adds an always-on ingestion gateway.",
            {"source": {"pattern": "cdc"}})
    if (cfg.get("schema") or {}).get("scd_type") == "SCD_TYPE_2":
        rec("scd1", "Keep current state only (SCD type 1)",
            "History tracking adds storage and merge cost; keep it only where audit needs row history.",
            {"schema": {"scd_type": "SCD_TYPE_1"}})
    return recs[:4]
