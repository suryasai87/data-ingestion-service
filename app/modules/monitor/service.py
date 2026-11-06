"""Operate: health of every deployed pipeline, reconciliation, run / pause / unpause, and demo source activity.

Health comes live from the Pipelines API (state + latest updates) merged with the guardian's last snapshot
(cost month-to-date from system.billing, open incidents, reconciliation). Freshness = minutes since the last
COMPLETED update finished (the data is at least that fresh, minus capture lag).
"""
from __future__ import annotations

import logging
import random
import threading
import time
from datetime import datetime, timezone
from typing import Any

from core import access, config, lakebase, repo, warehouse
from core.errors import Conflict, Forbidden, NotFound, Unavailable
from core.identity import Caller
from modules.deploy import specs
from modules.itsm import service as itsm
from modules.requests import rules
from modules.requests import service as rs
from modules.sources import service as sources

log = logging.getLogger("dis.monitor")
_cache: dict[str, tuple[float, Any]] = {}
_fetched: dict[str, datetime] = {}  # wall-clock time of each cached read (pause / unpause may happen in another worker)
_lock = threading.Lock()


def _ts(ms: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def _iso(v: Any) -> str | None:
    return v.isoformat() if isinstance(v, datetime) else v


def _pipeline(pid: str) -> dict[str, Any]:
    now = time.monotonic()
    with _lock:
        hit = _cache.get(pid)
        if hit and now - hit[0] < 15:
            return hit[1]
    w = lakebase.workspace_client()
    p = w.api_client.do("GET", f"/api/2.0/pipelines/{pid}") or {}
    with _lock:
        _cache[pid] = (now, p)
        _fetched[pid] = datetime.now(timezone.utc)
    return p


def _drop_if_older(pid: str, ts: Any) -> None:
    """Forget a cached read taken before ts (e.g. a pause another worker just did), so the next read is live."""
    try:
        t = ts if isinstance(ts, datetime) else datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return
    with _lock:
        if pid in _fetched and _fetched[pid] < t:
            _cache.pop(pid, None)
            _fetched.pop(pid, None)


_rows_cache: dict[tuple[str, str], int] = {}  # a completed update's row count never changes


def _rows_last_update(rid: str, update_id: str | None) -> int | None:
    if not update_id or not (config.WAREHOUSE_ID and config.UC_CATALOG):
        return None
    if (rid, update_id) in _rows_cache:
        return _rows_cache[(rid, update_id)]
    t = f"`{config.UC_CATALOG}`.`{config.UC_SCHEMA}`.`{specs.names(rid, {})['event_log']}`"
    try:
        rows = warehouse.query(
            # streaming flows report num_output_rows; upsert (SCD) flows report num_upserted_rows + num_deleted_rows
            "SELECT sum(coalesce(try_cast(details:flow_progress.metrics.num_output_rows AS BIGINT), "
            "coalesce(try_cast(details:flow_progress.metrics.num_upserted_rows AS BIGINT), 0) + "
            f"coalesce(try_cast(details:flow_progress.metrics.num_deleted_rows AS BIGINT), 0))) AS n FROM {t} "
            f"WHERE event_type = 'flow_progress' AND origin.update_id = :u", {"u": update_id}, timeout=20)
        n = int(rows[0]["n"]) if rows and rows[0]["n"] is not None else None
        if n is not None:
            _rows_cache[(rid, update_id)] = n
        return n
    except Exception:  # noqa: BLE001 - the event log table appears after the first update
        return None


def health_of(r: dict[str, Any], snap: dict[str, Any] | None) -> dict[str, Any]:
    pid = r.get("pipeline_id")
    out: dict[str, Any] = {"request_id": r["id"], "title": r["title"], "pipeline_id": pid or "", "state": "UNKNOWN",
                           "health": "unknown", "last_update_at": None, "last_update_state": None, "freshness_min": None,
                           "sla_minutes": r.get("sla_minutes"), "rows_last_update": None,
                           "cost_mtd_usd": (snap or {}).get("cost_mtd_usd"),
                           "forecast_month_usd": rs._public(r)["forecast_month_usd"], "recon": None,
                           "incidents_open": int((snap or {}).get("incidents_open") or 0),
                           "paused_at": _iso((snap or {}).get("paused_at")), "paused_by": (snap or {}).get("paused_by"),
                           "url": f"{config.host()}/pipelines/{pid}" if pid and config.host() else None}
    if snap and snap.get("recon"):
        out["recon"] = snap["recon"]
    if not pid:
        out["health"] = "unknown" if r["status"] == "deploying" else "failing"
        return out
    try:
        if out["paused_at"]:
            _drop_if_older(pid, out["paused_at"])
        p = _pipeline(pid)
        out["state"] = p.get("state", "UNKNOWN")
        ups = p.get("latest_updates") or []
        if ups:
            last = ups[0]
            out["last_update_state"] = last.get("state")
            ct = last.get("creation_time")
            out["last_update_at"] = ct if isinstance(ct, str) else (_ts(ct).isoformat() if _ts(ct) else None)
            done = next((u for u in ups if u.get("state") == "COMPLETED"), None)
            if done:
                t = done.get("creation_time")
                dt = datetime.fromisoformat(t.replace("Z", "+00:00")) if isinstance(t, str) else _ts(t)
                if dt:
                    out["freshness_min"] = round((datetime.now(timezone.utc) - dt).total_seconds() / 60.0, 1)
            out["rows_last_update"] = _rows_last_update(r["id"], (done or {}).get("update_id"))
    except Exception as e:  # noqa: BLE001 - fall back to the snapshot
        log.info("pipeline %s lookup failed: %s", pid, e)
        if snap:
            for k in ("state", "last_update_at", "last_update_state", "freshness_min", "rows_last_update"):
                out[k] = snap.get(k) if k != "last_update_at" else snap.get("last_update_at")
    st, lus = out["state"], out["last_update_state"]
    sla = out["sla_minutes"]
    if out["paused_at"] and st != "RUNNING":
        out["state"], out["health"] = "PAUSED", "paused"  # paused on purpose (cost control): not a failure, no SLA
    elif lus == "FAILED":
        out["health"] = "failing"
    elif st in ("IDLE",) and lus in (None, "CANCELED") and not r.get("job_id"):
        out["health"] = "stopped"
    elif out["freshness_min"] is not None and sla and out["freshness_min"] > sla:
        out["health"] = "degraded"
    elif lus in ("COMPLETED", "RUNNING", "INITIALIZING", "SETTING_UP_TABLES", "WAITING_FOR_RESOURCES", "QUEUED", "CREATED") or st == "RUNNING":
        out["health"] = "healthy"
    return out


def pipelines(caller: Caller) -> dict[str, Any]:
    lb = lakebase.get()
    try:
        rows = repo.list_requests(lb, statuses=["live", "deploying", "failed"])
        snaps = repo.snapshots(lb)
        source, reason = "lakebase", None
    except Exception as e:  # noqa: BLE001
        return {"items": [], "source": "synthetic", "degraded_reason": f"store unavailable: {type(e).__name__}"}
    rows = [r for r in rows if r.get("pipeline_id") or r["status"] == "deploying"]
    # one Pipelines API call (+ at most one warehouse query) per pipeline: in parallel, not one after another
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as pool:
        items = list(pool.map(lambda r: health_of(r, snaps.get(r["id"])), rows))
    return {"items": items, "source": source, "degraded_reason": reason}


def _operator(caller: Caller) -> None:
    lb = lakebase.get()
    if not (access.is_admin(lb, caller.email) or access.approver_scopes(lb, caller.email)):
        raise Forbidden("Only a data owner or an administrator can operate pipelines.")


def run_now(rid: str, caller: Caller) -> dict[str, Any]:
    """One update now. A paused pipeline stays paused (its schedule stays off); Unpause resumes it."""
    rs.guard_write()
    _operator(caller)
    r = repo.get_request(lakebase.get(), rid)
    if not r or not r.get("pipeline_id"):
        raise NotFound(f"{rid} has no pipeline")
    w = lakebase.workspace_client()
    if r.get("gateway_id"):
        gw = _pipeline(r["gateway_id"])
        if gw.get("state") not in ("RUNNING",):
            w.api_client.do("POST", f"/api/2.0/pipelines/{r['gateway_id']}/updates", body={})
    try:
        upd = w.api_client.do("POST", f"/api/2.0/pipelines/{r['pipeline_id']}/updates", body={"full_refresh": False})
    except Exception as e:  # noqa: BLE001
        if "already" in str(e).lower() or "active update" in str(e).lower():
            raise Conflict("An update is already running.") from e
        raise
    repo.audit(lakebase.get(), caller.email, "pipeline.run", "request", rid, {"update_id": (upd or {}).get("update_id")})
    repo.upsert_snapshot(lakebase.get(), rid, {"pipeline_id": r["pipeline_id"], "state": "RUNNING"})
    with _lock:
        _cache.pop(r["pipeline_id"], None)
    return {"ok": True, "update_id": (upd or {}).get("update_id")}


def _cron(rid: str) -> str:
    v = repo.get_version(lakebase.get(), rid) or {}
    return specs.quartz(int(((v.get("config") or {}).get("schedule") or {}).get("interval_minutes") or 60))


def _schedule(w: Any, r: dict[str, Any], status: str) -> None:
    w.api_client.do("POST", "/api/2.2/jobs/update", body={"job_id": int(r["job_id"]), "new_settings": {"schedule": {
        "quartz_cron_expression": _cron(r["id"]), "timezone_id": "UTC", "pause_status": status}}})


def pause(rid: str, caller: Caller) -> dict[str, Any]:
    """Cost control: pause the schedule, cancel a scheduled run in flight, stop the ingestion pipeline, and stop the
    gateway when no other live request shares it. Nothing runs (or bills) until Unpause."""
    rs.guard_write()
    _operator(caller)
    lb = lakebase.get()
    r = repo.get_request(lb, rid)
    if not r or not r.get("pipeline_id"):
        raise NotFound(f"{rid} has no pipeline")
    return _pause(lb, lakebase.workspace_client(), r, caller.email)


def _pause(lb: Any, w: Any, r: dict[str, Any], who: str) -> dict[str, Any]:
    rid, done = r["id"], []
    if r.get("job_id"):
        _schedule(w, r, "PAUSED")
        done.append("schedule paused")
        try:
            w.api_client.do("POST", "/api/2.2/jobs/runs/cancel-all", body={"job_id": int(r["job_id"])})
        except Exception as e:  # noqa: BLE001 - nothing in flight is the common case
            log.info("cancel-all %s: %s", r["job_id"], e)
    w.api_client.do("POST", f"/api/2.0/pipelines/{r['pipeline_id']}/stop")
    done.append("pipeline stopped")
    if r.get("gateway_id"):
        paused = {k for k, v in repo.snapshots(lb).items() if v.get("paused_at")}
        others = [x for x in repo.list_requests(lb, statuses=["live"])
                  if x.get("gateway_id") == r["gateway_id"] and x["id"] != rid and x["id"] not in paused]
        if others:
            done.append(f"gateway kept (shared with {', '.join(x['id'] for x in others)})")
        else:
            w.api_client.do("POST", f"/api/2.0/pipelines/{r['gateway_id']}/stop")
            lb.execute(f"UPDATE {repo.S()}.gateway SET stopped_at = now() WHERE pipeline_id = %s", (r["gateway_id"],))
            done.append("gateway stopped")
    repo.set_paused(lb, rid, r["pipeline_id"], who)
    repo.audit(lb, who, "pipeline.pause", "request", rid, {"message": "; ".join(done)})
    itsm.pipeline_note(rid, f"pipeline paused by {who} ({'; '.join(done)})")
    with _lock:
        _cache.clear()
    return {"ok": True, "request_id": rid, "done": done}


stop = pause  # the v0.1 route name


def unpause(rid: str, caller: Caller) -> dict[str, Any]:
    """Resume a paused pipeline: gateway up (CDC), schedule back on, and an update started now, so it is running
    straight away instead of waiting for the next scheduled slot."""
    rs.guard_write()
    _operator(caller)
    lb = lakebase.get()
    r = repo.get_request(lb, rid)
    if not r or not r.get("pipeline_id"):
        raise NotFound(f"{rid} has no pipeline")
    w = lakebase.workspace_client()
    done = []
    if r.get("gateway_id"):
        gw = _pipeline(r["gateway_id"])
        if gw.get("state") != "RUNNING":
            w.api_client.do("POST", f"/api/2.0/pipelines/{r['gateway_id']}/updates", body={})
            lb.execute(f"UPDATE {repo.S()}.gateway SET stopped_at = NULL WHERE pipeline_id = %s", (r["gateway_id"],))
            done.append("gateway started")
    if r.get("job_id"):
        _schedule(w, r, "UNPAUSED")
        done.append("schedule on")
    update_id = None
    try:
        update_id = (w.api_client.do("POST", f"/api/2.0/pipelines/{r['pipeline_id']}/updates", body={"full_refresh": False}) or {}).get("update_id")
        done.append("update started")
    except Exception as e:  # noqa: BLE001
        if "already" not in str(e).lower() and "active update" not in str(e).lower():
            raise
        done.append("update already running")
    repo.set_paused(lb, rid, r["pipeline_id"], None)
    repo.audit(lb, caller.email, "pipeline.unpause", "request", rid, {"message": "; ".join(done), "update_id": update_id})
    itsm.pipeline_note(rid, f"pipeline unpaused by {caller.email} ({'; '.join(done)})")
    with _lock:
        _cache.clear()
    return {"ok": True, "request_id": rid, "update_id": update_id, "done": done}


def pause_all(caller: Caller) -> dict[str, Any]:
    """Administrators: pause every live pipeline that isn't paused yet (one failure doesn't stop the rest)."""
    rs.guard_write()
    lb = lakebase.get()
    if not access.is_admin(lb, caller.email):
        raise Forbidden("Only an administrator can pause every pipeline.")
    w = lakebase.workspace_client()
    snaps = repo.snapshots(lb)
    out: dict[str, list[Any]] = {"paused": [], "already_paused": [], "failed": []}
    for r in repo.list_requests(lb, statuses=["live"]):
        if not r.get("pipeline_id"):
            continue
        if (snaps.get(r["id"]) or {}).get("paused_at"):
            out["already_paused"].append(r["id"])
            continue
        try:
            _pause(lb, w, r, caller.email)
            out["paused"].append(r["id"])
        except Exception as e:  # noqa: BLE001
            log.warning("pause %s failed: %s", r["id"], e)
            out["failed"].append({"request_id": r["id"], "error": f"{type(e).__name__}: {str(e)[:200]}"})
    return out


def _target_count(cfg: dict[str, Any], o: dict[str, Any]) -> int:
    d = cfg["destination"]
    t = f"`{d['catalog']}`.`{d['schema']}`.`{specs.destination_table(o, d.get('table_prefix') or '')}`"
    scd2 = cfg["schema"]["scd_type"] == "SCD_TYPE_2"
    rows = warehouse.query(f"SELECT count(*) AS n FROM {t}" + (" WHERE __END_AT IS NULL" if scd2 else ""), timeout=60)
    return int(rows[0]["n"])


def _source_count(cfg: dict[str, Any], o: dict[str, Any]) -> int | None:
    name = cfg["source"].get("connection")
    if sources.is_demo(name):
        src = sources.demo_source()
        if src is not None:
            r = src.query(f'SELECT count(*) AS n FROM "{o["schema"]}"."{o["table"]}"')
            return int(r[0]["n"])
    fc = sources._foreign_catalogs().get(name or "") or (name if cfg["source"].get("via") == "uc_catalog" else None)
    if fc:
        rows = warehouse.query(f"SELECT count(*) AS n FROM `{fc}`.`{o['schema']}`.`{o['table']}`", timeout=60)
        return int(rows[0]["n"])
    return None


def reconcile(rid: str, caller: Caller | None = None) -> dict[str, Any]:
    lb = lakebase.get()
    if caller is not None:
        rs.guard_write()
        _operator(caller)
    r = repo.get_request(lb, rid)
    if not r:
        raise NotFound(rid)
    cfg = rules.normalize((repo.get_version(lb, rid) or {}).get("config") or {})
    results = []
    for o in cfg["objects"]:
        try:
            tgt = _target_count(cfg, o)
        except Exception as e:  # noqa: BLE001 - the table may not exist before the first update
            tgt = None
            log.info("target count %s failed: %s", o["table"], e)
        try:
            src = _source_count(cfg, o)
        except Exception as e:  # noqa: BLE001
            src = None
            log.info("source count %s failed: %s", o["table"], e)
        status = "pending" if (src is None or tgt is None) else ("match" if src == tgt else "drift")
        repo.add_recon(lb, rid, o["table"], src, tgt, status)
        results.append({"table": o["table"], "source_rows": src, "target_rows": tgt, "status": status})
    agg_status = "pending" if any(x["status"] == "pending" for x in results) else ("drift" if any(x["status"] == "drift" for x in results) else "match")
    recon = {"status": agg_status, "source_rows": sum(x["source_rows"] or 0 for x in results) if results else None,
             "target_rows": sum(x["target_rows"] or 0 for x in results) if results else None, "tables": results}
    if r.get("pipeline_id"):
        repo.upsert_snapshot(lb, rid, {"pipeline_id": r["pipeline_id"], "recon": recon})
    if caller is not None:
        repo.audit(lb, caller.email, "pipeline.reconcile", "request", rid, {"status": agg_status})
    return {"ok": True, "recon": recon}


def preview(rid: str, table: str | None, caller: Caller) -> dict[str, Any]:
    """Read the landed data AS THE USER (on-behalf-of): proves their read-only grant and attributes the query to them."""
    from modules.usage import service as usage
    from modules.uc_access import service as uc_access

    r = repo.get_request(lakebase.get(), rid)
    if not r:
        raise NotFound(rid)
    cfg = rules.normalize((repo.get_version(lakebase.get(), rid) or {}).get("config") or {})
    names = uc_access.tables(cfg)
    t = table if table in names else (names[0] if names else None)
    if not t:
        raise NotFound("No landed tables for this request.")
    if not caller.token:
        raise Forbidden("User authorization is not enabled for this app, so data can't be read on your behalf.")
    quoted = ".".join(f"`{p}`" for p in t.split("."))
    t0 = time.monotonic()
    try:
        rows = warehouse.query(f"SELECT * FROM {quoted} LIMIT 20 /* dis-obo */", token=caller.token, timeout=60)
    except PermissionError as e:
        usage.record(caller.email, "GET", f"/api/requests/{rid}/preview", 403, (time.monotonic() - t0) * 1000, True, "obo_query", {"table": t})
        raise Forbidden(f"You don't have read access to {t} yet: {str(e)[:200]}") from e
    usage.record(caller.email, "GET", f"/api/requests/{rid}/preview", 200, (time.monotonic() - t0) * 1000, True, "obo_query",
                 {"table": t, "rows": len(rows)})
    return {"table": t, "tables": names, "rows": rows, "as_user": caller.email, "columns": list(rows[0].keys()) if rows else []}


def demo_activity(caller: Caller, inserts: int, updates: int, deletes: int) -> dict[str, Any]:
    """Write real changes into the demo source so CDC (incl. hard deletes) can be watched end to end."""
    rs.guard_write()
    lb = lakebase.get()
    if not access.is_admin(lb, caller.email):
        raise Forbidden("Administrators only.")
    src = sources.demo_source()
    if src is None:
        raise Unavailable("No demo source is configured for this deployment.")
    inserts, updates, deletes = (max(0, min(500, int(x))) for x in (inserts, updates, deletes))
    rnd = random.Random()
    with src.connection() as c, c.cursor() as cur:
        cur.execute("SELECT coalesce(max(doc_id), 0) AS m FROM finance.journal_header")
        start = int(cur.fetchone()["m"]) + 1
        for i in range(inserts):
            doc = start + i
            cur.execute("INSERT INTO finance.journal_header (doc_id, company_code, fiscal_year, doc_type, posting_date, currency, reference, created_by, updated_at) "
                        "VALUES (%s, %s, 2026, %s, current_date, %s, %s, 'dis-demo', now())",
                        (doc, rnd.choice(["1000", "2000", "3000"]), rnd.choice(["SA", "KR", "DR"]), rnd.choice(["USD", "EUR"]), f"DEMO-{doc}"))
            for ln in (1, 2):
                amt = round(rnd.uniform(50, 25000), 2)
                cur.execute("INSERT INTO finance.journal_line (doc_id, line_no, gl_account, cost_center, amount, debit_credit, updated_at) "
                            "VALUES (%s, %s, %s, %s, %s, %s, now())",
                            (doc, ln, rnd.choice(["400100", "500200", "600300", "110000"]), rnd.choice(["CC100", "CC200", "CC300"]),
                             amt, "S" if ln == 1 else "H"))
        cur.execute("UPDATE finance.journal_line SET amount = round((amount * (0.9 + random() * 0.2))::numeric, 2), updated_at = now() "
                    "WHERE (doc_id, line_no) IN (SELECT doc_id, line_no FROM finance.journal_line ORDER BY random() LIMIT %s)", (updates,))
        upd = cur.rowcount
        cur.execute("DELETE FROM finance.journal_line WHERE (doc_id, line_no) IN (SELECT doc_id, line_no FROM finance.journal_line "
                    "WHERE doc_id < %s ORDER BY random() LIMIT %s)", (start, deletes))
        dele = cur.rowcount
    repo.audit(lb, caller.email, "demo.source_activity", "source", config.DEMO_SOURCE_CATALOG or config.DEMO_CONNECTION or "demo",
               {"inserted_docs": inserts, "updated_lines": upd, "deleted_lines": dele})
    return {"ok": True, "inserted_docs": inserts, "inserted_lines": inserts * 2, "updated_lines": upd, "deleted_lines": dele}
