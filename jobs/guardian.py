"""Guardian job (every 30 min, runs as the deployer): keep every deployed pipeline honest.

For each live request:
- health snapshot (Pipelines API) into Lakebase pipeline_snapshot
- a FAILED latest update is classified from the pipeline's error events:
    transient  (timeouts, throttling, capacity, lost connections)  -> one automatic retry, incident "open";
               resolved as auto_healed once a later update completes
    actionable (permissions, credentials, missing objects, schema)  -> incident "open" with a ticket reference
               (internal queue DIS-INC-<id>; the ServiceNow integration point)
- source-to-Foundation reconciliation (row counts)
- cost month-to-date from system.billing.usage, by the pipeline tag dis_request
Then the request mirror in Unity Catalog (the app's lakehouse read tier when Lakebase is unreachable).
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

def _jobs_dir() -> str:
    """spark_python_task exec()s the file (no __file__): fall back to <--root>/jobs."""
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:
        a = sys.argv
        return os.path.join(a[a.index("--root") + 1] if "--root" in a else ".", "jobs")


sys.path.insert(0, _jobs_dir())
import _bootstrap  # noqa: E402

ROOT = _bootstrap.init()

from core import config, lakebase, repo, warehouse  # noqa: E402
from core.identity import Caller  # noqa: E402
from modules.monitor import service as monitor  # noqa: E402
from modules.requests import service as rs  # noqa: E402

TRANSIENT = re.compile(r"timed? ?out|timeout|throttl|429|503|temporar|unavailable|connection (reset|refused|closed)|"
                       r"could not connect|capacity|quota|cluster .* (terminated|lost)|INTERNAL_ERROR|try again|retry", re.I)
ACTIONABLE = re.compile(r"permission|PERMISSION_DENIED|not authori[sz]ed|authentication|password|credential|"
                        r"does not exist|not found|schema|column|replication slot|publication|privilege", re.I)
SYSTEM = Caller(email="guardian@data-ingestion-service", name="Guardian")


def log(msg: str) -> None:
    print(f"[guardian] {msg}", flush=True)


def classify(message: str) -> str:
    if ACTIONABLE.search(message or "") and not TRANSIENT.search(message or ""):
        return "actionable"
    return "transient" if TRANSIENT.search(message or "") else "actionable"


def error_message(w: Any, pid: str, update_id: str | None) -> str:
    try:
        r = w.api_client.do("GET", f"/api/2.0/pipelines/{pid}/events", query={"max_results": 100, "order_by": "timestamp desc"}) or {}
        for ev in r.get("events") or []:
            if ev.get("level") == "ERROR" and (not update_id or (ev.get("origin") or {}).get("update_id") == update_id):
                exc = ((ev.get("error") or {}).get("exceptions") or [{}])[0]
                return f"{ev.get('message', '')} {exc.get('message', '')}".strip()[:1500]
    except Exception as e:  # noqa: BLE001
        return f"(could not read events: {type(e).__name__})"
    return "update failed (no error event found)"


def costs_mtd() -> dict[str, float]:
    try:
        rows = warehouse.query("""
            SELECT u.custom_tags['dis_request'] AS rid,
                   sum(u.usage_quantity * coalesce(CAST(p.pricing.effective_list.default AS DOUBLE), 0)) AS usd
            FROM system.billing.usage u
            LEFT JOIN system.billing.list_prices p
              ON p.sku_name = u.sku_name AND p.cloud = u.cloud AND u.usage_start_time >= p.price_start_time
             AND (p.price_end_time IS NULL OR u.usage_start_time < p.price_end_time)
            WHERE u.usage_date >= date_trunc('MONTH', current_date()) AND u.custom_tags['dis_request'] IS NOT NULL
            GROUP BY 1""", timeout=300)
        return {r["rid"]: float(r["usd"] or 0) for r in rows}
    except Exception as e:  # noqa: BLE001
        log(f"billing lookup skipped: {type(e).__name__}: {str(e)[:200]}")
        return {}


def handle_failure(lb: Any, w: Any, r: dict[str, Any], pid: str, last: dict[str, Any]) -> None:
    uid = last.get("update_id") or ""
    if any(uid and uid in (i.get("title") or "") for i in repo.incidents(lb, r["id"], limit=50)):
        return  # this failed update was handled already
    msg = error_message(w, pid, uid)
    kind = classify(msg)
    if kind == "transient":
        try:
            w.api_client.do("POST", f"/api/2.0/pipelines/{pid}/updates", body={"full_refresh": False})
            note = "Automatic retry started."
        except Exception as e:  # noqa: BLE001
            note = f"Automatic retry could not start: {type(e).__name__}"
        iid = repo.open_incident(lb, r["id"], pid, "transient", "open", f"Transient failure, update {uid}", f"{note} {msg}")
        log(f"{r['id']}: transient failure -> retry (incident {iid})")
    else:
        open_actionable = [i for i in repo.incidents(lb, r["id"], open_only=True) if i["kind"] == "actionable"]
        if open_actionable:  # same episode: one ticket per persistent failure, not one per failed run
            lb.execute(f"UPDATE {repo.S()}.incident SET detail = %s WHERE id = %s",
                       (f"Still failing (update {uid}). {msg}"[:4000], open_actionable[0]["id"]))
            log(f"{r['id']}: still failing, ticket {open_actionable[0].get('ticket_ref')} updated")
            return
        iid = repo.open_incident(lb, r["id"], pid, "actionable", "open", f"Needs action, update {uid}", msg)
        lb.execute(f"UPDATE {repo.S()}.incident SET ticket_ref = %s WHERE id = %s", (f"DIS-INC-{iid}", iid))
        from modules.itsm import service as itsm
        itsm.incident_opened(r["id"], iid, f"Ingestion pipeline needs action (update {uid})", msg)  # ServiceNow incident
        log(f"{r['id']}: actionable failure -> ticket {(lb.query(f'SELECT ticket_ref FROM {repo.S()}.incident WHERE id = %s', (iid,)) or [{}])[0].get('ticket_ref')}")
    repo.audit(lb, SYSTEM.email, f"guardian.{kind}", "request", r["id"], {"update_id": uid, "message": msg[:300]})


def follow_ups(lb: Any, w: Any, r: dict[str, Any]) -> None:
    """After a completed load: finish pending reader grants and, for GxP, the first qualification run."""
    from modules.requests import rules
    from modules.uc_access import service as uc_access

    cfg = rules.normalize((repo.get_version(lb, r["id"]) or {}).get("config") or {})
    pending = [g for g in uc_access.grants_for(r["id"]) if g["status"] != "granted"] or (not uc_access.grants_for(r["id"]))
    if pending:
        res = uc_access.ensure_reader_grants(r["id"], r, cfg, w)
        log(f"{r['id']}: reader grants {sum(1 for x in res if x['status'] == 'granted')}/{len(res)}")
    if r.get("gxp"):
        from modules.gxp import oq
        ev = oq.latest(r["id"])
        if not ev or ev["version"] != r["version"]:
            try:
                monitor.reconcile(r["id"])
                out = oq.run(r["id"], SYSTEM, w)
                log(f"{r['id']}: qualification {out['verdict']} sha256 {out['sha256'][:16]}")
            except Exception as e:  # noqa: BLE001
                log(f"{r['id']}: qualification skipped: {e}")


def usage_rollup(lb: Any) -> int:
    """Per-user warehouse usage of the app's on-behalf-of queries (marker /* dis-obo */), last 30 days."""
    try:
        rows = warehouse.query("""
            SELECT executed_by AS user_email, CAST(start_time AS DATE) AS day, count(*) AS queries,
                   sum(total_duration_ms) AS duration_ms, sum(coalesce(read_bytes, 0)) AS read_bytes
            FROM system.query.history
            WHERE start_time >= current_date() - INTERVAL 30 DAYS AND statement_text LIKE '%/* dis-obo */%'
            GROUP BY 1, 2""", timeout=300)
    except Exception as e:  # noqa: BLE001
        log(f"usage rollup skipped: {type(e).__name__}: {str(e)[:200]}")
        return 0
    with lb.connection() as c, c.cursor() as cur:
        for x in rows:
            cur.execute(f"INSERT INTO {repo.S()}.usage_rollup (user_email, day, queries, duration_ms, read_bytes) VALUES (%s,%s,%s,%s,%s) "
                        f"ON CONFLICT (user_email, day) DO UPDATE SET queries = EXCLUDED.queries, duration_ms = EXCLUDED.duration_ms, "
                        f"read_bytes = EXCLUDED.read_bytes", (x["user_email"], x["day"], x["queries"], x["duration_ms"] or 0, x["read_bytes"] or 0))
    return len(rows)


def mirror(lb: Any) -> int:
    payloads = []
    for r in repo.list_requests(lb, limit=1000):
        try:
            d = rs.detail(r["id"], SYSTEM)
            d.pop("source", None)
            d.pop("degraded_reason", None)
            payloads.append({"id": r["id"], "updated_at": r["updated_at"], "payload": json.dumps(d, default=str)})
        except Exception as e:  # noqa: BLE001
            log(f"mirror skipped {r['id']}: {e}")
    try:
        from pyspark.sql import SparkSession  # type: ignore

        spark = SparkSession.getActiveSession() or SparkSession.builder.getOrCreate()
        if payloads:
            spark.createDataFrame(payloads).selectExpr("id", "CAST(updated_at AS TIMESTAMP) AS updated_at", "payload") \
                .write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(config.uc("request_mirror").replace("`", ""))
    except ImportError:
        log("no Spark here: mirror not written")
    return len(payloads)


def main() -> int:
    lb = lakebase.get()
    w = lakebase.workspace_client()
    costs = costs_mtd()
    rows = repo.list_requests(lb, statuses=["live"])
    snaps = repo.snapshots(lb)
    log(f"{len(rows)} live request(s); cost rows: {len(costs)}")
    for r in rows:
        pid = r.get("pipeline_id")
        if not pid:
            continue
        try:
            p = w.api_client.do("GET", f"/api/2.0/pipelines/{pid}") or {}
            ups = p.get("latest_updates") or []
            last = ups[0] if ups else {}
            paused = bool((snaps.get(r["id"]) or {}).get("paused_at"))  # paused on purpose: no retries, no tickets
            if last.get("state") == "FAILED" and not paused:
                handle_failure(lb, w, r, pid, last)
            elif last.get("state") == "COMPLETED":
                healed = lb.query(f"UPDATE {repo.S()}.incident SET status = CASE WHEN kind = 'transient' THEN 'auto_healed' ELSE 'resolved' END, "
                                  f"resolved_at = now() WHERE request_id = %s AND status = 'open' RETURNING id, kind", (r["id"],))
                from modules.itsm import service as itsm
                for h in healed:
                    itsm.incident_resolved(r["id"], h["id"], f"Next update {last.get('update_id')} completed: "
                                                             f"{'auto-healed by retry' if h['kind'] == 'transient' else 'resolved'}.")
                if healed:
                    log(f"{r['id']}: {len(healed)} incident(s) closed")
                follow_ups(lb, w, r)
            open_n = len(repo.incidents(lb, r["id"], open_only=True))
            rec = None  # paused: keep the last reconciliation, don't spend warehouse time on a pipeline that isn't moving
            if not paused:
                try:
                    rec = monitor.reconcile(r["id"])["recon"]
                except Exception as e:  # noqa: BLE001
                    log(f"{r['id']}: reconcile skipped: {e}")
            h = monitor.health_of(r, snaps.get(r["id"]))
            repo.upsert_snapshot(lb, r["id"], {"pipeline_id": pid, "state": h["state"], "health": h["health"],
                                               "last_update_at": h["last_update_at"], "last_update_state": h["last_update_state"],
                                               "freshness_min": h["freshness_min"], "rows_last_update": h["rows_last_update"],
                                               "cost_mtd_usd": costs.get(r["id"]), "recon": rec, "incidents_open": open_n})
            log(f"{r['id']}: {h['health']} freshness={h['freshness_min']} recon={(rec or {}).get('status')} cost_mtd={costs.get(r['id'])}")
        except Exception as e:  # noqa: BLE001 - one bad pipeline must not stop the others
            log(f"{r['id']}: check failed: {type(e).__name__}: {str(e)[:300]}")
    from modules.itsm import servicenow
    log(f"ServiceNow ({servicenow.mode()}): {servicenow.sync_missing()} missing ticket(s) created")
    log(f"usage rollup: {usage_rollup(lb)} user-day row(s)")
    log(f"mirrored {mirror(lb)} request(s) to {config.uc('request_mirror')}")
    log(f"done at {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    return 0


if __name__ == "__main__":
    rc = main()
    if rc:  # never sys.exit(0): the job runner (IPython) reports SystemExit(0) as a failure
        raise SystemExit(rc)
