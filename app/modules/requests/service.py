"""Request lifecycle: draft -> (validate) -> pending_approval -> approved -> deploying -> live, with failed / rejected /
cancelled side exits. Writes go to Lakebase only and fail loudly; reads degrade (Lakebase -> UC mirror -> samples)."""
from __future__ import annotations

import json
import logging
from typing import Any

from core import access, config, lakebase, repo, tiers, warehouse
from core.errors import BadRequest, Conflict, NotFound, Unavailable
from core.identity import Caller
from modules.catalog import registry
from modules.deploy import specs
from modules.forecast import service as forecast_service
from modules.requests import rules, samples

log = logging.getLogger("dis.requests")


def lb():
    return lakebase.get()


def guard_write() -> None:
    if not config.ALLOW_MUTATIONS:
        raise Unavailable("The service is in read-only mode (kiosk): changes are switched off.")
    if not lb().configured:
        raise Unavailable("The request store (Lakebase) is not configured.")


# --- reference data ---------------------------------------------------------------------------------------------
def policies() -> dict[str, Any]:
    out = {k: v["value"] for k, v in rules.DEFAULT_POLICIES.items()}
    out["destinations"] = config.DESTINATIONS
    try:
        for r in repo.policies(lb()):
            out[r["key"]] = r["value"]
    except Exception:  # noqa: BLE001 - defaults when the store is down
        pass
    return out


def destinations() -> list[dict[str, Any]]:
    d = policies().get("destinations") or config.DESTINATIONS
    envs = policies().get("allowed_environments") or []
    return [{"environment": x["environment"], "label": x.get("label") or f"Foundation · {x['environment'].upper()}",
             "catalog": x["catalog"], "schema": x["schema"], "allowed": x["environment"] in envs,
             "requires_approval": bool(x.get("requires_approval", True))} for x in d]


def connectors() -> tuple[list[dict[str, Any]], str, str | None]:
    overrides, src, reason = {}, "lakebase", None
    try:
        overrides = repo.connector_overrides(lb()) if lb().configured else {}
        if not lb().configured:
            src, reason = "synthetic", "Lakebase not configured: built-in catalog"
    except Exception as e:  # noqa: BLE001
        src, reason = "synthetic", f"built-in catalog ({type(e).__name__})"
    try:
        counts = forecast_service.history_counts()
    except Exception:  # noqa: BLE001
        counts = {}
    items = []
    for c in registry.CONNECTORS:
        items.append({**{k: c[k] for k in ("id", "name", "category", "patterns", "status", "connection_type", "capabilities", "description")},
                      "cdc_architecture": c.get("cdc_architecture"), "enabled": overrides.get(c["id"], True),
                      "history_pipelines": counts.get(c["id"], 0)})
    return items, src, reason


def connector(cid: str) -> dict[str, Any] | None:
    c = registry.get(cid)
    if not c:
        return None
    try:
        enabled = repo.connector_overrides(lb()).get(cid, True) if lb().configured else True
    except Exception:  # noqa: BLE001
        enabled = True
    return {**c, "enabled": enabled}


# --- validation -------------------------------------------------------------------------------------------------
def _live_checks(cfg: dict[str, Any], conn: dict[str, Any] | None, rid: str = "IR-DRYRUN") -> list[dict[str, Any]]:
    """Checks that ask the workspace: connection usable, destination exists, and a Lakeflow Connect dry run."""
    out: list[dict[str, Any]] = []
    if config.OFFLINE or conn is None or conn.get("status") == "extension":
        return out
    try:
        w = lakebase.workspace_client()
    except Exception as e:  # noqa: BLE001
        return [{"key": "access.workspace", "label": "Access checks", "status": "warn", "detail": f"Workspace unavailable: {type(e).__name__}"}]
    name = cfg["source"].get("connection")
    via = cfg["source"].get("via", "connection")
    if name:
        try:
            if via == "uc_catalog":
                w.catalogs.get(name)
                detail = f"Catalog {name} is readable by the service; Lakeflow Connect reads it through Unity Catalog."
            else:
                w.connections.get(name)
                detail = f"{name} is visible to the service; credentials stay in the Unity Catalog connection."
            out.append({"key": "access.connection", "label": "Access: source", "status": "pass", "detail": detail})
        except Exception as e:  # noqa: BLE001
            out.append({"key": "access.connection", "label": "Access: source", "status": "fail",
                        "detail": f"The service cannot use {name} ({type(e).__name__}). Ask its owner for USE CONNECTION / USE CATALOG."})
    d = cfg["destination"]
    if d.get("catalog") and d.get("schema"):
        try:
            w.schemas.get(f"{d['catalog']}.{d['schema']}")
            out.append({"key": "access.destination", "label": "Access: destination", "status": "pass",
                        "detail": f"{d['catalog']}.{d['schema']} exists."})
        except Exception as e:  # noqa: BLE001
            out.append({"key": "access.destination", "label": "Access: destination", "status": "fail",
                        "detail": f"{d['catalog']}.{d['schema']} is not reachable ({type(e).__name__})."})
    # The pipeline definition itself is validated by Lakeflow at deploy time (a validate-only update before the first
    # run): pipelines.create(dry_run) rejects ingestion pipelines ("libraries must contain at least one element").
    return out


def _slot(conn: dict[str, Any], cfg: dict[str, Any]) -> dict[str, str] | None:
    if conn.get("id") != "postgresql":
        return None
    if config.DEMO_CONNECTION and cfg["source"].get("connection") == config.DEMO_CONNECTION:
        return {"slot_name": "dis_slot", "publication_name": "dis_publication"}  # created by the setup job
    return {"slot_name": f"dis_{specs.ident(cfg['source'].get('database') or 'db', 30)}_slot", "publication_name": "dis_publication"}


def check(cfg_in: dict[str, Any], *, live: bool = True, rid: str = "IR-DRYRUN") -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
    from modules.sources import service as sources
    cfg = sources.enrich(rules.normalize(cfg_in))
    conn = connector(cfg["source"].get("connector") or "")
    try:
        fc = forecast_service.forecast(cfg)
    except Exception as e:  # noqa: BLE001
        log.warning("forecast failed: %s", e)
        fc = None
    pol = policies()
    checks = [c.as_dict() for c in rules.evaluate(cfg, conn, pol, destinations(),
                                                  fc["cost"]["month"]["p50"] if fc else None)]
    if live and not any(c["key"] == "config.complete" and c["status"] == "fail" for c in checks):
        checks += _live_checks(cfg, conn, rid)
    return cfg, checks, fc


# --- reads ------------------------------------------------------------------------------------------------------
def _public(r: dict[str, Any]) -> dict[str, Any]:
    fc = r.get("forecast") or {}
    return {"id": r["id"], "title": r["title"], "status": r["status"], "channel": r["channel"], "requester": r["requester"],
            "owner": r.get("owner") or "", "classification": r.get("classification") or "internal",
            "environment": r.get("environment") or "dev", "connector": r.get("connector") or "", "pattern": r.get("pattern") or "",
            "n_objects": r.get("n_objects") or 0, "version": r.get("version") or 1, "created_at": r["created_at"],
            "updated_at": r["updated_at"], "pipeline_id": r.get("pipeline_id"), "gateway_id": r.get("gateway_id"),
            "job_id": r.get("job_id"), "forecast_month_usd": ((fc.get("cost") or {}).get("month") or {}).get("p50"),
            "sla_minutes": r.get("sla_minutes"), "gxp": bool(r.get("gxp")), "parent_id": r.get("parent_id"),
            "ticket_number": r.get("ticket_number")}


def _mirror_rows() -> list[dict[str, Any]]:
    rows = warehouse.query(f"SELECT payload FROM {config.uc('request_mirror')} ORDER BY updated_at DESC LIMIT 500")
    return [json.loads(r["payload"]) for r in rows]


def list_requests(caller: Caller, scope: str = "mine", status: str | None = None) -> dict[str, Any]:
    statuses = [s for s in (status or "").split(",") if s] or None
    is_admin = access.is_admin(lb(), caller.email)

    def from_lb():
        if scope == "all" and is_admin:
            rows = repo.list_requests(lb(), statuses=statuses)
        elif scope == "approvals":
            scopes = access.approver_scopes(lb(), caller.email)
            rows = [r for r in repo.list_requests(lb(), statuses=statuses or ["pending_approval"])
                    if scopes and ("domain:*" in scopes or f"domain:{(_domain(r))}" in scopes)]
        else:
            rows = repo.list_requests(lb(), requester=caller.email, statuses=statuses)
        return [_public(r) for r in rows]

    def from_mirror():
        rows = [m["request"] for m in _mirror_rows()]
        if scope == "mine":
            rows = [r for r in rows if r["requester"] == caller.email]
        return [r for r in rows if not statuses or r["status"] in statuses]

    items, source, reason = tiers.read(("lakebase", from_lb if lb().configured else None),
                                       ("warehouse", from_mirror if config.WAREHOUSE_ID and config.UC_CATALOG and not config.OFFLINE else None),
                                       ("synthetic", lambda: [s["request"] for s in samples.SAMPLES]))
    return {"items": items, "source": source, "degraded_reason": reason}


def _domain(r: dict[str, Any]) -> str:
    v = repo.get_version(lb(), r["id"])
    return ((v or {}).get("config") or {}).get("ownership", {}).get("domain", "").lower()


def _can(r: dict[str, Any], cfg: dict[str, Any], caller: Caller, checks: list[dict[str, Any]]) -> dict[str, bool]:
    try:
        admin = access.is_admin(lb(), caller.email)
        scopes = access.approver_scopes(lb(), caller.email)
    except Exception:  # noqa: BLE001
        admin, scopes = caller.email in access.bootstrap_admins(), []
    mine = r["requester"] == caller.email
    req = {**r, "domain": (cfg.get("ownership") or {}).get("domain", ""), "forecast_month_usd": _public(r)["forecast_month_usd"]}
    approve_ok, _ = rules.can_approve(caller.email, req, is_admin=admin, approver_scopes=scopes, policies=policies())
    writable = config.ALLOW_MUTATIONS
    env = (cfg.get("destination") or {}).get("environment", "dev")
    return {
        "promote": writable and r["status"] == "live" and env in ("dev", "uat") and (mine or admin or bool(scopes)),
        "qualify": writable and r["status"] == "live" and (admin or bool(scopes)),
        "sign_required": bool(r.get("gxp")),
        "edit": writable and r["status"] in rules.EDITABLE and (mine or admin),
        "submit": writable and r["status"] in rules.EDITABLE and (mine or admin) and not rules.failing(checks),
        "approve": writable and r["status"] == "pending_approval" and approve_ok,
        "deploy": writable and r["status"] in ("approved", "failed") and (admin or bool(scopes)),
        "cancel": writable and r["status"] in rules.CANCELLABLE and (mine or admin),
    }


def _links(r: dict[str, Any], cfg: dict[str, Any]) -> list[dict[str, str]]:
    h = config.host()
    if not h:
        return []
    out = []
    if r.get("pipeline_id"):
        out.append({"label": "Ingestion pipeline", "url": f"{h}/pipelines/{r['pipeline_id']}"})
    if r.get("gateway_id"):
        out.append({"label": "Ingestion gateway", "url": f"{h}/pipelines/{r['gateway_id']}"})
    if r.get("job_id"):
        out.append({"label": "Schedule job", "url": f"{h}/jobs/{r['job_id']}"})
    d = cfg.get("destination") or {}
    if d.get("catalog") and d.get("schema"):
        out.append({"label": f"{d['catalog']}.{d['schema']}", "url": f"{h}/explore/data/{d['catalog']}/{d['schema']}"})
    return out


def detail(rid: str, caller: Caller) -> dict[str, Any]:
    def from_lb():
        r = repo.get_request(lb(), rid)
        if r is None:
            raise NotFound(f"Request {rid} not found")
        v = repo.get_version(lb(), rid, r["version"]) or {}
        cfg = v.get("config") or {}
        checks = repo.get_checks(lb(), rid, r["version"])
        timeline = [{"at": a["at"], "actor": a["actor"], "action": a["action"], "detail": _detail_text(a)}
                    for a in repo.list_audit(lb(), "request", rid)]
        return {"request": _public(r), "config": cfg, "versions": repo.list_versions(lb(), rid), "checks": checks,
                "forecast": r.get("forecast"), "timeline": timeline, "deployment": repo.list_steps(lb(), rid, r["version"]),
                "links": _links(r, cfg), "can": _can(r, cfg, caller, checks), **_extras(r, cfg, caller)}

    def from_mirror():
        for m in _mirror_rows():
            if m["request"]["id"] == rid:
                return {**m, "can": {k: False for k in ("edit", "submit", "approve", "deploy", "cancel")}}
        raise NotFound(rid)

    def from_samples():
        for s in samples.SAMPLES:
            if s["request"]["id"] == rid:
                return s
        raise NotFound(rid)

    try:
        out, source, reason = tiers.read(("lakebase", from_lb if lb().configured else None),
                                         ("warehouse", from_mirror if config.WAREHOUSE_ID and config.UC_CATALOG and not config.OFFLINE else None),
                                         ("synthetic", from_samples))
    except RuntimeError as e:
        raise NotFound(f"Request {rid} not found") from e
    return {**out, "source": source, "degraded_reason": reason}


def _extras(r: dict[str, Any], cfg: dict[str, Any], caller: Caller) -> dict[str, Any]:
    """ServiceNow links, GxP (signatures, latest qualification), access model, promotion lineage. Never fails the page."""
    out: dict[str, Any] = {"itsm": [], "gxp": None, "access": None, "lineage": {"parent_id": r.get("parent_id"), "children": []}}
    try:
        from modules.itsm import servicenow
        out["itsm"] = servicenow.links(r["id"])
        out["itsm_mode"] = servicenow.mode()
    except Exception:  # noqa: BLE001
        pass
    try:
        from modules.gxp import esign, oq
        ev = oq.latest(r["id"])
        out["gxp"] = {"enabled": bool(r.get("gxp")), "signatures": esign.signatures(r["id"]),
                      "evidence": None if not ev else {k: ev[k] for k in ("id", "version", "verdict", "sha256", "volume_path", "created_by", "created_at")}
                      | {"checks": (ev.get("results") or {}).get("checks", [])}}
    except Exception:  # noqa: BLE001
        pass
    try:
        from modules.uc_access import service as uc_access
        out["access"] = uc_access.summary(r, cfg)
    except Exception:  # noqa: BLE001
        pass
    try:
        out["lineage"]["children"] = [x["id"] for x in lb().query(f"SELECT id FROM {repo.S()}.request WHERE parent_id = %s ORDER BY created_at", (r["id"],))]
    except Exception:  # noqa: BLE001
        pass
    env = (cfg.get("destination") or {}).get("environment", "dev")
    out["next_env"] = {"dev": "uat", "uat": "prod"}.get(env)
    return out


def _detail_text(a: dict[str, Any]) -> str:
    d = a.get("detail") or {}
    if isinstance(d, str):
        return d
    for k in ("reason", "message", "detail"):
        if d.get(k):
            return str(d[k])
    return ", ".join(f"{k}: {v}" for k, v in d.items() if v not in (None, "", [], {}))[:300]


# --- writes -----------------------------------------------------------------------------------------------------
def _fields(cfg: dict[str, Any], fc: dict[str, Any] | None) -> dict[str, Any]:
    return {"title": cfg["title"] or "Untitled request", "owner": cfg["ownership"]["owner"], "gxp": bool(cfg["ownership"].get("gxp")),
            "classification": cfg["ownership"]["classification"], "environment": cfg["destination"]["environment"],
            "connector": cfg["source"]["connector"], "pattern": cfg["source"]["pattern"], "n_objects": len(cfg["objects"]),
            "forecast": fc, "sla_minutes": cfg["schedule"]["sla_minutes"]}


def create(cfg_in: dict[str, Any], channel: str, caller: Caller, parent_id: str | None = None,
           ticket: dict[str, Any] | None = None) -> dict[str, Any]:
    if channel not in ("app", "chat", "servicenow", "api"):
        raise BadRequest("channel must be app, chat, servicenow or api")
    rules.normalize(cfg_in)  # 400 before 503
    guard_write()
    cfg, checks, fc = check(cfg_in, live=False)
    extra = {"parent_id": parent_id} if parent_id else {}
    rid = repo.create_request(lb(), {**_fields(cfg, fc), **extra, "status": "draft", "channel": channel, "requester": caller.email, "version": 1},
                              cfg, specs.config_hash(cfg), caller.email)
    repo.save_checks(lb(), rid, 1, checks)
    from modules.itsm import service as itsm
    if ticket and ticket.get("sys_id"):  # came from ServiceNow: link the existing record instead of opening a new one
        from modules.itsm import servicenow
        servicenow._save_link(rid, "request", ticket.get("table", "sc_req_item"), ticket, "draft")
        lb().execute(f"UPDATE {repo.S()}.request SET ticket_number = %s WHERE id = %s", (ticket.get("number"), rid))
    else:
        itsm.request_created(rid)
    return detail(rid, caller)


def _load(rid: str) -> dict[str, Any]:
    r = repo.get_request(lb(), rid)
    if r is None:
        raise NotFound(f"Request {rid} not found")
    return r


def update(rid: str, cfg_in: dict[str, Any], caller: Caller) -> dict[str, Any]:
    rules.normalize(cfg_in)  # 400 before 503
    guard_write()
    cfg, checks, fc = check(cfg_in, live=False)
    r = _load(rid)
    if r["requester"] != caller.email and not access.is_admin(lb(), caller.email):
        rules.require_actor(False, "Only the requester or an administrator can edit this request.")
    rules.require_transition(r["status"], "edit")
    v = int(r["version"]) + 1
    if not repo.add_version(lb(), rid, v, cfg, specs.config_hash(cfg), caller.email, {**_fields(cfg, fc), "status": "draft"}):
        raise Conflict("This request changed while you were editing it; reload and try again.")
    repo.save_checks(lb(), rid, v, checks)
    return detail(rid, caller)


def validate(rid: str, caller: Caller) -> dict[str, Any]:
    guard_write()
    r = _load(rid)
    v = repo.get_version(lb(), rid, r["version"]) or {}
    cfg, checks, fc = check(v.get("config") or {}, live=True, rid=rid)
    repo.save_checks(lb(), rid, r["version"], checks)
    repo.update_request(lb(), rid, {"forecast": fc}, audit=(caller.email, "request.validate",
                                                            {"fail": len(rules.failing(checks)), "checks": len(checks)}))
    return detail(rid, caller)


def submit(rid: str, caller: Caller) -> dict[str, Any]:
    guard_write()
    r = _load(rid)
    if r["requester"] != caller.email and not access.is_admin(lb(), caller.email):
        rules.require_actor(False, "Only the requester or an administrator can submit this request.")
    rules.require_transition(r["status"], "submit")
    v = repo.get_version(lb(), rid, r["version"]) or {}
    cfg, checks, fc = check(v.get("config") or {}, live=True, rid=rid)
    repo.save_checks(lb(), rid, r["version"], checks)
    bad = rules.failing(checks)
    if bad:
        repo.update_request(lb(), rid, {"forecast": fc})
        raise Conflict("Fix these checks before submitting: " + "; ".join(bad))
    if not repo.update_request(lb(), rid, {"status": "pending_approval", "forecast": fc}, expect_status=rules.EDITABLE,
                               audit=(caller.email, "request.submit", {"version": r["version"]})):
        raise Conflict("This request changed; reload and try again.")
    from modules.itsm import service as itsm
    itsm.request_status(rid, "pending_approval", f"submitted by {caller.email}")
    return detail(rid, caller)


def decide(rid: str, decision: str, reason: str | None, caller: Caller, signature: dict[str, Any] | None = None) -> dict[str, Any]:
    reason = rules.require_reason(reason, "approve" if decision == "approve" else "reject")
    guard_write()
    r = _load(rid)
    rules.require_transition(r["status"], decision)
    v = repo.get_version(lb(), rid, r["version"]) or {}
    cfg = v.get("config") or {}
    req = {**r, "domain": (cfg.get("ownership") or {}).get("domain", ""), "forecast_month_usd": _public(r)["forecast_month_usd"]}
    ok, why = rules.can_approve(caller.email, req, is_admin=access.is_admin(lb(), caller.email),
                                approver_scopes=access.approver_scopes(lb(), caller.email), policies=policies())
    rules.require_actor(ok, why)
    if r.get("gxp"):  # 21 CFR Part 11: the decision is an e-signature bound to this version's content hash
        from modules.gxp import esign
        env = (cfg.get("destination") or {}).get("environment")
        meaning = "Rejected" if decision == "reject" else ("Released to Production" if env == "prod" else "Released to UAT" if env == "uat" else "Approved")
        esign.sign(caller, rid, int(r["version"]), v.get("config_hash", ""), meaning, reason, (signature or {}).get("pin"),
                   (signature or {}).get("printed_name"))
    new = "approved" if decision == "approve" else "rejected"
    if not repo.update_request(lb(), rid, {"status": new}, expect_status=("pending_approval",),
                               audit=(caller.email, f"request.{decision}", {"reason": reason, "version": r["version"]})):
        raise Conflict("This request was decided by someone else; reload.")
    repo.add_approval(lb(), rid, r["version"], decision, caller.email, reason)
    from modules.itsm import service as itsm
    itsm.request_status(rid, new, f"{decision} by {caller.email}: {reason}")
    if new == "approved" and policies().get("auto_deploy_on_approval", True):
        from modules.deploy import executor
        executor.start(rid, caller.email)
    return detail(rid, caller)


def deploy(rid: str, caller: Caller) -> dict[str, Any]:
    guard_write()
    r = _load(rid)
    rules.require_transition(r["status"], "deploy")
    if not (access.is_admin(lb(), caller.email) or access.approver_scopes(lb(), caller.email)):
        rules.require_actor(False, "Only a data owner or an administrator can deploy.")
    from modules.deploy import executor
    executor.start(rid, caller.email)
    return detail(rid, caller)


def cancel(rid: str, reason: str | None, caller: Caller) -> dict[str, Any]:
    reason = rules.require_reason(reason, "cancel")
    guard_write()
    r = _load(rid)
    if r["requester"] != caller.email and not access.is_admin(lb(), caller.email):
        rules.require_actor(False, "Only the requester or an administrator can cancel this request.")
    rules.require_transition(r["status"], "cancel")
    if not repo.update_request(lb(), rid, {"status": "cancelled"}, expect_status=rules.CANCELLABLE,
                               audit=(caller.email, "request.cancel", {"reason": reason})):
        raise Conflict("This request changed; reload.")
    from modules.itsm import service as itsm
    itsm.request_status(rid, "cancelled", reason)
    return detail(rid, caller)


def promote(rid: str, to_env: str, caller: Caller) -> dict[str, Any]:
    """Change control: copy a LIVE request's approved configuration to the next environment as a new linked request
    (Dev → UAT → Prod). GxP: the source must have a passing qualification run on its current version."""
    if to_env not in ("uat", "prod"):
        raise BadRequest("Promote to uat or prod.")
    guard_write()
    r = _load(rid)
    rules.require_transition(r["status"], "promote")
    v = repo.get_version(lb(), rid, r["version"]) or {}
    cfg = rules.normalize(v.get("config") or {})
    order = {"dev": 0, "uat": 1, "prod": 2}
    if order[to_env] != order.get(cfg["destination"]["environment"], 0) + 1:
        raise Conflict(f"Promote one step at a time: {cfg['destination']['environment']} → {'uat' if cfg['destination']['environment'] == 'dev' else 'prod'}.")
    if r.get("gxp"):
        from modules.gxp import oq
        ev = oq.latest(rid)
        if not ev or ev["version"] != r["version"] or ev["verdict"] != "PASS":
            raise Conflict("GxP promotion needs a PASS qualification run on the current version first (Run qualification).")
    d = next((x for x in destinations() if x["environment"] == to_env and x["allowed"]), None)
    if not d:
        raise Conflict(f"No approved {to_env} destination.")
    new_cfg = {**cfg, "destination": {**cfg["destination"], "environment": to_env, "catalog": d["catalog"], "schema": d["schema"]},
               "title": cfg["title"], "_promotion": {"from": rid, "version": r["version"], "config_hash": v.get("config_hash")}}
    out = create(new_cfg, r["channel"] if r["channel"] in ("app", "chat", "servicenow", "api") else "app", caller, parent_id=rid)
    repo.audit(lb(), caller.email, "request.promote", "request", rid, {"to": to_env, "new_request": out["request"]["id"]})
    return out


def inbound_servicenow(payload: dict[str, Any], caller: Caller) -> dict[str, Any]:
    """A request that starts in ServiceNow (catalog item / RITM) becomes a draft here, linked to its ticket."""
    from modules.itsm import service as itsm
    cfg = itsm.from_servicenow(payload or {})
    if not destinations():
        raise Unavailable("No destinations configured.")
    d = next((x for x in destinations() if x["environment"] == cfg["destination"]["environment"]), None)
    if d:
        cfg["destination"].update({"catalog": d["catalog"], "schema": d["schema"]})
    ticket = {"table": payload.get("table", "sc_req_item"), "sys_id": payload.get("sys_id", ""), "number": payload.get("number")}
    out = create(cfg, "servicenow", caller, ticket=ticket)
    if payload.get("submit"):
        try:
            return submit(out["request"]["id"], caller)
        except Conflict:
            return detail(out["request"]["id"], caller)
    return out


def spec(rid: str) -> dict[str, Any]:
    r = _load(rid)
    v = repo.get_version(lb(), rid, r["version"]) or {}
    cfg = rules.normalize(v.get("config") or {})
    conn = connector(cfg["source"]["connector"]) or {}
    p = specs.build(rid, cfg, conn, staging_catalog=config.UC_CATALOG, staging_schema=config.GATEWAY_STORAGE_SCHEMA,
                    event_log_catalog=config.UC_CATALOG, event_log_schema=config.UC_SCHEMA,
                    gateway_id=r.get("gateway_id"), slot=_slot(conn, cfg))
    return {**p, "bundle_yaml": specs.bundle_yaml(rid, p)}
