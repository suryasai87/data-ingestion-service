"""Data Ingestion Service: FastAPI monolith (API under /api, the built React app as static files + SPA fallback)."""
from __future__ import annotations

import logging
import os
import pathlib
from typing import Any

from fastapi import Body, Depends, FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from core import config
from core.errors import BadRequest, Conflict, Forbidden, NotFound, Unavailable
from core.identity import Caller, caller
from modules.admin import service as admin
from modules.assistant import service as assistant
from modules.forecast import service as forecast
from modules.monitor import service as monitor
from modules.platform import service as platform
from modules.requests import rules
from modules.requests import service as requests_service
from modules.sources import service as sources

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("dis.app")
app = FastAPI(title="Data Ingestion Service", version=config.VERSION, docs_url="/api/docs", openapi_url="/api/openapi.json",
              description="Governed self-service ingestion (Lakeflow Connect). Every endpoint is callable with a Databricks token "
                          "(user or service principal) through the app URL: Authorization: Bearer <token>.")

from core import otel  # noqa: E402
from modules.usage import service as usage  # noqa: E402

otel.init()


@app.middleware("http")
async def _usage(request: Request, call_next):
    """Attribute every API call to the signed-in user (OBO identity) for usage / cost analytics + OpenTelemetry."""
    if not request.url.path.startswith("/api/") or request.url.path in ("/api/health",):
        return await call_next(request)
    import time as _t
    c = caller(request)
    t0 = _t.monotonic()
    with otel.span(f"{request.method} {usage.route_of(request.url.path)}", {"enduser.id": c.email, "http.method": request.method,
                                                                          "http.route": usage.route_of(request.url.path),
                                                                          "dis.obo": bool(c.token)}):
        resp = await call_next(request)
    usage.record(c.email, request.method, request.url.path, resp.status_code, (_t.monotonic() - t0) * 1000, bool(c.token))
    return resp


@app.exception_handler(BadRequest)
async def _400(_: Request, e: Exception):
    return JSONResponse({"detail": str(e)}, status_code=400)


@app.exception_handler(Unavailable)
async def _503(_: Request, e: Exception):
    return JSONResponse({"detail": str(e)}, status_code=503)


@app.exception_handler(Forbidden)
async def _403(_: Request, e: Exception):
    return JSONResponse({"detail": str(e)}, status_code=403)


@app.exception_handler(PermissionError)
async def _403p(_: Request, e: Exception):
    return JSONResponse({"detail": str(e)}, status_code=403)


@app.exception_handler(Conflict)
async def _409(_: Request, e: Exception):
    return JSONResponse({"detail": str(e)}, status_code=409)


@app.exception_handler(NotFound)
async def _404(_: Request, e: Exception):
    return JSONResponse({"detail": str(e)}, status_code=404)


@app.exception_handler(Exception)
async def _500(request: Request, e: Exception):
    # Reads degrade through tiers and never get here; a write that fails unexpectedly answers JSON the UI can show.
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": f"{type(e).__name__}: {' '.join(str(e).split())[:300]}"}, status_code=500)


Me = Depends(caller)


# --- platform ---------------------------------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return platform.health()


@app.get("/api/brand")
def brand():
    return platform.brand()


@app.get("/api/me")
def me(c: Caller = Me):
    return platform.me(c)


@app.get("/api/home")
def home(c: Caller = Me):
    return platform.home(c)


@app.get("/api/platform/resources")
def resources():
    try:
        return platform.resources()
    except Exception as e:  # noqa: BLE001 - the panel renders nothing rather than failing the page
        log.warning("resources failed: %s", e)
        return {"groups": []}


# --- catalog / sources ------------------------------------------------------------------------------------------
@app.get("/api/connectors")
def connectors():
    items, source, reason = requests_service.connectors()
    return {"items": items, "source": source, "degraded_reason": reason}


@app.get("/api/connection-types")
def connection_types():
    """Every Unity Catalog connection type and how the service ingests it (or why it is not a source)."""
    from modules.catalog import registry
    return {"items": registry.connection_types(), "source": "lakebase"}


@app.put("/api/connectors/{cid}")
def put_connector(cid: str, body: dict[str, Any] = Body(...), c: Caller = Me):
    return admin.set_connector(c, cid, bool(body.get("enabled")))


@app.get("/api/connections")
def connections(connector: str = Query(...)):
    try:
        return {"items": sources.list_connections(connector), "source": "workspace"}
    except Exception as e:  # noqa: BLE001
        demo = [{"name": config.DEMO_CONNECTION, "connection_type": "POSTGRESQL", "host": None, "owner": None, "usable": True,
                 "foreign_catalog": None, "demo": True}] if config.DEMO_CONNECTION and connector == "postgresql" else []
        return {"items": demo, "source": "synthetic", "degraded_reason": f"workspace unavailable: {type(e).__name__}"}


@app.get("/api/connections/{name}/objects")
def objects(name: str, connector: str | None = None):
    try:
        out = sources.browse(name)
        if out["browse"] == "manual" and connector:
            out["tables"] = sources.saas_suggestions(connector)
        return {**out, "source": "workspace"}
    except Exception as e:  # noqa: BLE001
        return {"connection": name, "schemas": [], "tables": sources.saas_suggestions(connector or ""), "browse": "manual",
                "source": "synthetic", "degraded_reason": f"browse unavailable: {type(e).__name__}: {str(e)[:160]}"}


@app.get("/api/destinations")
def destinations():
    try:
        return {"items": requests_service.destinations(), "source": "lakebase"}
    except Exception as e:  # noqa: BLE001
        return {"items": [], "source": "synthetic", "degraded_reason": type(e).__name__}


# --- forecast ---------------------------------------------------------------------------------------------------
@app.post("/api/forecast")
def post_forecast(body: dict[str, Any] = Body(...)):
    cfg = rules.normalize(body.get("config") or {})
    return forecast.forecast(cfg)


@app.get("/api/forecast/model")
def model_card():
    return forecast.model_card()


# --- requests ---------------------------------------------------------------------------------------------------
@app.post("/api/validate")
def validate_config(body: dict[str, Any] = Body(...)):
    cfg, checks, fc = requests_service.check(body.get("config") or {}, live=bool(body.get("live", False)))
    return {"checks": checks, "forecast": fc}


@app.get("/api/requests")
def list_requests(scope: str = "mine", status: str | None = None, c: Caller = Me):
    return requests_service.list_requests(c, scope, status)


@app.post("/api/requests")
def create_request(body: dict[str, Any] = Body(...), c: Caller = Me):
    return requests_service.create(body.get("config") or {}, body.get("channel") or "app", c)


@app.get("/api/requests/{rid}")
def get_request(rid: str, c: Caller = Me):
    return requests_service.detail(rid, c)


@app.put("/api/requests/{rid}")
def put_request(rid: str, body: dict[str, Any] = Body(...), c: Caller = Me):
    return requests_service.update(rid, body.get("config") or {}, c)


@app.post("/api/requests/{rid}/validate")
def validate_request(rid: str, c: Caller = Me):
    return requests_service.validate(rid, c)


@app.post("/api/requests/{rid}/submit")
def submit_request(rid: str, c: Caller = Me):
    return requests_service.submit(rid, c)


@app.post("/api/requests/{rid}/approve")
def approve_request(rid: str, body: dict[str, Any] = Body(default={}), c: Caller = Me):
    return requests_service.decide(rid, "approve", body.get("reason"), c, body.get("signature"))


@app.post("/api/requests/{rid}/reject")
def reject_request(rid: str, body: dict[str, Any] = Body(default={}), c: Caller = Me):
    return requests_service.decide(rid, "reject", body.get("reason"), c, body.get("signature"))


@app.post("/api/requests/{rid}/promote")
def promote_request(rid: str, body: dict[str, Any] = Body(...), c: Caller = Me):
    return requests_service.promote(rid, str(body.get("to") or ""), c)


@app.get("/api/requests/{rid}/preview")
def preview_request(rid: str, table: str | None = None, c: Caller = Me):
    return monitor.preview(rid, table, c)


@app.get("/api/requests/{rid}/access")
def request_access(rid: str, verify: bool = False, c: Caller = Me):
    from core import lakebase as _lb, repo as _repo
    from modules.requests import rules as _rules
    from modules.uc_access import service as uc_access
    r = _repo.get_request(_lb.get(), rid)
    if not r:
        raise NotFound(rid)
    cfg = _rules.normalize((_repo.get_version(_lb.get(), rid) or {}).get("config") or {})
    out = uc_access.summary(r, cfg)
    if verify:
        out["checks"] = uc_access.verify(r, cfg)
    return out


# --- GxP ----------------------------------------------------------------------------------------------------------
@app.get("/api/gxp/pin")
def pin_status(c: Caller = Me):
    from modules.gxp import esign
    return esign.pin_status(c)


@app.put("/api/gxp/pin")
def pin_set(body: dict[str, Any] = Body(...), c: Caller = Me):
    from modules.gxp import esign
    requests_service.guard_write()
    return esign.set_pin(c, str(body.get("pin") or ""), body.get("current_pin"))


@app.delete("/api/admin/signers/{email}/pin")
def pin_reset(email: str, body: dict[str, Any] = Body(default={}), c: Caller = Me):
    from modules.gxp import esign
    reason = rules.require_reason(body.get("reason"), "reset a signing PIN")
    requests_service.guard_write()
    admin.require_admin(c)
    esign.reset_pin(c, email, reason)
    return {"ok": True}


@app.post("/api/requests/{rid}/qualify")
def qualify_request(rid: str, c: Caller = Me):
    from modules.gxp import oq
    requests_service.guard_write()
    return oq.run(rid, c)


@app.get("/api/requests/{rid}/evidence")
def evidence_download(rid: str, c: Caller = Me):
    from fastapi.responses import Response
    from modules.gxp import oq
    name, pack = oq.pack_for(rid)
    return Response(pack, media_type="application/zip", headers={"content-disposition": f'attachment; filename="{name}"'})


# --- ServiceNow ---------------------------------------------------------------------------------------------------
@app.get("/api/itsm/status")
def itsm_status():
    from modules.itsm import servicenow
    return servicenow.status()


@app.get("/api/itsm/cmdb")
def itsm_cmdb(q: str = ""):
    from modules.itsm import servicenow
    try:
        return {"items": servicenow.cmdb_search(q), "source": "servicenow" if servicenow.mode() == "rest" else "simulator"}
    except Exception as e:  # noqa: BLE001
        return {"items": [], "source": "synthetic", "degraded_reason": f"ServiceNow unavailable: {type(e).__name__}"}


@app.post("/api/itsm/servicenow/inbound")
def itsm_inbound(body: dict[str, Any] = Body(...), c: Caller = Me):
    return requests_service.inbound_servicenow(body, c)


@app.api_route("/api/snow-sim/api/now/table/{rest:path}", methods=["GET", "POST", "PATCH", "PUT"])
async def snow_simulator(rest: str, request: Request):
    """The ServiceNow Table API simulator over HTTP (only when no instance is configured)."""
    from modules.itsm import servicenow, simulator
    if servicenow.mode() != "simulator":
        return JSONResponse({"detail": "ServiceNow simulator is off (a real instance is configured)"}, status_code=404)
    body = await request.json() if request.method in ("POST", "PATCH", "PUT") else None
    status, out = simulator.handle(request.method, f"/api/now/table/{rest}", dict(request.query_params), body)
    return JSONResponse(out, status_code=status)


# --- usage analytics (admins) ---------------------------------------------------------------------------------------
@app.get("/api/admin/usage")
def admin_usage(days: int = 30, c: Caller = Me):
    admin.require_admin(c)
    try:
        return {**usage.analytics(max(1, min(365, days))), "source": "lakebase"}
    except Exception as e:  # noqa: BLE001
        return {"days": days, "users": [], "daily": [], "totals": {}, "otel": {"enabled": otel.enabled}, "source": "synthetic",
                "degraded_reason": f"usage store unavailable: {type(e).__name__}"}


@app.post("/api/requests/{rid}/deploy")
def deploy_request(rid: str, c: Caller = Me):
    return requests_service.deploy(rid, c)


@app.post("/api/requests/{rid}/cancel")
def cancel_request(rid: str, body: dict[str, Any] = Body(default={}), c: Caller = Me):
    return requests_service.cancel(rid, body.get("reason"), c)


@app.get("/api/requests/{rid}/spec")
def request_spec(rid: str):
    return requests_service.spec(rid)


# --- pipelines --------------------------------------------------------------------------------------------------
@app.get("/api/pipelines")
def pipelines(c: Caller = Me):
    return monitor.pipelines(c)


@app.post("/api/pipelines/{rid}/run")
def pipeline_run(rid: str, c: Caller = Me):
    return monitor.run_now(rid, c)


@app.post("/api/pipelines/pause-all")
def pipelines_pause_all(c: Caller = Me):
    return monitor.pause_all(c)


@app.post("/api/pipelines/{rid}/pause")
@app.post("/api/pipelines/{rid}/stop")
def pipeline_pause(rid: str, c: Caller = Me):
    return monitor.pause(rid, c)


@app.post("/api/pipelines/{rid}/unpause")
def pipeline_unpause(rid: str, c: Caller = Me):
    return monitor.unpause(rid, c)


@app.post("/api/pipelines/{rid}/reconcile")
def pipeline_reconcile(rid: str, c: Caller = Me):
    return monitor.reconcile(rid, c)


@app.get("/api/pipelines/{rid}/incidents")
def pipeline_incidents(rid: str):
    from core import lakebase, repo
    try:
        return {"items": repo.incidents(lakebase.get(), rid), "source": "lakebase"}
    except Exception as e:  # noqa: BLE001
        return {"items": [], "source": "synthetic", "degraded_reason": type(e).__name__}


@app.post("/api/demo/source-activity")
def source_activity(body: dict[str, Any] = Body(default={}), c: Caller = Me):
    try:
        ins, upd, dele = int(body.get("inserts", 50)), int(body.get("updates", 20)), int(body.get("deletes", 5))
    except (TypeError, ValueError) as e:
        raise BadRequest("inserts / updates / deletes must be numbers") from e
    return monitor.demo_activity(c, ins, upd, dele)


# --- assistant --------------------------------------------------------------------------------------------------
@app.post("/api/assistant/chat")
def assistant_chat(body: dict[str, Any] = Body(...), c: Caller = Me):
    msg = str(body.get("message") or "").strip()
    if not msg:
        raise BadRequest("message is required")
    return assistant.chat(body.get("session_id"), msg, c)


@app.post("/api/assistant/{sid}/submit")
def assistant_submit(sid: str, c: Caller = Me):
    return assistant.submit(sid, c)


# --- administration ---------------------------------------------------------------------------------------------
@app.get("/api/admin/admins")
def admin_list(c: Caller = Me):
    return admin.admins(c)


@app.post("/api/admin/admins")
def admin_grant(body: dict[str, Any] = Body(...), c: Caller = Me):
    return admin.grant_admin(c, body.get("email"), body.get("reason"))


@app.delete("/api/admin/admins/{email}")
def admin_revoke(email: str, body: dict[str, Any] = Body(default={}), c: Caller = Me):
    return admin.revoke_admin(c, email, body.get("reason"))


@app.get("/api/admin/workspace-users")
def admin_users(q: str = "", c: Caller = Me):
    return admin.workspace_users(c, q)


@app.get("/api/admin/approvers")
def approver_list(c: Caller = Me):
    return admin.approvers(c)


@app.post("/api/admin/approvers")
def approver_grant(body: dict[str, Any] = Body(...), c: Caller = Me):
    return admin.grant_approver(c, body.get("email"), body.get("scope"), body.get("reason"))


@app.delete("/api/admin/approvers/{email}")
def approver_revoke(email: str, scope: str = Query(...), body: dict[str, Any] = Body(default={}), c: Caller = Me):
    return admin.revoke_approver(c, email, scope, body.get("reason"))


@app.get("/api/admin/policies")
def policy_list(c: Caller = Me):
    return admin.policies(c)


@app.put("/api/admin/policies/{key}")
def policy_set(key: str, body: dict[str, Any] = Body(...), c: Caller = Me):
    return admin.set_policy(c, key, body.get("value"))


@app.get("/api/admin/audit")
def audit(limit: int = 200, c: Caller = Me):
    return admin.audit(c, limit)


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
def api_404(rest: str):
    return JSONResponse({"detail": f"No API route /api/{rest}"}, status_code=404)


# --- the SPA ----------------------------------------------------------------------------------------------------
STATIC = pathlib.Path(__file__).resolve().parent / "static"
if (STATIC / "_app").exists():
    app.mount("/_app", StaticFiles(directory=STATIC / "_app"), name="assets")


@app.get("/{full_path:path}")
def spa(full_path: str):
    candidate = STATIC / full_path
    if full_path and candidate.is_file() and STATIC in candidate.resolve().parents:
        return FileResponse(candidate)
    index = STATIC / "index.html"
    if index.exists():
        return FileResponse(index, headers={"cache-control": "no-cache"})
    return JSONResponse({"detail": "UI not built (run the frontend build)"}, status_code=404)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("DATABRICKS_APP_PORT", os.environ.get("PORT", "8000"))))
