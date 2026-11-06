"""Administration: admins (bootstrap + delegated in the app), data owners (approvers), policies, audit.

Guardrails: only admins call any of this (403 otherwise); a reason is required on every grant and revoke; the
deployer / bootstrap admins cannot be revoked in the app; the last admin cannot be removed; every change is audited;
store down = bootstrap admins still work and grants answer 503.
"""
from __future__ import annotations

import re
from typing import Any

from core import access, config, lakebase, repo
from core.errors import BadRequest, Conflict, Forbidden
from core.identity import Caller
from modules.forecast import service as forecast_service
from modules.requests import rules
from modules.requests import service as rs

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def require_admin(caller: Caller) -> None:
    if not access.is_admin(lakebase.get(), caller.email):
        raise Forbidden("Administrators only.")


def _email(v: str | None) -> str:
    e = (v or "").strip().lower()
    if not EMAIL.match(e):
        raise BadRequest("A valid email address is required.")
    return e


def admins(caller: Caller) -> dict[str, Any]:
    require_admin(caller)
    lb = lakebase.get()
    boot = access.bootstrap_admins()
    deployer = boot[0] if boot else None
    items = [{"email": e, "source": "deployer" if e == deployer else "bootstrap", "granted_by": None, "granted_at": None,
              "reason": "Deployed the service" if e == deployer else "Bootstrap admin (bundle variable)", "removable": False} for e in boot]
    try:
        granted = repo.granted_admins(lb)
        source = "lakebase"
    except Exception:  # noqa: BLE001
        granted, source = [], "synthetic"
    for g in granted:
        if g["email"] in boot:
            continue
        items.append({"email": g["email"], "source": "granted", "granted_by": g["granted_by"], "granted_at": g["granted_at"],
                      "reason": g["reason"], "removable": True})
    total = len(items)
    for i in items:
        if i["removable"] and total <= 1:
            i["removable"] = False
    return {"items": items, "source": source}


def grant_admin(caller: Caller, email: str, reason: str) -> dict[str, Any]:
    e = _email(email)
    r = rules.require_reason(reason, "grant admin")
    rs.guard_write()
    require_admin(caller)
    if e in access.bootstrap_admins():
        raise Conflict(f"{e} is already an admin (deployer / bootstrap).")
    repo.grant_admin(lakebase.get(), e, caller.email, r)
    access.invalidate()
    return admins(caller)


def revoke_admin(caller: Caller, email: str, reason: str) -> dict[str, Any]:
    e = _email(email)
    r = rules.require_reason(reason, "revoke admin")
    rs.guard_write()
    require_admin(caller)
    if e in access.bootstrap_admins():
        raise Conflict("The deployer and bootstrap admins can't be revoked in the app.")
    current = admins(caller)["items"]
    if len(current) <= 1:
        raise Conflict("The last admin can't be removed.")
    if not repo.revoke_admin(lakebase.get(), e, caller.email, r):
        raise Conflict(f"{e} is not a granted admin.")
    access.invalidate()
    return admins(caller)


def workspace_users(caller: Caller, q: str) -> dict[str, Any]:
    require_admin(caller)
    q = re.sub(r'["\\]', "", (q or "").strip())[:60]
    if len(q) < 2:
        return {"items": [], "source": "workspace"}
    try:
        w = lakebase.workspace_client()
        users = w.users.list(filter=f'userName co "{q}" or displayName co "{q}"', attributes="userName,displayName,active", count=20)
        items = []
        for u in users:
            items.append({"email": (u.user_name or "").lower(), "name": u.display_name or u.user_name, "active": bool(u.active)})
            if len(items) >= 20:
                break
        return {"items": items, "source": "workspace"}
    except Exception as e:  # noqa: BLE001 - the picker degrades to "type any email"
        return {"items": [], "source": "synthetic", "degraded_reason": f"directory search unavailable: {type(e).__name__}"}


def approvers(caller: Caller) -> dict[str, Any]:
    require_admin(caller)
    try:
        return {"items": repo.approvers(lakebase.get()), "source": "lakebase"}
    except Exception as e:  # noqa: BLE001
        return {"items": [], "source": "synthetic", "degraded_reason": type(e).__name__}


def _scope(v: str) -> str:
    s = (v or "").strip().lower()
    if not re.match(r"^domain:(\*|[a-z0-9 _-]{2,40})$", s):
        raise BadRequest("Scope must be domain:* or domain:<name>.")
    return s


def grant_approver(caller: Caller, email: str, scope: str, reason: str) -> dict[str, Any]:
    e, sc, r = _email(email), _scope(scope), rules.require_reason(reason, "grant approval rights")
    rs.guard_write()
    require_admin(caller)
    repo.grant_approver(lakebase.get(), e, sc, caller.email, r)
    access.invalidate()
    return approvers(caller)


def revoke_approver(caller: Caller, email: str, scope: str, reason: str) -> dict[str, Any]:
    e, sc, r = _email(email), _scope(scope), rules.require_reason(reason, "revoke approval rights")
    rs.guard_write()
    require_admin(caller)
    if not repo.revoke_approver(lakebase.get(), e, sc, caller.email, r):
        raise Conflict("No such active approver.")
    access.invalidate()
    return approvers(caller)


def policies(caller: Caller) -> dict[str, Any]:
    require_admin(caller)
    stored: dict[str, Any] = {}
    source = "lakebase"
    try:
        stored = {r["key"]: r for r in repo.policies(lakebase.get())}
    except Exception:  # noqa: BLE001
        source = "synthetic"
    items = []
    for k, meta in rules.DEFAULT_POLICIES.items():
        row = stored.get(k)
        value = row["value"] if row else (config.DESTINATIONS if k == "destinations" else meta["value"])
        items.append({"key": k, "label": meta["label"], "description": meta["description"], "value": value,
                      "updated_by": row["updated_by"] if row else None, "updated_at": row["updated_at"] if row else None})
    return {"items": items, "source": source}


def _validate_policy(key: str, value: Any) -> Any:
    default = rules.DEFAULT_POLICIES[key]["value"]
    if key == "destinations":
        if not isinstance(value, list) or not all(isinstance(d, dict) and {"environment", "catalog", "schema"} <= set(d) for d in value):
            raise BadRequest("destinations must be a list of {environment, label, catalog, schema, requires_approval}.")
        return value
    if isinstance(default, bool):
        if not isinstance(value, bool):
            raise BadRequest(f"{key} must be true or false.")
        return value
    if isinstance(default, (int, float)):
        try:
            v = float(value)
        except (TypeError, ValueError) as e:
            raise BadRequest(f"{key} must be a number.") from e
        if v < 0:
            raise BadRequest(f"{key} can't be negative.")
        return int(v) if isinstance(default, int) else v
    if isinstance(default, list):
        if not isinstance(value, list):
            raise BadRequest(f"{key} must be a list.")
        return [str(x).strip().lower() for x in value if str(x).strip()]
    return value


def set_policy(caller: Caller, key: str, value: Any) -> dict[str, Any]:
    if key not in rules.DEFAULT_POLICIES:
        raise BadRequest(f"Unknown policy {key}.")
    v = _validate_policy(key, value)
    rs.guard_write()
    require_admin(caller)
    repo.set_policy(lakebase.get(), key, v, caller.email)
    return policies(caller)


def set_connector(caller: Caller, cid: str, enabled: bool) -> dict[str, Any]:
    rs.guard_write()
    require_admin(caller)
    from modules.catalog import registry
    if not registry.get(cid):
        raise BadRequest(f"Unknown connector {cid}.")
    repo.set_connector(lakebase.get(), cid, bool(enabled), caller.email)
    items, _, _ = rs.connectors()
    forecast_service.invalidate()
    return next(i for i in items if i["id"] == cid)


def audit(caller: Caller, limit: int = 200) -> dict[str, Any]:
    require_admin(caller)
    try:
        return {"items": repo.list_audit(lakebase.get(), limit=max(1, min(1000, limit))), "source": "lakebase"}
    except Exception as e:  # noqa: BLE001
        return {"items": [], "source": "synthetic", "degraded_reason": type(e).__name__}
