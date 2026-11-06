"""The access model, enforced and verified:

  source  -> only the app's service principal (the headless pipeline identity). People never get the connection or
             the source catalog; the setup job makes the SP the owner of the demo source catalog.
  runtime -> pipelines are created by and run as the SP (owner = run_as = SP).
  target  -> people get READ ONLY on what their request landed: USE CATALOG + USE SCHEMA + SELECT per table.
             Nobody but the SP can MODIFY the landing tables.

Grants are made by the SP: it owns the tables its pipelines create, and the setup job gives it MANAGE on the
Foundation schemas (and the destination catalog) so it may grant USE SCHEMA / USE CATALOG to readers.
"""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

from core import config, lakebase, repo
from modules.deploy import specs

log = logging.getLogger("dis.uc_access")
WRITE_PRIVS = {"MODIFY", "ALL_PRIVILEGES", "MANAGE", "CREATE_TABLE", "CREATE_MATERIALIZED_VIEW"}


def _api(w: Any, method: str, path: str, body: Any = None) -> Any:
    return w.api_client.do(method, path, body=body)


def sp_identity(w: Any) -> str:
    import os

    return os.environ.get("DATABRICKS_CLIENT_ID") or w.current_user.me().user_name


def readers(r: dict[str, Any], cfg: dict[str, Any]) -> list[str]:
    own = cfg.get("ownership") or {}
    extra = [x.strip().lower() for x in (own.get("readers") or []) if str(x).strip()]
    return sorted({p for p in [r.get("requester"), own.get("owner"), *extra] if p and ("@" in p or p.startswith("group:"))})


def principal_name(p: str) -> str:
    return p.split(":", 1)[1] if p.startswith("group:") else p


def tables(cfg: dict[str, Any]) -> list[str]:
    d = cfg.get("destination") or {}
    pre = d.get("table_prefix") or ""
    return [f"{d['catalog']}.{d['schema']}.{specs.destination_table(o, pre)}" for o in cfg.get("objects") or []]


def _grant(w: Any, kind: str, name: str, principal: str, privs: list[str]) -> None:
    _api(w, "PATCH", f"/api/2.1/unity-catalog/permissions/{kind}/{quote(name, safe='')}",
         {"changes": [{"principal": principal, "add": privs}]})


def ensure_reader_grants(rid: str, r: dict[str, Any], cfg: dict[str, Any], w: Any | None = None) -> list[dict[str, Any]]:
    """Idempotent: grant every reader read-only access to the request's landed tables (pending until they exist)."""
    w = w or lakebase.workspace_client()
    lb = lakebase.get()
    d = cfg["destination"]
    out = []
    for p in readers(r, cfg):
        who = principal_name(p)
        for kind, name, privs in [("catalog", d["catalog"], ["USE_CATALOG"]), ("schema", f"{d['catalog']}.{d['schema']}", ["USE_SCHEMA"])] + \
                                 [("table", t, ["SELECT"]) for t in tables(cfg)]:
            status, detail = "granted", ""
            try:
                if kind == "table":
                    _api(w, "GET", f"/api/2.1/unity-catalog/tables/{quote(name, safe='')}")
                _grant(w, kind, name, who, privs)
            except Exception as e:  # noqa: BLE001
                msg = " ".join(str(e).split())[:300]
                status = "pending" if kind == "table" and ("not found" in msg.lower() or "does not exist" in msg.lower()) else "failed"
                detail = msg
            lb.execute(f"INSERT INTO {repo.S()}.reader_grant (request_id, principal, securable, privileges, status, detail) VALUES (%s,%s,%s,%s,%s,%s) "
                       f"ON CONFLICT (request_id, principal, securable) DO UPDATE SET privileges = EXCLUDED.privileges, status = EXCLUDED.status, "
                       f"detail = EXCLUDED.detail, at = now()", (rid, p, name, ",".join(privs), status, detail))
            out.append({"principal": p, "securable": name, "privileges": privs, "status": status, "detail": detail})
    if out and all(x["status"] == "granted" for x in out):
        repo.audit(lb, "service", "access.readers_granted", "request", rid, {"readers": readers(r, cfg), "tables": len(tables(cfg))})
    return out


def grants_for(rid: str) -> list[dict[str, Any]]:
    return [repo.row(x) for x in lakebase.get().query(
        f"SELECT principal, securable, privileges, status, detail, at FROM {repo.S()}.reader_grant WHERE request_id = %s ORDER BY principal, securable", (rid,))]


def _effective(w: Any, kind: str, name: str) -> list[dict[str, Any]]:
    r = _api(w, "GET", f"/api/2.1/unity-catalog/effective-permissions/{kind}/{quote(name, safe='')}") or {}
    out = []
    for a in r.get("privilege_assignments") or []:
        privs = [p.get("privilege") for p in a.get("privileges") or []]
        out.append({"principal": a.get("principal"), "privileges": privs})
    return out


def verify(r: dict[str, Any], cfg: dict[str, Any], w: Any | None = None) -> list[dict[str, Any]]:
    """Checks for the access model (used by the GxP OQ and the request detail's Access panel)."""
    w = w or lakebase.workspace_client()
    sp = sp_identity(w)
    checks: list[dict[str, Any]] = []
    # runtime: owner of every landed table is the SP
    owners = {}
    for t in tables(cfg):
        try:
            owners[t] = (_api(w, "GET", f"/api/2.1/unity-catalog/tables/{quote(t, safe='')}") or {}).get("owner")
        except Exception as e:  # noqa: BLE001
            owners[t] = f"(not found: {type(e).__name__})"
    bad_owner = {t: o for t, o in owners.items() if o != sp}
    checks.append({"key": "access.runtime", "label": "Pipeline identity owns the landed tables", "status": "pass" if not bad_owner else "fail",
                   "detail": f"Owner of {len(owners)} table(s) = the service principal." if not bad_owner else f"Not owned by the SP: {bad_owner}"})
    # target: people read only
    people = set(principal_name(p) for p in readers(r, cfg))
    writers: dict[str, list[str]] = {}
    for t in tables(cfg):
        try:
            for a in _effective(w, "table", t):
                if a["principal"] in (sp,):
                    continue
                if a["principal"] in people and WRITE_PRIVS & set(a["privileges"]):
                    writers.setdefault(t, []).append(f"{a['principal']}: {','.join(a['privileges'])}")
        except Exception as e:  # noqa: BLE001
            writers.setdefault(t, []).append(f"(effective permissions unavailable: {type(e).__name__})")
    checks.append({"key": "access.target_read_only", "label": "People have read-only access to the landed tables",
                   "status": "pass" if not writers else "fail",
                   "detail": f"Readers {', '.join(sorted(people)) or '—'}: SELECT only." if not writers else f"Write privileges found: {writers}"})
    # source: service principal only
    src = cfg.get("source") or {}
    name = src.get("connection")
    if name:
        kind = "catalog" if src.get("via") == "uc_catalog" else "connection"
        try:
            meta = _api(w, "GET", f"/api/2.1/unity-catalog/{'catalogs' if kind == 'catalog' else 'connections'}/{quote(name, safe='')}") or {}
            others = []
            for a in _effective(w, kind, name):
                if a["principal"] != sp and a["principal"] in people and set(a["privileges"]) - {"BROWSE"}:
                    others.append(f"{a['principal']}: {','.join(a['privileges'])}")
            ok = meta.get("owner") == sp and not others
            checks.append({"key": "access.source_isolated", "label": "Only the service principal can use the source",
                           "status": "pass" if ok else "warn",
                           "detail": (f"{kind} {name} is owned by the service principal; no requester or reader holds a privilege on it."
                                      if ok else f"{kind} {name} owner {meta.get('owner')}; people with access: {others or 'none'}")})
        except Exception as e:  # noqa: BLE001
            checks.append({"key": "access.source_isolated", "label": "Only the service principal can use the source", "status": "warn",
                           "detail": f"Could not read the source's permissions ({type(e).__name__})."})
    return checks


def summary(r: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    src = cfg.get("source") or {}
    return {"run_as": "app service principal (headless)", "service_principal": config.APP_NAME,
            "source": {"securable": src.get("connection"), "kind": "catalog" if src.get("via") == "uc_catalog" else "connection",
                       "who": "service principal only"},
            "target": {"tables": tables(cfg), "readers": readers(r, cfg), "privileges": ["USE CATALOG", "USE SCHEMA", "SELECT"]},
            "grants": grants_for(r["id"]) if r.get("id") else []}
