"""History job: learn the forecast model from real Lakeflow Connect history (system tables), evaluate it, publish it.

Runs as a serverless job task (Spark) or locally (SQL warehouse via the Statement Execution API):

    python jobs/history.py --root . [--publish] [--write-uc] [--snapshot app/modules/forecast/priors.json]

1. FEATURES  one row per ingestion pipeline / gateway seen in the last WINDOW days, account-wide:
             family (inferred from the pipeline name), pattern, update counts and durations (updates are sliced
             hourly in pipeline_update_timeline, so they are re-assembled per update_id), first load, auto-heal
             (a failure followed by a success within 60 min), DBUs from system.billing.usage.
             Data-quality filter: abandoned / broken pipelines (< 3 completed updates or < 20 % success) are dropped
             so a graveyard of demo pipelines does not drag reliability down.
2. FIT       per family|pattern lognormal statistics, shrunk toward the pattern and then the global level
             (empirical Bayes, k = SHRINK pipelines), plus list prices from system.billing.list_prices.
3. EVALUATE  25 % of pipelines held out (seeded): P50 error and P90 coverage of the update duration, DBU-per-update
             error and success-rate error, each against a global-median baseline.
4. PUBLISH   Lakebase forecast_model (active version) + UC tables hist_pipeline_features / forecast_benchmarks, and
             optionally an MLflow run with the parameters, metrics and the model JSON.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
from datetime import datetime, timezone
from statistics import median
from typing import Any, Callable

WINDOW = int(os.environ.get("HISTORY_WINDOW_DAYS", "365"))
SHRINK = 8.0
DB_FAMILIES = {"sqlserver", "postgresql", "mysql", "oracle", "teradata", "mariadb"}
SAAS_FAMILIES = {"salesforce", "workday", "servicenow", "sharepoint", "ga4", "jira", "zendesk", "hubspot", "netsuite",
                 "confluence", "google_drive", "dynamics365", "sftp"}
FAMILY_RULES = [
    ("salesforce", r"salesforce|sfdc"), ("sqlserver", r"sql.?server|mssql|sqlsrv|azure.?sql"),
    ("postgresql", r"postgres|pgsql|\bpg\b|_pg|pg_|lakebase"), ("mysql", r"mysql|mariadb"), ("oracle", r"oracle"),
    ("workday", r"workday"), ("servicenow", r"servicenow|snow_|_snow"), ("sharepoint", r"sharepoint"),
    ("ga4", r"ga4|google.?analytics"), ("sftp", r"sftp"), ("jira", r"jira"), ("hubspot", r"hubspot"),
    ("netsuite", r"netsuite"), ("zendesk", r"zendesk"), ("teradata", r"teradata"), ("confluence", r"confluence"),
    ("google_drive", r"google.?drive|gdrive"), ("dynamics365", r"dynamics|d365"),
]

FEATURES_SQL = f"""
WITH p AS (
  SELECT pipeline_id, workspace_id, pipeline_type, lower(name) AS nm,
         coalesce(settings.serverless, false) AS serverless, coalesce(settings.continuous, false) AS continuous,
         map_keys(configuration) AS conf_keys, create_time
  FROM system.lakeflow.pipelines
  WHERE pipeline_type IN ('INGESTION_PIPELINE', 'INGESTION_GATEWAY')
  QUALIFY row_number() OVER (PARTITION BY pipeline_id ORDER BY change_time DESC) = 1
),
u AS (
  SELECT pipeline_id, update_id, any_value(update_type) AS update_type,
         max_by(result_state, period_end_time) AS result_state,
         min(period_start_time) AS start_t, max(period_end_time) AS end_t
  FROM system.lakeflow.pipeline_update_timeline
  WHERE period_start_time >= date_sub(current_date(), {WINDOW})
    AND pipeline_id IN (SELECT pipeline_id FROM p)
  GROUP BY pipeline_id, update_id
),
u2 AS (
  SELECT *, timestampdiff(SECOND, start_t, end_t) AS dur_s,
         row_number() OVER (PARTITION BY pipeline_id ORDER BY start_t) AS rn,
         lead(result_state) OVER (PARTITION BY pipeline_id ORDER BY start_t) AS next_state,
         lag(result_state) OVER (PARTITION BY pipeline_id ORDER BY start_t) AS prev_state,
         timestampdiff(MINUTE, end_t, lead(start_t) OVER (PARTITION BY pipeline_id ORDER BY start_t)) AS gap_next_min,
         timestampdiff(SECOND, start_t, lead(start_t) OVER (PARTITION BY pipeline_id ORDER BY start_t)) / 60.0 AS cadence_min
  FROM u WHERE update_type IN ('REFRESH', 'FULL_REFRESH')
),
agg AS (
  SELECT pipeline_id,
         count(*) AS n_updates,
         count_if(result_state = 'COMPLETED') AS n_completed,
         count_if(result_state = 'FAILED') AS n_failed,
         count_if(result_state = 'FAILED' AND next_state = 'COMPLETED' AND gap_next_min <= 60) AS n_healed,
         count_if(result_state = 'FAILED' AND next_state = 'COMPLETED') AS n_next_ok,
         count_if(result_state = 'FAILED' AND coalesce(prev_state, '') <> 'FAILED') AS n_fail_starts,
         percentile(CASE WHEN result_state = 'COMPLETED' THEN dur_s END, 0.5) AS dur_p50_s,
         percentile(CASE WHEN result_state = 'COMPLETED' THEN dur_s END, 0.9) AS dur_p90_s,
         min_by(CASE WHEN result_state = 'COMPLETED' THEN dur_s END, CASE WHEN result_state = 'COMPLETED' THEN start_t END) AS first_load_s,
         count(DISTINCT date_trunc('HOUR', start_t)) AS active_hours,
         percentile(CASE WHEN result_state = 'COMPLETED' THEN cadence_min END, 0.5) AS cadence_min
  FROM u2 GROUP BY pipeline_id
),
b AS (
  SELECT usage_metadata.dlt_pipeline_id AS pipeline_id, sum(usage_quantity) AS dbus,
         count(DISTINCT date_trunc('HOUR', usage_start_time)) AS billed_hours,
         max(sku_name) AS sku
  FROM system.billing.usage
  WHERE usage_date >= date_sub(current_date(), {WINDOW}) AND billing_origin_product = 'LAKEFLOW_CONNECT'
    AND usage_metadata.dlt_pipeline_id IS NOT NULL
  GROUP BY 1
)
SELECT p.pipeline_id, p.workspace_id, p.pipeline_type, p.nm, p.serverless, p.continuous,
       array_contains(p.conf_keys, 'cursor_column') OR exists(p.conf_keys, k -> k LIKE '%qbc%') AS query_hint,
       agg.n_updates, agg.n_completed, agg.n_failed, agg.n_healed, agg.n_next_ok, agg.n_fail_starts, agg.dur_p50_s, agg.dur_p90_s, agg.first_load_s,
       agg.active_hours, agg.cadence_min, b.dbus, b.billed_hours, b.sku
FROM p LEFT JOIN agg USING (pipeline_id) LEFT JOIN b USING (pipeline_id)
"""

PRICES_SQL = """
SELECT sku_name, CAST(pricing.effective_list.default AS DOUBLE) AS usd
FROM system.billing.list_prices
WHERE price_end_time IS NULL AND currency_code = 'USD'
  AND sku_name IN ('ENTERPRISE_JOBS_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA', 'ENTERPRISE_DLT_ADVANCED_COMPUTE',
                   'PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA', 'PREMIUM_DLT_ADVANCED_COMPUTE')
"""


def family_of(name: str) -> str:
    for fam, rx in FAMILY_RULES:
        if re.search(rx, name or ""):
            return fam
    return "unknown"


def pattern_of(row: dict[str, Any], family: str) -> str:
    if row["pipeline_type"] == "INGESTION_GATEWAY":
        return "gateway"
    nm = row.get("nm") or ""
    if family in DB_FAMILIES:
        return "query" if (row.get("query_hint") or re.search(r"\bqbc\b|query", nm)) else "cdc"
    if family in SAAS_FAMILIES:
        return "files" if family == "sftp" else "saas"
    return "unknown"


def _f(v: Any, default: float = 0.0) -> float:
    try:
        return default if v is None else float(v)
    except (TypeError, ValueError):
        return default


def features(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    out, dropped = [], {"no_updates": 0, "abandoned": 0}
    for r in rows:
        fam = family_of(r.get("nm") or "")
        pat = pattern_of(r, fam)
        n_c, n_f = int(_f(r.get("n_completed"))), int(_f(r.get("n_failed")))
        rec = {**{k: r.get(k) for k in ("pipeline_id", "workspace_id", "pipeline_type", "serverless", "continuous")},
               "family": fam, "pattern": pat, "n_updates": int(_f(r.get("n_updates"))), "n_completed": n_c, "n_failed": n_f,
               "n_healed": int(_f(r.get("n_healed"))), "n_next_ok": int(_f(r.get("n_next_ok"))), "n_fail_starts": int(_f(r.get("n_fail_starts"))), "dur_p50_s": _f(r.get("dur_p50_s"), float("nan")),
               "dur_p90_s": _f(r.get("dur_p90_s"), float("nan")), "first_load_s": _f(r.get("first_load_s"), float("nan")),
               "dbus": _f(r.get("dbus")), "billed_hours": _f(r.get("billed_hours")), "active_hours": _f(r.get("active_hours"))}
        if pat == "gateway":
            if rec["dbus"] > 0 and rec["billed_hours"] >= 6:
                out.append(rec)
            continue
        if n_c == 0:
            dropped["no_updates"] += 1
            continue
        if n_c < 3 or n_c / max(1, n_c + n_f) < 0.2:
            dropped["abandoned"] += 1
            continue
        out.append(rec)
    return out, dropped


def _lognorm(values: list[float], sigma_floor: float = 0.25) -> tuple[float, float]:
    logs = [math.log(v) for v in values if v and v > 0 and math.isfinite(v)]
    if not logs:
        return math.log(60.0), 0.8
    mu = sum(logs) / len(logs)
    sd = math.sqrt(sum((x - mu) ** 2 for x in logs) / max(1, len(logs) - 1)) if len(logs) > 1 else 0.6
    return mu, max(sigma_floor, sd)


def fit_group(rows: list[dict[str, Any]]) -> dict[str, Any]:
    ing = [r for r in rows if r["pattern"] != "gateway"]
    upd_mu, upd_sigma = _lognorm([r["dur_p50_s"] for r in ing])
    first_mu, first_sigma = _lognorm([r["first_load_s"] for r in ing])
    per_upd = [r["dbus"] / max(1, r["n_completed"] + r["n_failed"]) for r in ing if r["dbus"] > 0 and not r["continuous"]]
    dbu_mu, dbu_sigma = _lognorm(per_upd, 0.35) if per_upd else (math.log(0.05), 0.9)
    cont = [r["dbus"] / max(1.0, r["billed_hours"]) for r in ing if r["continuous"] and r["dbus"] > 0]
    gws = [r["dbus"] / max(1.0, r["billed_hours"]) for r in rows if r["pattern"] == "gateway"]
    n_c = sum(r["n_completed"] for r in ing)
    n_f = sum(r["n_failed"] for r in ing)
    healed = sum(r["n_healed"] for r in ing)
    next_ok = sum(r.get("n_next_ok", 0) for r in ing)
    starts = sum(r.get("n_fail_starts", 0) for r in ing)
    return {
        "n_pipelines": len(ing), "n_updates": n_c + n_f, "workspaces": len({r["workspace_id"] for r in ing}),
        "upd_mu": upd_mu, "upd_sigma": upd_sigma, "success_rate": n_c / max(1, n_c + n_f),
        "heal_rate": healed / max(1, n_f), "retry_success": next_ok / max(1, n_f), "episode_rate": starts / max(1, n_c + n_f), "dbu_mu": dbu_mu, "dbu_sigma": dbu_sigma,
        "first_mu": first_mu, "first_sigma": first_sigma,
        "continuous_dbu_hour": median(cont) if cont else 0.0, "gateway_dbu_hour": median(gws) if gws else 0.0,
    }


def shrink(child: dict[str, Any], parent: dict[str, Any]) -> dict[str, Any]:
    n = float(child["n_pipelines"])
    w = n / (n + SHRINK)
    out = dict(child)
    for k in ("upd_mu", "upd_sigma", "success_rate", "heal_rate", "retry_success", "episode_rate", "dbu_mu", "dbu_sigma", "first_mu", "first_sigma"):
        out[k] = w * child[k] + (1 - w) * parent[k]
    for k in ("continuous_dbu_hour", "gateway_dbu_hour"):
        if not child[k]:
            out[k] = parent[k]
    return out


def fit(feats: list[dict[str, Any]], prices: dict[str, float]) -> dict[str, Any]:
    glob = fit_group(feats)
    patterns: dict[str, Any] = {}
    gateways = [r for r in feats if r["pattern"] == "gateway"]
    for pat in sorted({r["pattern"] for r in feats if r["pattern"] not in ("gateway", "unknown")}):
        rows = [r for r in feats if r["pattern"] == pat] + (gateways if pat == "cdc" else [])
        patterns[pat] = shrink(fit_group(rows), glob)
    families: dict[str, Any] = {}
    for fam in sorted({r["family"] for r in feats if r["family"] != "unknown"}):
        for pat in sorted({r["pattern"] for r in feats if r["family"] == fam and r["pattern"] not in ("gateway", "unknown")}):
            rows = [r for r in feats if r["family"] == fam and r["pattern"] == pat]
            gw = [r for r in gateways if r["family"] == fam] if pat == "cdc" else []
            parent = patterns.get(pat, glob)
            families[f"{fam}|{pat}"] = shrink(fit_group(rows + gw), parent)
    serverless = prices.get("ENTERPRISE_JOBS_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA") or prices.get("PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA") or 0.45
    gateway = prices.get("ENTERPRISE_DLT_ADVANCED_COMPUTE") or prices.get("PREMIUM_DLT_ADVANCED_COMPUTE") or 0.36
    return {
        "window_days": WINDOW, "global": glob, "patterns": patterns, "families": families,
        "usd_per_dbu": {"serverless": serverless, "gateway": gateway},
        # priors the history cannot learn account-wide (no row counts / VM bills in system tables); documented
        "table_scale": 0.22, "scd2_cost_factor": 1.15, "startup_s": 120, "gateway_startup_s": 420,
        "cdc_capture_lag_s": 45, "retry_delay_s": 300, "integrated_min_runtime_s": 600,
        "gateway_vm_usd_hour": 0.42, "free_dbu_day_workspace": 100, "continuous_dbu_hour_prior": 1.2, "mttr_minutes": 240,
        "throughput_rows_s": {"postgresql": 25000, "sqlserver": 30000, "mysql": 25000, "oracle": 20000,
                              "salesforce": 4000, "servicenow": 2500, "workday": 1500, "sharepoint": 800},
        "throughput_default_rows_s": 15000,
    }


def evaluate(feats: list[dict[str, Any]], prices: dict[str, float], seed: int = 42) -> list[dict[str, Any]]:
    sys.path.insert(0, os.path.join(ROOT, "app"))
    from modules.forecast import engine as eng  # noqa: E402

    ing = [r for r in feats if r["pattern"] not in ("gateway",) and math.isfinite(r["dur_p50_s"])]
    rnd = random.Random(seed)
    ids = sorted({r["pipeline_id"] for r in ing})
    rnd.shuffle(ids)
    hold = set(ids[: max(1, len(ids) // 4)])
    train = [r for r in feats if r["pipeline_id"] not in hold]
    test = [r for r in ing if r["pipeline_id"] in hold]
    params = fit(train, prices)
    base = params["global"]
    ape, ape_base, cover, dbu_ape, dbu_ape_base, sr_err = [], [], [], [], [], []
    for r in test:
        st, _ = eng.resolve(params, r["family"], r["pattern"])
        p50, p90 = math.exp(st.upd_mu), math.exp(st.upd_mu + eng.Z90 * st.upd_sigma)
        actual = r["dur_p50_s"]
        ape.append(abs(p50 - actual) / actual)
        ape_base.append(abs(math.exp(base["upd_mu"]) - actual) / actual)
        cover.append(1.0 if actual <= p90 else 0.0)
        n = r["n_completed"] + r["n_failed"]
        if r["dbus"] > 0 and n > 0 and not r["continuous"]:
            a = r["dbus"] / n
            dbu_ape.append(abs(math.exp(st.dbu_mu) - a) / a)
            dbu_ape_base.append(abs(math.exp(base["dbu_mu"]) - a) / a)
        sr_err.append(abs(st.success_rate - r["n_completed"] / max(1, n)))
    med = lambda xs: (median(xs) * 100.0) if xs else float("nan")  # noqa: E731
    return [
        {"name": "Update duration P50 error", "value": round(med(ape), 1), "unit": "% MdAPE",
         "note": f"median absolute % error on {len(test)} held-out pipelines; global baseline {med(ape_base):.1f}%"},
        {"name": "Update duration P90 coverage", "value": round(sum(cover) / max(1, len(cover)) * 100, 1), "unit": "%",
         "note": "share of held-out pipelines whose median update stays under the predicted P90 (target ~90%)"},
        {"name": "DBU per update error", "value": round(med(dbu_ape), 1), "unit": "% MdAPE",
         "note": f"{len(dbu_ape)} held-out billed pipelines; global baseline {med(dbu_ape_base):.1f}%"},
        {"name": "Success-rate error", "value": round((median(sr_err) if sr_err else 0) * 100, 1), "unit": "pts",
         "note": "median absolute error of the predicted success rate, percentage points"},
    ]


# --- execution backends ------------------------------------------------------------------------------------------
ROOT = "."


def runner() -> Callable[[str], list[dict[str, Any]]]:
    try:
        from pyspark.sql import SparkSession  # type: ignore

        spark = SparkSession.getActiveSession() or SparkSession.builder.getOrCreate()
        if spark is not None and os.environ.get("HISTORY_USE_WAREHOUSE") != "1":
            return lambda sql: [r.asDict() for r in spark.sql(sql).collect()]
    except Exception:  # noqa: BLE001 - not on Databricks compute
        pass
    sys.path.insert(0, os.path.join(ROOT, "app"))
    from core import warehouse  # noqa: E402

    return lambda sql: warehouse.query(sql, timeout=600)


def publish_lakebase(version: str, model: dict[str, Any], metrics: list[dict[str, Any]]) -> None:
    sys.path.insert(0, os.path.join(ROOT, "app"))
    from psycopg.types.json import Jsonb  # noqa: E402

    from core import config, lakebase  # noqa: E402

    lb = lakebase.get()
    s = config.LAKEBASE_SCHEMA
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"UPDATE {s}.forecast_model SET active = false WHERE active")
        cur.execute(f"INSERT INTO {s}.forecast_model (version, trained_at, params, metrics, active) VALUES (%s, now(), %s, %s, true) "
                    f"ON CONFLICT (version) DO UPDATE SET params = EXCLUDED.params, metrics = EXCLUDED.metrics, active = true, trained_at = now()",
                    (version, Jsonb(model), Jsonb(metrics)))


def write_uc(run: Callable[[str], list[dict[str, Any]]], feats: list[dict[str, Any]], model: dict[str, Any]) -> None:
    cat, sch = os.environ["UC_CATALOG"], os.environ.get("UC_SCHEMA", "data_ingestion_service")
    try:
        from pyspark.sql import SparkSession  # type: ignore

        spark = SparkSession.getActiveSession()
    except Exception:  # noqa: BLE001
        spark = None
    bench = [{"family": k.split("|")[0], "pattern": k.split("|")[1], **{kk: v[kk] for kk in (
        "n_pipelines", "n_updates", "workspaces", "success_rate", "retry_success", "gateway_dbu_hour")},
        "upd_p50_s": math.exp(v["upd_mu"]), "upd_p90_s": math.exp(v["upd_mu"] + 1.2816 * v["upd_sigma"]),
        "dbu_per_update": math.exp(v["dbu_mu"])} for k, v in model["families"].items()]
    if spark is not None:
        spark.createDataFrame([{k: (None if isinstance(v, float) and not math.isfinite(v) else v) for k, v in r.items()} for r in feats]) \
            .write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"`{cat}`.`{sch}`.hist_pipeline_features")
        spark.createDataFrame(bench).write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"`{cat}`.`{sch}`.forecast_benchmarks")
        spark.createDataFrame([{"version": model["version"], "params": json.dumps(model)}]).write.mode("overwrite") \
            .option("overwriteSchema", "true").saveAsTable(f"`{cat}`.`{sch}`.forecast_model")
    else:
        cols = "family STRING, pattern STRING, n_pipelines BIGINT, n_updates BIGINT, workspaces BIGINT, success_rate DOUBLE, retry_success DOUBLE, gateway_dbu_hour DOUBLE, upd_p50_s DOUBLE, upd_p90_s DOUBLE, dbu_per_update DOUBLE"
        vals = ",".join("('%s','%s',%d,%d,%d,%f,%f,%f,%f,%f,%f)" % (b["family"], b["pattern"], b["n_pipelines"], b["n_updates"], b["workspaces"],
                        b["success_rate"], b["retry_success"], b["gateway_dbu_hour"], b["upd_p50_s"], b["upd_p90_s"], b["dbu_per_update"]) for b in bench)
        run(f"CREATE OR REPLACE TABLE `{cat}`.`{sch}`.forecast_benchmarks ({cols})")
        if vals:
            run(f"INSERT INTO `{cat}`.`{sch}`.forecast_benchmarks VALUES {vals}")
        payload = json.dumps(model).replace("\\", "\\\\").replace("'", "\\'")
        run(f"CREATE OR REPLACE TABLE `{cat}`.`{sch}`.forecast_model AS SELECT '{model['version']}' AS version, '{payload}' AS params")


def log_mlflow(model: dict[str, Any], metrics: list[dict[str, Any]]) -> str | None:
    exp = os.environ.get("MLFLOW_EXPERIMENT")
    if not exp:
        return None
    try:
        import mlflow  # type: ignore

        mlflow.set_experiment(exp)
        with mlflow.start_run(run_name=f"forecast-{model['version']}") as run:
            mlflow.log_params({"window_days": model["window_days"], "families": len(model["families"]),
                               "n_pipelines": model["global"]["n_pipelines"], "shrink_k": SHRINK})
            for m in metrics:
                if isinstance(m["value"], (int, float)) and math.isfinite(m["value"]):
                    mlflow.log_metric(re.sub(r"[^a-z0-9_]+", "_", m["name"].lower()), m["value"])
            mlflow.log_dict(model, "forecast_model.json")
            return run.info.run_id
    except Exception as e:  # noqa: BLE001 - tracking is optional
        print(f"mlflow logging skipped: {type(e).__name__}: {e}")
        return None


def _jobs_dir() -> str:
    """spark_python_task exec()s the file (no __file__): fall back to <--root>/jobs."""
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:
        a = sys.argv
        return os.path.join(a[a.index("--root") + 1] if "--root" in a else ".", "jobs")


def main(argv: list[str] | None = None) -> int:
    global ROOT
    sys.path.insert(0, _jobs_dir())
    import _bootstrap  # noqa: E402

    _bootstrap.init(argv)
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--publish", action="store_true", help="write the active model to Lakebase")
    ap.add_argument("--write-uc", action="store_true", help="write features / benchmarks / model to Unity Catalog")
    ap.add_argument("--snapshot", default="", help="also write the model JSON to this path (the built-in tier)")
    a, _ = ap.parse_known_args(argv)
    ROOT = a.root
    run = runner()
    cache = os.environ.get("HISTORY_CACHE")  # local iteration: reuse the raw feature rows
    if cache and os.path.exists(cache):
        raw = json.load(open(cache))
    else:
        raw = run(FEATURES_SQL)
        if cache:
            json.dump(raw, open(cache, "w"), default=str)
    feats, dropped = features(raw)
    prices = {r["sku_name"]: float(r["usd"]) for r in run(PRICES_SQL) if r.get("usd") is not None}
    model = fit(feats, prices)
    metrics = evaluate(feats, prices)
    version = datetime.now(timezone.utc).strftime("%Y%m%d.%H%M")
    model.update({"version": version, "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                  "training": {"raw_pipelines": len(raw), "kept": len(feats), "dropped": dropped,
                               "families": sorted({r['family'] for r in feats}),
                               "method": [
                                   "Account-wide system.lakeflow.pipelines + pipeline_update_timeline + billing.usage, last %d days" % WINDOW,
                                   "Connector family inferred from pipeline names (no source column in system tables)",
                                   "Abandoned pipelines dropped (< 3 completed updates or < 20% success)",
                                   "Lognormal per family|pattern, shrunk toward pattern then global (k = %g pipelines)" % SHRINK,
                                   "Freshness and SLA attainment by Monte Carlo over schedule, duration, failure and retry",
                                   "Holdout: 25% of pipelines, seeded; metrics vs a global-median baseline",
                                   "Tested and not used: schedule cadence (r = 0.04 with update duration, 0.11 with DBU per update)"]}})
    model["metrics"] = metrics
    print(json.dumps({"version": version, "kept": len(feats), "dropped": dropped,
                      "families": {k: v["n_pipelines"] for k, v in model["families"].items()}, "metrics": metrics,
                      "usd_per_dbu": model["usd_per_dbu"]}, indent=1))
    if a.snapshot:
        with open(a.snapshot, "w") as f:
            json.dump({**model, "version": f"builtin-{version}"}, f, indent=1, sort_keys=True)
    if a.write_uc:
        write_uc(run, feats, model)
    if a.publish:
        publish_lakebase(version, model, metrics)
    run_id = log_mlflow(model, metrics)
    if run_id:
        print(f"mlflow run {run_id}")
    return 0


if __name__ == "__main__":
    rc = main()
    if rc:  # never sys.exit(0): the job runner (IPython) reports SystemExit(0) as a failure
        raise SystemExit(rc)
