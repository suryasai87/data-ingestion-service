"""Deploy an approved request for real, as the app's service principal, in a background thread.

Steps (each logged in deployment_step, every one idempotent so a failed deploy can simply be retried):
  validate    re-run every check, incl. the Lakeflow dry run, on the approved version
  gateway     CDC via gateway: reuse the running gateway of this connection + database, else create it
  pipeline    create the serverless managed ingestion pipeline (skipped if this request already has one)
  permissions requester + owner CAN_VIEW on the pipeline(s)
  schedule    a Jobs pipeline_task on the requested cadence (continuous mode: skipped)
  first_run   start the first update (the initial snapshot)
Then the request is `live`; the guardian job and the Pipelines page watch it from there.
"""
from __future__ import annotations

import logging
import threading
import traceback
from typing import Any

from core import config, lakebase, repo
from core.lakebase import workspace_client
from modules.deploy import specs

log = logging.getLogger("dis.deploy")
STEPS = ("validate", "gateway", "pipeline", "permissions", "schedule", "first_run", "access", "qualify")
FIRST_LOAD_TIMEOUT_S = 1200.0
_running: set[str] = set()
_lock = threading.Lock()


def start(rid: str, actor: str) -> bool:
    lb = lakebase.get()
    with _lock:
        if rid in _running:
            return False
        _running.add(rid)
    r = repo.get_request(lb, rid)
    if r is None or not repo.update_request(lb, rid, {"status": "deploying"}, expect_status=("approved", "failed"),
                                            audit=(actor, "request.deploy", {"version": r["version"] if r else None})):
        with _lock:
            _running.discard(rid)
        return False
    for i, s in enumerate(STEPS):
        repo.upsert_step(lb, rid, r["version"], s, i, "pending", "")
    threading.Thread(target=_run, args=(rid, actor), daemon=True, name=f"deploy-{rid}").start()
    return True


def _step(rid: str, version: int, name: str, status: str, detail: str = "") -> None:
    repo.upsert_step(lakebase.get(), rid, version, name, STEPS.index(name), status, detail)


def _source_dir(w: Any) -> str:
    """Generated pipeline sources live in the service principal's own folder: people cannot edit them."""
    import os
    sp = os.environ.get("DATABRICKS_CLIENT_ID") or w.current_user.me().user_name
    return f"/Workspace/Users/{sp}/data-ingestion-service/pipelines"


def _upload_source(w: Any, path: str, code: str) -> None:
    import base64
    folder = path.rsplit("/", 1)[0]
    w.api_client.do("POST", "/api/2.0/workspace/mkdirs", body={"path": folder})
    w.api_client.do("POST", "/api/2.0/workspace/import", body={"path": path, "format": "AUTO", "language": "PYTHON",
                                                               "content": base64.b64encode(code.encode()).decode(), "overwrite": True})


def _create_pipeline(w: Any, spec: dict[str, Any]) -> str:
    r = w.api_client.do("POST", "/api/2.0/pipelines", body={**spec, "allow_duplicate_names": True})
    pid = (r or {}).get("pipeline_id")
    if not pid:
        raise RuntimeError(f"pipelines.create returned no id: {r}")
    return pid


def _validate_pipeline(w: Any, pid: str, timeout: float = 900.0) -> str:
    """Lakeflow's own validation: a validate-only update (resolves the source, the objects and the destination,
    writes nothing). Raises with the pipeline's error message when it fails."""
    import time

    u = w.api_client.do("POST", f"/api/2.0/pipelines/{pid}/updates", body={"validate_only": True}) or {}
    uid = u.get("update_id")
    t0 = time.monotonic()
    while uid:
        r = w.api_client.do("GET", f"/api/2.0/pipelines/{pid}/updates/{uid}") or {}
        state = (r.get("update") or {}).get("state")
        if state == "COMPLETED":
            return uid
        if state in ("FAILED", "CANCELED"):
            ev = w.api_client.do("GET", f"/api/2.0/pipelines/{pid}/events", query={"max_results": 50}) or {}
            msgs = [e.get("message", "") for e in ev.get("events") or [] if e.get("level") == "ERROR"]
            raise RuntimeError(f"Lakeflow validation {state.lower()}: " + (" | ".join(msgs[:3]) or "see the pipeline event log"))
        if time.monotonic() - t0 > timeout:
            raise TimeoutError("Lakeflow validation did not finish in time")
        time.sleep(VALIDATE_POLL_S)
    return ""


VALIDATE_POLL_S = 10.0


def _wait_update(w: Any, pid: str, uid: str | None, timeout: float) -> str:
    import time

    t0 = time.monotonic()
    while uid and time.monotonic() - t0 < timeout:
        st = ((w.api_client.do("GET", f"/api/2.0/pipelines/{pid}/updates/{uid}") or {}).get("update") or {}).get("state")
        if st in ("COMPLETED", "FAILED", "CANCELED"):
            return st
        time.sleep(VALIDATE_POLL_S)
    return "RUNNING"


def _run(rid: str, actor: str) -> None:
    from modules.requests import rules
    from modules.requests import service as rs

    lb = lakebase.get()
    r = repo.get_request(lb, rid) or {}
    version = int(r.get("version") or 1)
    current = "validate"
    try:
        w = workspace_client()
        v = repo.get_version(lb, rid, version) or {}
        cfg_raw = v.get("config") or {}

        # validate
        _step(rid, version, current, "running")
        cfg, checks, fc = rs.check(cfg_raw, live=True, rid=rid)
        # the dry run of a NEW gateway's ingestion pipeline can only run once the gateway exists: tolerate that
        bad = [c for c in checks if c["status"] == "fail"]
        repo.save_checks(lb, rid, version, checks)
        if bad:
            raise RuntimeError("Checks failed: " + "; ".join(f"{c['label']}: {c['detail']}" for c in bad))
        _step(rid, version, current, "done", f"{len(checks)} checks passed")
        conn = rs.connector(cfg["source"]["connector"]) or {}
        if not config.ALLOW_DEPLOY:
            for s in STEPS[1:]:
                _step(rid, version, s, "skipped", "ALLOW_DEPLOY is off: dry run only")
            repo.update_request(lb, rid, {"status": "approved"}, audit=(actor, "request.deploy_skipped", {"message": "ALLOW_DEPLOY is off"}))
            return

        # gateway
        current = "gateway"
        gateway_id = r.get("gateway_id")
        uses_gateway = cfg["source"]["pattern"] == "cdc" and conn.get("cdc_architecture") == "gateway"
        slot = rs._slot(conn, cfg)
        if not uses_gateway:
            _step(rid, version, current, "skipped", "No gateway for this pattern (serverless pipeline reads the source itself).")
        else:
            _step(rid, version, current, "running")
            share = bool(rs.policies().get("share_gateways", True))
            existing = repo.gateway_for(lb, cfg["source"]["connection"], cfg["source"].get("database") or "")
            if gateway_id:
                _step(rid, version, current, "done", f"Gateway {gateway_id} (created earlier for this request).")
            elif share and existing and not existing.get("stopped_at"):
                gateway_id = existing["pipeline_id"]
                _step(rid, version, current, "done", f"Shared gateway {gateway_id} reused (one always-on gateway per source database).")
            else:
                if config.DEMO_CONNECTION and cfg["source"]["connection"] == config.DEMO_CONNECTION and slot:
                    from modules.sources import service as sources
                    _step(rid, version, current, "running", sources.ensure_demo_slot(slot["slot_name"]))
                p = specs.build(rid, cfg, conn, staging_catalog=config.UC_CATALOG, staging_schema=config.GATEWAY_STORAGE_SCHEMA,
                                event_log_catalog=config.UC_CATALOG, event_log_schema=config.UC_SCHEMA, gateway_id=None, slot=slot)
                gw_spec = p["gateway"]
                if config.GATEWAY_NODE_TYPE:
                    gw_spec["clusters"] = [{"label": "default", "node_type_id": config.GATEWAY_NODE_TYPE,
                                            "driver_node_type_id": config.GATEWAY_NODE_TYPE, "num_workers": 1}]
                gateway_id = _create_pipeline(w, gw_spec)
                repo.save_gateway(lb, cfg["source"]["connection"], cfg["source"].get("database") or "", gateway_id, rid,
                                  (slot or {}).get("slot_name"), (slot or {}).get("publication_name"))
                _step(rid, version, current, "done", f"Created gateway {gateway_id}.")
            repo.update_request(lb, rid, {"gateway_id": gateway_id})

        # pipeline
        current = "pipeline"
        _step(rid, version, current, "running")
        p = specs.build(rid, cfg, conn, staging_catalog=config.UC_CATALOG, staging_schema=config.GATEWAY_STORAGE_SCHEMA,
                        event_log_catalog=config.UC_CATALOG, event_log_schema=config.UC_SCHEMA, gateway_id=gateway_id, slot=slot,
                        source_dir=_source_dir(w) if cfg["source"]["pattern"] in ("files", "api") else "/Workspace/Shared", version=version)
        if p.get("source_code"):
            _upload_source(w, p["source_path"], p["source_code"])
            _step(rid, version, current, "running", f"Pipeline source written to {p['source_path']} (service principal's folder).")
        pipeline_id = r.get("pipeline_id")
        if not pipeline_id:
            pipeline_id = _create_pipeline(w, p["ingestion"])
            repo.update_request(lb, rid, {"pipeline_id": pipeline_id}, audit=(actor, "pipeline.create", {"pipeline_id": pipeline_id}))
        _step(rid, version, current, "running", f"Pipeline {pipeline_id}: Lakeflow validation (validate-only update)…")
        _validate_pipeline(w, pipeline_id)
        _step(rid, version, current, "done", f"Ingestion pipeline {pipeline_id} → {cfg['destination']['catalog']}.{cfg['destination']['schema']}, validated by Lakeflow.")

        # permissions
        current = "permissions"
        _step(rid, version, current, "running")
        people = sorted({e for e in (r.get("requester"), cfg["ownership"].get("owner")) if e and "@" in e})
        granted = []
        for pid in [x for x in (pipeline_id, gateway_id) if x]:
            try:
                w.api_client.do("PATCH", f"/api/2.0/permissions/pipelines/{pid}",
                                body={"access_control_list": [{"user_name": e, "permission_level": "CAN_VIEW"} for e in people]})
                granted.append(pid)
            except Exception as e:  # noqa: BLE001 - a missing user must not stop the deployment
                log.warning("pipeline permission on %s failed: %s", pid, e)
        _step(rid, version, current, "done", f"CAN_VIEW for {', '.join(people) or 'nobody'} on {len(granted)} pipeline(s).")

        # schedule
        current = "schedule"
        job_id = r.get("job_id")
        if p["job"] is None:
            _step(rid, version, current, "skipped", "Continuous ingestion: no schedule.")
        elif job_id:
            _step(rid, version, current, "done", f"Job {job_id} (created earlier).")
        else:
            _step(rid, version, current, "running")
            job = p["job"]
            job["tasks"][0]["pipeline_task"]["pipeline_id"] = pipeline_id
            res = w.api_client.do("POST", "/api/2.2/jobs/create", body=job)
            job_id = str((res or {}).get("job_id"))
            repo.update_request(lb, rid, {"job_id": job_id}, audit=(actor, "job.create", {"job_id": job_id}))
            try:
                w.api_client.do("PATCH", f"/api/2.0/permissions/jobs/{job_id}",
                                body={"access_control_list": [{"user_name": e, "permission_level": "CAN_VIEW"} for e in people]})
            except Exception as e:  # noqa: BLE001
                log.warning("job permission failed: %s", e)
            _step(rid, version, current, "done", f"Job {job_id}: {job['schedule']['quartz_cron_expression']} (UTC).")

        # first run
        current = "first_run"
        _step(rid, version, current, "running")
        upd = w.api_client.do("POST", f"/api/2.0/pipelines/{pipeline_id}/updates", body={"full_refresh": False})
        uid = (upd or {}).get("update_id")
        _step(rid, version, current, "done", f"Initial snapshot started (update {uid or '?'}).")
        repo.update_request(lb, rid, {"status": "live"}, audit=(actor, "request.live", {"pipeline_id": pipeline_id}))
        repo.upsert_snapshot(lb, rid, {"pipeline_id": pipeline_id, "state": "RUNNING", "health": "healthy", "incidents_open": 0})
        from modules.itsm import service as itsm
        itsm.request_status(rid, "live", f"pipeline {pipeline_id}")

        # access: readers get READ ONLY on the landed tables once the first load created them
        current = "access"
        _step(rid, version, current, "running", "Waiting for the first load to create the tables…")
        state = _wait_update(w, pipeline_id, uid, FIRST_LOAD_TIMEOUT_S)
        from modules.uc_access import service as uc_access
        res = uc_access.ensure_reader_grants(rid, {**r, "id": rid}, cfg, w)
        granted = sum(1 for x in res if x["status"] == "granted")
        pending = [x for x in res if x["status"] != "granted"]
        _step(rid, version, current, "done" if not pending else "running",
              f"First load {state}. Read-only (USE CATALOG, USE SCHEMA, SELECT) for {', '.join(uc_access.readers(r, cfg)) or 'nobody'}: "
              f"{granted} grant(s)" + (f", {len(pending)} pending (the guardian retries)" if pending else ""))

        # qualify (GxP): reconcile, run the operational qualification, write the evidence pack
        current = "qualify"
        if not r.get("gxp"):
            _step(rid, version, current, "skipped", "Not a GxP request.")
        elif state != "COMPLETED":
            _step(rid, version, current, "running", "Qualification runs when the first load completes (guardian).")
        else:
            from core.identity import Caller
            from modules.gxp import oq
            from modules.monitor import service as monitor
            monitor.reconcile(rid)
            ev = oq.run(rid, Caller(email=actor, name=actor), w)
            _step(rid, version, current, "done" if ev["verdict"] != "FAIL" else "failed",
                  f"Operational qualification {ev['verdict']} · evidence sha256 {ev['sha256'][:16]}…" + (f" · {ev['volume_path']}" if ev.get("volume_path") else ""))
    except Exception as e:  # noqa: BLE001 - every failure is visible on the request
        msg = " ".join(str(e).split())[:1500]
        log.error("deploy %s failed at %s: %s\n%s", rid, current, msg, traceback.format_exc())
        try:
            _step(rid, version, current, "failed", msg)
            if current not in ("access", "qualify"):  # the pipeline is live; access / qualification failures are follow-ups
                repo.update_request(lb, rid, {"status": "failed"}, audit=(actor, "request.deploy_failed", {"step": current, "message": msg}))
                from modules.itsm import service as itsm
                itsm.request_status(rid, "failed", f"{current}: {msg[:300]}")
            else:
                repo.audit(lb, actor, f"request.{current}_failed", "request", rid, {"message": msg})
        except Exception:  # noqa: BLE001
            log.exception("could not record the deploy failure")
    finally:
        with _lock:
            _running.discard(rid)
