"""Conversational intake: plain language -> the same governed IngestionConfig the guided form produces.

The LLM only DRAFTS. Deterministic code then (1) grounds the draft in reality (table names resolved against the
source's real objects: schema, primary keys, cursor columns, row counts), (2) computes what is still missing, and
(3) runs the same checks as the form. Submitting goes through the same validation + approval, never straight to a
deployment. When the model is unavailable, a rules parser keeps the conversation working (`llm: "rules"`).
"""
from __future__ import annotations

import copy
import json
import logging
import re
import threading
import uuid
from typing import Any

from core import config, lakebase, llm, repo
from core.errors import Conflict, Unavailable
from core.identity import Caller
from modules.catalog import registry
from modules.requests import rules
from modules.requests import service as rs
from modules.sources import service as sources

log = logging.getLogger("dis.assistant")
_mem: dict[str, dict[str, Any]] = {}  # session fallback while the store is down (never persisted)
_lock = threading.Lock()

INTERVAL_WORDS = {"hourly": 60, "every hour": 60, "daily": 1440, "every day": 1440, "nightly": 1440, "half-hourly": 30}
CLASS_WORDS = {"restricted": "restricted", "confidential": "confidential", "internal": "internal", "public": "public"}
DOMAINS = ("finance", "sales", "supply chain", "manufacturing", "quality", "hr", "procurement", "marketing", "clinical", "regulatory")


def _connector_aliases() -> list[tuple[str, str]]:
    out = []
    for c in registry.CONNECTORS:
        names = {c["id"], c["name"].lower()}
        names |= {"postgres", "pg", "lakebase", "erp postgres"} if c["id"] == "postgresql" else set()
        names |= {"mssql", "sql server", "azure sql"} if c["id"] == "sqlserver" else set()
        names |= {"sfdc", "crm"} if c["id"] == "salesforce" else set()
        names |= {"snow", "itsm"} if c["id"] == "servicenow" else set()
        names |= {"sap hana", "hana", "s/4", "s4", "ecc"} if c["id"] == "sap" else set()
        for n in names:
            out.append((n, c["id"]))
    return sorted(out, key=lambda x: -len(x[0]))


def parse_rules(text: str) -> dict[str, Any]:
    """Keyword parser: the fallback when the LLM is down, and a grounding pre-pass for it."""
    t = text.lower()
    patch: dict[str, Any] = {}
    for alias, cid in _connector_aliases():
        if re.search(rf"(?<![a-z]){re.escape(alias)}(?![a-z])", t):
            patch.setdefault("source", {})["connector"] = cid
            break
    if re.search(r"query[- ]based|cursor", t):
        patch.setdefault("source", {})["pattern"] = "query"
    elif re.search(r"\bcdc\b|change data capture|log[- ]based|replication", t):
        patch.setdefault("source", {})["pattern"] = "cdc"
    m = re.search(r"every\s+(\d+)\s*(min|minute|minutes|m)\b", t)
    h = re.search(r"every\s+(\d+)\s*(h|hr|hrs|hour|hours)\b", t)
    if re.search(r"continuous|real[- ]time|streaming", t):
        patch["schedule"] = {"mode": "continuous"}
    elif m:
        patch["schedule"] = {"mode": "interval", "interval_minutes": int(m.group(1))}
    elif h:
        patch["schedule"] = {"mode": "interval", "interval_minutes": int(h.group(1)) * 60}
    else:
        for w, mins in INTERVAL_WORDS.items():
            if w in t:
                patch["schedule"] = {"mode": "interval", "interval_minutes": mins}
                break
    s = re.search(r"(?:sla|within|fresh(?:er)? than|latency of)\s+(\d+)\s*(min|minutes|h|hours)", t)
    if s:
        patch.setdefault("schedule", {})["sla_minutes"] = int(s.group(1)) * (60 if s.group(2).startswith("h") else 1)
    for w, cls in CLASS_WORDS.items():
        if re.search(rf"\b{w}\b", t):
            patch.setdefault("ownership", {})["classification"] = cls
            break
    e = re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text)
    if e:
        patch.setdefault("ownership", {})["owner"] = e.group(0).lower()
    for d in DOMAINS:
        if re.search(rf"\b{d}\b", t):
            patch.setdefault("ownership", {})["domain"] = d
            break
    env = re.search(r"\b(dev|development|uat|test|prod|production)\b", t)
    if env:
        patch.setdefault("destination", {})["environment"] = {"development": "dev", "test": "uat", "production": "prod"}.get(env.group(1), env.group(1))
    if re.search(r"scd ?2|history|historical versions|track changes over time", t):
        patch["schema"] = {"scd_type": "SCD_TYPE_2"}
    # table names: schema.table, ALLCAPS SAP-style names, or "tables a, b and c"
    tables = re.findall(r"\b([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b", text, re.I)
    tables += re.findall(r"\b([A-Z][A-Z0-9_]{2,})\b", text)
    lst = re.search(r"tables?\s+([a-z0-9_.,\s]+?)(?:\s+(?:from|into|to|every|in|on)\b|[!?]|\.(?:\s|$)|$)", text, re.I)
    if lst:
        tables += [x for x in re.split(r"\s*,\s*|\s+and\s+|\s+", lst.group(1)) if x and x.lower() not in ("and", "the", "table", "tables")]
    stop = {"SAP", "HANA", "CDC", "SLA", "UAT", "DEV", "PROD", "SQL", "API", "ERP", "CRM", "SCD", "GL", "ID"}
    qualified = {x.split(".", 1)[0].lower() for x in tables if "." in x} | {x.split(".", 1)[1].lower() for x in tables if "." in x}
    seen, objs = set(), []
    for x in tables:
        if "." not in x and x.lower() in qualified:
            continue  # already part of a schema.table mention
        if x.upper() in stop or x.lower() in ("foundation", "postgres", "postgresql", "salesforce"):
            continue
        k = x.lower()
        if k not in seen:
            seen.add(k)
            sch, _, tb = x.rpartition(".")
            objs.append({"schema": sch, "table": tb})
    if objs:
        patch["objects"] = objs
    return patch


def merge(draft: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(draft)
    for k, v in (patch or {}).items():
        if k == "objects" and isinstance(v, list):
            if v:
                out["objects"] = v
        elif isinstance(v, dict):
            out[k] = {**(out.get(k) or {}), **{kk: vv for kk, vv in v.items() if vv not in (None, "")}}
        elif v not in (None, ""):
            out[k] = v
    return out


def _ground(draft: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Resolve connection, destination and table names against what really exists."""
    notes: list[str] = []
    d = copy.deepcopy(draft)
    src = d.setdefault("source", {})
    cid = src.get("connector")
    c = registry.get(cid or "")
    if c:
        if src.get("pattern") not in c["patterns"]:
            src["pattern"] = c["patterns"][0]
        if not src.get("connection") and c.get("connection_type"):
            try:
                conns = [x for x in sources.list_connections(cid) if x["usable"]]
                if conns:
                    pick = next((x for x in conns if src.get("pattern") in (x.get("patterns") or c["patterns"])), conns[0])
                    src["connection"] = pick["name"]
                    src["via"] = pick.get("via", "connection")
                    if src.get("pattern") not in (pick.get("patterns") or c["patterns"]):
                        src["pattern"] = (pick.get("patterns") or c["patterns"])[0]
                    notes.append(f"source: {pick['name']}" + (", read query-based" if src["pattern"] == "query" else ""))
            except Exception:  # noqa: BLE001
                pass
    dest = d.setdefault("destination", {})
    env = dest.get("environment") or "dev"
    match = [x for x in rs.destinations() if x["environment"] == env and x["allowed"]]
    if match and not dest.get("catalog"):
        dest.update({"environment": env, "catalog": match[0]["catalog"], "schema": match[0]["schema"]})
    objs = d.get("objects") or []
    if objs and src.get("connection"):
        try:
            found = sources.browse(src["connection"])
            if found.get("database") and not src.get("database"):
                src["database"] = found["database"]
            by_name = {}
            for t in found.get("tables") or []:
                by_name.setdefault(t["name"].lower(), t)
                by_name[f"{t['schema']}.{t['name']}".lower()] = t
            resolved, unknown = [], []
            for o in objs:
                key = f"{o.get('schema')}.{o['table']}".lower() if o.get("schema") else o["table"].lower()
                t = by_name.get(key) or by_name.get(o["table"].lower())
                if t:
                    cur = t["cursor_candidates"][0] if t["cursor_candidates"] else None
                    resolved.append({"schema": t["schema"], "table": t["name"], "primary_keys": t["primary_keys"] or o.get("primary_keys") or [],
                                     "cursor_column": o.get("cursor_column") or cur, "rows_est": t.get("rows_est")})
                else:
                    unknown.append(o["table"])
                    resolved.append({"schema": o.get("schema") or "", "table": o["table"], "primary_keys": o.get("primary_keys") or []})
            d["objects"] = resolved
            if unknown and found.get("browse") != "manual":
                notes.append(f"not found in {src['connection']}: {', '.join(unknown)}")
        except Exception as e:  # noqa: BLE001
            log.info("grounding browse failed: %s", e)
    if c and c["category"] == "saas" and objs:
        sugg = {s["name"].lower(): s for s in sources.saas_suggestions(c["id"])}
        d["objects"] = [{**o, "schema": o.get("schema") or (sugg.get(o["table"].lower()) or {}).get("schema", "objects"),
                         "primary_keys": o.get("primary_keys") or (sugg.get(o["table"].lower()) or {}).get("primary_keys", [])}
                        for o in d["objects"]]
    return d, notes


def missing(draft: dict[str, Any]) -> list[str]:
    src, own = draft.get("source") or {}, draft.get("ownership") or {}
    out = []
    if not src.get("connector"):
        out.append("source system")
    elif not src.get("connection") and (registry.get(src["connector"]) or {}).get("status") != "extension" \
            and (registry.get(src["connector"]) or {}).get("connection_type"):
        out.append("source connection")
    if not draft.get("objects"):
        out.append("tables or objects")
    if not (draft.get("schedule") or {}).get("mode"):
        out.append("refresh frequency")
    if "@" not in (own.get("owner") or ""):
        out.append("data owner")
    if not own.get("classification"):
        out.append("classification")
    if own.get("classification") in ("confidential", "restricted") and len((own.get("justification") or "").strip()) < 15:
        out.append("business justification")
    return out


SYSTEM = """You are the intake assistant of a governed Data Ingestion Service built on Databricks Lakeflow Connect.
You turn a user's plain-language data need into a DRAFT ingestion configuration. You never deploy anything: the
user confirms, then the request goes through validation and owner approval.

Return ONLY a JSON object: {"reply": "<one or two short sentences to the user>", "patch": <partial configuration>}.
The patch may contain any of:
  source: {connector: one of CONNECTOR_IDS, pattern: "cdc"|"query"|"saas"|"files"|"stream", connection?: string}
  objects: [{schema?: string, table: string}]
  schedule: {mode: "interval"|"continuous", interval_minutes?: int, sla_minutes?: int}
  destination: {environment: "dev"|"uat"|"prod"}
  schema: {scd_type: "SCD_TYPE_1"|"SCD_TYPE_2"}
  ownership: {owner?: email, classification?: "public"|"internal"|"confidential"|"restricted", domain?: string, cost_center?: string, justification?: string}
  title: short title
Only include what the user actually said or clearly implied. Keep earlier values unless the user changes them.
If something is missing, ask for at most two missing things, owner and classification first. "Foundation" is the
destination platform. SAP sources are onboarded by the platform team (connector "sap" = extension). Be concise."""


def _llm_patch(turns: list[dict[str, str]], draft: dict[str, Any], miss: list[str]) -> tuple[str, dict[str, Any]]:
    cat = [{"id": c["id"], "name": c["name"], "patterns": c["patterns"], "status": c["status"]} for c in registry.CONNECTORS]
    ctx = {"CONNECTOR_IDS": [c["id"] for c in registry.CONNECTORS], "connectors": cat,
           "destinations": [{"environment": d["environment"], "label": d["label"]} for d in rs.destinations()],
           "current_draft": draft, "still_missing": miss}
    msgs = [{"role": "system", "content": SYSTEM + "\n\nContext:\n" + json.dumps(ctx)}] + turns[-12:]
    out = llm.first_json(llm.chat(msgs))
    return str(out.get("reply") or ""), out.get("patch") or {}


def _session(sid: str | None, caller: Caller) -> dict[str, Any]:
    lb = lakebase.get()
    if sid:
        try:
            s = repo.chat_get(lb, sid) if lb.configured else None
        except Exception:  # noqa: BLE001
            s = None
        s = s or _mem.get(sid)
        if s and s.get("owner") == caller.email:
            return {"id": s["id"], "owner": s["owner"], "turns": s.get("turns") or [], "draft": s.get("draft") or {}}
    # unknown or someone else's session: always a NEW id, so one user can never overwrite another's conversation
    return {"id": uuid.uuid4().hex[:16], "owner": caller.email, "turns": [], "draft": {}}


def _save(s: dict[str, Any], request_id: str | None = None) -> None:
    lb = lakebase.get()
    try:
        if not lb.configured:
            raise Unavailable("no store")
        repo.chat_save(lb, s["id"], s["owner"], s["turns"], s["draft"], request_id)
    except Exception:  # noqa: BLE001 - keep the conversation going in memory
        with _lock:
            _mem[s["id"]] = s


def chat(sid: str | None, message: str, caller: Caller) -> dict[str, Any]:
    s = _session(sid, caller)
    msg = (message or "").strip()[:4000]
    s["turns"].append({"role": "user", "content": msg})
    draft = s["draft"] or {"ownership": {}, "destination": {"environment": "dev"}}
    draft = merge(draft, parse_rules(msg))
    mode = "rules"
    reply = ""
    try:
        reply, patch = _llm_patch(s["turns"], draft, missing(draft))
        draft = merge(draft, patch)
        mode = "live"
    except Exception as e:  # noqa: BLE001 - fall back to the rules parser
        log.info("assistant LLM unavailable, rules mode: %s", e)
    draft, notes = _ground(draft)
    if not draft.get("title") and draft.get("source", {}).get("connector"):
        c = registry.get(draft["source"]["connector"]) or {}
        tabs = ", ".join(o["table"] for o in (draft.get("objects") or [])[:3])
        draft["title"] = f"{c.get('name', '')} {tabs}".strip()[:80]
    miss = missing(draft)
    try:
        cfg = rules.normalize(draft)
        conn = rs.connector(cfg["source"].get("connector") or "")
        checks = [c.as_dict() for c in rules.evaluate(cfg, conn, rs.policies(), rs.destinations())]
    except Exception as e:  # noqa: BLE001
        checks = [{"key": "config.parse", "label": "Configuration", "status": "fail", "detail": str(e)}]
    if not reply:
        reply = ("I drafted a configuration. " + (f"Please confirm the {' and '.join(miss[:2])}." if miss
                 else "Validation passed. Review the configuration before submitting it for approval."))
    elif not miss and not rules.failing(checks) and "review" not in reply.lower():
        reply += " Review the configuration before submitting it for approval."
    if notes:
        reply += " (" + "; ".join(notes) + ")"
    s["draft"] = draft
    s["turns"].append({"role": "assistant", "content": reply})
    _save(s)
    return {"session_id": s["id"], "reply": reply, "draft": draft, "missing": miss,
            "ready": not miss and not rules.failing(checks), "checks": checks, "llm": mode}


def submit(sid: str, caller: Caller) -> dict[str, Any]:
    s = _session(sid, caller)
    if not s["draft"]:
        raise Conflict("Nothing to submit yet: describe the data you need first.")
    if missing(s["draft"]):
        raise Conflict("Still missing: " + ", ".join(missing(s["draft"])))
    d = rs.create(s["draft"], "chat", caller)
    rid = d["request"]["id"]
    _save(s, rid)
    try:
        return rs.submit(rid, caller)
    except Conflict as e:
        raise Conflict(f"Saved as draft {rid}, not submitted yet. {e}") from e
