"""Forecast service: the active model (Lakebase -> Lakehouse -> built-in snapshot) + predictions + the model card."""
from __future__ import annotations

import json
import math
import pathlib
import threading
import time
from typing import Any

from core import config, lakebase, repo, tiers, warehouse
from modules.catalog import registry
from modules.forecast import engine

PRIORS = pathlib.Path(__file__).resolve().parent / "priors.json"
CACHE_TTL = 300.0
_cache: dict[str, Any] = {}
_lock = threading.Lock()


def _builtin() -> dict[str, Any]:
    return json.loads(PRIORS.read_text())


def _from_lakebase() -> dict[str, Any]:
    m = repo.active_model(lakebase.get())
    if not m:
        raise LookupError("no active model in Lakebase yet (run the history job)")
    p = m["params"]
    p.setdefault("version", m["version"])
    p.setdefault("metrics", m.get("metrics") or [])
    return p


def _from_warehouse() -> dict[str, Any]:
    rows = warehouse.query(f"SELECT version, params FROM {config.uc('forecast_model')} LIMIT 1")
    if not rows:
        raise LookupError("no model in Unity Catalog yet")
    return json.loads(rows[0]["params"])


def params() -> tuple[dict[str, Any], str, str | None]:
    now = time.monotonic()
    with _lock:
        hit = _cache.get("params")
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1]
    lb = lakebase.get()
    out = tiers.read(("lakebase", _from_lakebase if lb.configured else None),
                     ("warehouse", _from_warehouse if config.WAREHOUSE_ID and config.UC_CATALOG and not config.OFFLINE else None),
                     ("synthetic", _builtin))
    with _lock:
        _cache["params"] = (now, out)
    return out


def invalidate() -> None:
    with _lock:
        _cache.clear()


def family_meta(cfg: dict[str, Any]) -> dict[str, Any]:
    src = cfg.get("source") or {}
    meta = registry.meta_for_forecast(str(src.get("connector") or ""))
    if src.get("via") == "uc_catalog":
        meta["patterns"] = ["query"]  # a UC catalog source is read query-based: never suggest CDC for it
    lb = lakebase.get()
    if src.get("pattern") == "cdc" and src.get("connection") and lb.configured:
        try:
            gw = repo.gateway_for(lb, str(src["connection"]), str(src.get("database") or ""))
            meta["gateway_shared"] = bool(gw and not gw.get("stopped_at"))
        except Exception:  # noqa: BLE001 - unknown = assume a new gateway (the conservative cost)
            meta["gateway_shared"] = False
    return meta


def forecast(cfg: dict[str, Any]) -> dict[str, Any]:
    p, source, reason = params()
    out = engine.predict(cfg, p, family_meta(cfg))
    return {**out, "source": source, "degraded_reason": reason}


def model_card() -> dict[str, Any]:
    p, source, reason = params()
    fams = p.get("families") or {}
    bench = []
    for k, v in sorted(fams.items(), key=lambda kv: -kv[1]["n_pipelines"]):
        fam, pat = k.split("|", 1)
        bench.append({"family": fam, "pattern": pat, "n_pipelines": v["n_pipelines"], "n_updates": v["n_updates"],
                      "upd_p50_s": round(math.exp(v["upd_mu"]), 1),
                      "upd_p90_s": round(math.exp(v["upd_mu"] + engine.Z90 * v["upd_sigma"]), 1),
                      "success_rate": round(v["success_rate"] * 100, 1),
                      "dbu_per_update": round(math.exp(v["dbu_mu"]), 4),
                      "gateway_dbu_hour": round(v["gateway_dbu_hour"], 3) if pat == "cdc" else None})
    g = p.get("global") or {}
    training = p.get("training") or {}
    return {
        "version": str(p.get("version", "builtin")), "trained_at": p.get("trained_at"),
        "window_days": int(p.get("window_days", 0)), "n_pipelines": int(g.get("n_pipelines", 0)),
        "n_updates": int(g.get("n_updates", 0)), "workspaces": int(g.get("workspaces", 0)),
        "metrics": p.get("metrics") or [], "method": training.get("method") or [],
        "benchmarks": bench, "source": source, "degraded_reason": reason,
        "usd_per_dbu": p.get("usd_per_dbu"), "dropped": training.get("dropped"),
    }


def history_counts() -> dict[str, int]:
    """Pipelines per connector family in the training history (connector tiles: 'learned from N pipelines')."""
    p, _, _ = params()
    out: dict[str, int] = {}
    for k, v in (p.get("families") or {}).items():
        fam = k.split("|", 1)[0]
        out[fam] = out.get(fam, 0) + int(v["n_pipelines"])
    return out
