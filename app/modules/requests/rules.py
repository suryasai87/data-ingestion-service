"""Pure governance rules: configuration checks, policies, approval routing and lifecycle permissions.

No I/O here: the service adds the live checks (connection usable, destination writable, Lakeflow dry run) and
feeds everything the rules need as arguments, so every rule is unit-tested against golden vectors.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from core.errors import BadRequest, Conflict, Forbidden

CLASSIFICATIONS = ("public", "internal", "confidential", "restricted")
STATUSES = ("draft", "pending_approval", "approved", "rejected", "deploying", "live", "failed", "cancelled")

DEFAULT_POLICIES: dict[str, dict[str, Any]] = {
    "min_interval_minutes": {"label": "Minimum refresh interval (minutes)", "value": 5,
                             "description": "No request may refresh more often than this, whatever the connector allows."},
    "allowed_environments": {"label": "Environments open to requests", "value": ["dev", "uat", "prod"],
                             "description": "Requests can only target these environments."},
    "independent_approval_classifications": {"label": "Independent approval for", "value": ["confidential", "restricted"],
                                             "description": "For these classifications the approver must be someone other than the requester (admins included)."},
    "justification_classifications": {"label": "Business justification required for", "value": ["confidential", "restricted"],
                                      "description": "Requests with these classifications need a justification of at least 15 characters."},
    "monthly_cost_cap_usd": {"label": "Forecast cost needing admin approval ($/month)", "value": 1500,
                             "description": "Above this predicted P50 monthly cost, only an administrator can approve."},
    "max_tables_per_request": {"label": "Tables per request", "value": 250,
                               "description": "Lakeflow Connect recommends at most 250 tables per pipeline; larger requests are split."},
    "auto_deploy_on_approval": {"label": "Deploy automatically on approval", "value": True,
                                "description": "Approved requests deploy straight away; off = an approver presses Deploy."},
    "share_gateways": {"label": "Share one ingestion gateway per source database", "value": True,
                       "description": "CDC requests on the same connection + database reuse the running gateway (one always-on cost per source)."},
    "gxp_prod_via_promotion_only": {"label": "GxP: production only by promotion", "value": True,
                                    "description": "A GxP request cannot target production directly: it is promoted Dev → UAT → Prod, each step e-signed, after a passing qualification run in the lower environment."},
    "destinations": {"label": "Destinations", "value": [],
                     "description": "Allowed targets per environment: [{environment, label, catalog, schema, requires_approval}]."},
}


@dataclass(frozen=True)
class Check:
    key: str
    label: str
    status: str  # pass | warn | fail
    detail: str = ""

    def as_dict(self) -> dict[str, str]:
        return {"key": self.key, "label": self.label, "status": self.status, "detail": self.detail}


def policy_value(policies: dict[str, Any], key: str) -> Any:
    v = policies.get(key)
    if isinstance(v, dict) and "value" in v:
        return v["value"]
    if v is None:
        return DEFAULT_POLICIES[key]["value"]
    return v


def normalize(cfg: dict[str, Any]) -> dict[str, Any]:
    """Fill defaults and coerce types; raise BadRequest on a malformed configuration (not on an incomplete one)."""
    if not isinstance(cfg, dict):
        raise BadRequest("config must be an object")
    out = {
        "title": str(cfg.get("title") or "").strip()[:120],
        "source": {"connector": "", "pattern": "cdc", "connection": None, "database": None, "via": "connection", **(cfg.get("source") or {})},
        "objects": [],
        "schema": {"scd_type": "SCD_TYPE_1", "evolution": "add_new_columns", **(cfg.get("schema") or {})},
        "destination": {"environment": "dev", "catalog": "", "schema": "", "table_prefix": "", **(cfg.get("destination") or {})},
        "schedule": {"mode": "interval", "interval_minutes": 60, "sla_minutes": 120, **(cfg.get("schedule") or {})},
        "ownership": {"owner": "", "classification": "internal", "domain": "", "cost_center": "", "justification": "",
                      "gxp": False, "readers": [], "business_app": None, **(cfg.get("ownership") or {})},
        "operations": {"retries": 3, "recovery": "auto_retry_then_ticket", "reconciliation": True, "alert_emails": [],
                       **(cfg.get("operations") or {})},
    }
    if isinstance(cfg.get("_promotion"), dict):
        out["_promotion"] = cfg["_promotion"]  # provenance of a promoted request (source request, version, hash)
    objs = cfg.get("objects") or []
    if not isinstance(objs, list):
        raise BadRequest("objects must be a list")
    for o in objs:
        if not isinstance(o, dict) or not o.get("table"):
            raise BadRequest("every object needs at least a table name")
        opts = o.get("options") or {}
        if not isinstance(opts, dict):
            raise BadRequest("object options must be an object")
        out["objects"].append({
            "options": {str(k): v for k, v in opts.items() if isinstance(v, (str, int, float, bool, dict, list)) and str(k)[:40]},
            "schema": str(o.get("schema") or ""), "table": str(o["table"]),
            "primary_keys": [str(k) for k in (o.get("primary_keys") or []) if str(k).strip()],
            "cursor_column": (str(o["cursor_column"]) if o.get("cursor_column") else None),
            "destination_table": (str(o["destination_table"]) if o.get("destination_table") else None),
            "rows_est": (int(o["rows_est"]) if isinstance(o.get("rows_est"), (int, float)) else None),
        })
    s = out["schedule"]
    try:
        s["interval_minutes"] = int(s.get("interval_minutes") or 60)
        s["sla_minutes"] = int(s.get("sla_minutes") or max(30, s["interval_minutes"] * 2))
    except (TypeError, ValueError) as e:
        raise BadRequest("schedule minutes must be numbers") from e
    if s.get("mode") not in ("interval", "continuous"):
        raise BadRequest("schedule.mode must be interval or continuous")
    try:
        out["operations"]["retries"] = max(0, min(5, int(out["operations"].get("retries", 3))))
    except (TypeError, ValueError) as e:
        raise BadRequest("operations.retries must be a number") from e
    if out["ownership"]["classification"] not in CLASSIFICATIONS:
        raise BadRequest(f"classification must be one of {', '.join(CLASSIFICATIONS)}")
    if out["schema"]["scd_type"] not in ("SCD_TYPE_1", "SCD_TYPE_2"):
        raise BadRequest("scd_type must be SCD_TYPE_1 or SCD_TYPE_2")
    out["ownership"]["owner"] = str(out["ownership"]["owner"]).strip().lower()
    out["ownership"]["gxp"] = bool(out["ownership"].get("gxp"))
    rd = out["ownership"].get("readers") or []
    if not isinstance(rd, list):
        raise BadRequest("ownership.readers must be a list of emails or group:<name>")
    out["ownership"]["readers"] = [str(x).strip().lower() for x in rd if str(x).strip()]
    return out


def evaluate(cfg: dict[str, Any], connector: dict[str, Any] | None, policies: dict[str, Any],
             destinations: list[dict[str, Any]], forecast_month_usd: float | None = None) -> list[Check]:
    checks: list[Check] = []
    src, own, sch, dest = cfg["source"], cfg["ownership"], cfg["schedule"], cfg["destination"]
    objs = cfg["objects"]

    missing = [n for n, ok in (("a title", bool(cfg["title"])), ("a connector", bool(src.get("connector"))),
                               ("a connection", bool(src.get("connection")) or (connector or {}).get("status") == "extension"
                                or (connector is not None and not connector.get("connection_type"))),
                               ("at least one table", bool(objs)), ("a destination", bool(dest.get("catalog") and dest.get("schema"))),
                               ("an owner", "@" in own.get("owner", ""))) if not ok]
    checks.append(Check("config.complete", "Configuration complete",
                        "fail" if missing else "pass", ("Still needs " + ", ".join(missing) + ".") if missing else "All six areas are filled in."))

    if connector is None:
        checks.append(Check("connector.available", "Connector supported", "fail", f"Unknown connector '{src.get('connector')}'."))
    elif connector.get("status") == "extension":
        checks.append(Check("connector.available", "Connector supported", "fail",
                            f"{connector['name']} needs a platform extension first: the platform team onboards it as a reusable pattern."))
    elif not connector.get("enabled", True):
        checks.append(Check("connector.available", "Connector supported", "fail", f"{connector['name']} is switched off by an administrator."))
    else:
        checks.append(Check("connector.available", "Connector supported", "warn" if connector["status"] == "preview" else "pass",
                            f"{connector['name']} is in preview in Lakeflow Connect." if connector["status"] == "preview" else f"{connector['name']} is supported."))
        if src.get("via") == "uc_catalog" and src.get("pattern") != "query":
            checks.append(Check("pattern.supported", "Ingestion pattern", "fail",
                                "This source is a Unity Catalog database catalog: Lakeflow Connect reads it query-based. "
                                "Log-based CDC needs a database connection (ask the platform team)."))
        elif src.get("pattern") not in connector.get("patterns", []):
            checks.append(Check("pattern.supported", "Ingestion pattern", "fail",
                                f"{connector['name']} supports {', '.join(connector.get('patterns', []))}, not {src.get('pattern')}."))

    # schema checks
    pattern = src.get("pattern")
    if objs:
        if pattern in ("cdc", "query", "saas", "federation"):
            no_pk = [f"{o['schema']}.{o['table']}" for o in objs if not o["primary_keys"]]
            if no_pk and pattern == "cdc":
                checks.append(Check("schema.keys", "Schema check: primary keys", "warn",
                                    f"{len(no_pk)} table(s) without a primary key ({', '.join(no_pk[:3])}): CDC needs REPLICA IDENTITY FULL on the source."))
            elif no_pk and pattern in ("query", "federation") and cfg["schema"]["scd_type"] == "SCD_TYPE_1":
                checks.append(Check("schema.keys", "Schema check: primary keys", "fail",
                                    f"Query-based SCD 1 merges on a key: add primary keys for {', '.join(no_pk[:3])}."))
            else:
                checks.append(Check("schema.keys", "Schema check: primary keys", "pass", "Every table has a key to merge on."))
        if pattern in ("files", "api", "stream"):
            need = {"files": "path", "api": "path", "stream": "topic"}[pattern]
            miss = [o["table"] for o in objs if not (o.get("options") or {}).get(need)]
            checks.append(Check(f"schema.{need}", f"Source {need} per object", "fail" if miss else "pass",
                                f"Set the {need} for: {', '.join(miss[:4])}." if miss else f"Every object has a {need}."))
        if pattern == "federation" and not src.get("foreign_catalog"):
            checks.append(Check("source.foreign_catalog", "Foreign catalog", "fail",
                                "This connection has no Lakehouse Federation foreign catalog yet: an admin creates one (CREATE FOREIGN CATALOG ... USING CONNECTION)."))
        if pattern in ("query", "federation"):
            no_cursor = [o["table"] for o in objs if not o["cursor_column"]]
            checks.append(Check("schema.cursor", "Schema check: cursor column", "fail" if no_cursor else "pass",
                                f"Query-based ingestion needs one cursor column (e.g. updated_at) for: {', '.join(no_cursor[:4])}." if no_cursor
                                else "Every table has a cursor column for incremental reads."))
        if cfg["schema"]["scd_type"] == "SCD_TYPE_2" and connector and not connector.get("capabilities", {}).get("scd2", True):
            checks.append(Check("schema.scd2", "History tracking (SCD 2)", "fail", f"{connector['name']} does not support SCD type 2."))
        dests = [o.get("destination_table") or f"{dest.get('table_prefix') or ''}{o['table']}".lower() for o in objs]
        dupes = sorted({d for d in dests if dests.count(d) > 1})
        if dupes:
            checks.append(Check("schema.collisions", "Destination table names", "fail", f"Two tables would land as: {', '.join(dupes[:4])}."))

    # policies
    envs = policy_value(policies, "allowed_environments")
    allowed = [d for d in destinations if d.get("environment") == dest.get("environment") and d.get("allowed", True)]
    if dest.get("environment") not in envs:
        checks.append(Check("policy.destination", "Policy: destination", "fail", f"Environment '{dest.get('environment')}' is closed to requests."))
    elif dest.get("catalog") and not any(d["catalog"] == dest["catalog"] and d["schema"] == dest["schema"] for d in allowed):
        checks.append(Check("policy.destination", "Policy: destination", "fail",
                            f"{dest['catalog']}.{dest['schema']} is not an approved {dest.get('environment')} destination."))
    else:
        checks.append(Check("policy.destination", "Policy: destination", "pass", "Approved destination for this environment."))

    floor = max(int(policy_value(policies, "min_interval_minutes")), int((connector or {}).get("capabilities", {}).get("min_interval_minutes", 1)))
    if sch["mode"] == "interval" and sch["interval_minutes"] < floor:
        checks.append(Check("policy.schedule", "Policy: refresh frequency", "fail", f"Every {sch['interval_minutes']} min is below the {floor}-min floor."))
    else:
        checks.append(Check("policy.schedule", "Policy: refresh frequency", "pass",
                            "Continuous ingestion." if sch["mode"] == "continuous" else f"Every {sch['interval_minutes']} min, SLA {sch['sla_minutes']} min."))

    need_just = own["classification"] in policy_value(policies, "justification_classifications")
    if need_just and len(own.get("justification", "").strip()) < 15:
        checks.append(Check("policy.classification", "Policy: classification", "fail",
                            f"{own['classification'].title()} data needs a business justification (15+ characters)."))
    else:
        checks.append(Check("policy.classification", "Policy: classification", "pass", f"Classified {own['classification']}."))

    if own.get("gxp"):
        if dest.get("environment") == "prod" and policy_value(policies, "gxp_prod_via_promotion_only") and not cfg.get("_promotion"):
            checks.append(Check("gxp.promotion", "GxP: production by promotion only", "fail",
                                "GxP data reaches production only by promoting a qualified UAT request (Dev → UAT → Prod)."))
        else:
            checks.append(Check("gxp.controls", "GxP controls", "pass",
                                "E-signed independent approval, qualification run and evidence pack are required."))
    cap = int(policy_value(policies, "max_tables_per_request"))
    if len(objs) > cap:
        checks.append(Check("policy.tables", "Policy: tables per request", "fail", f"{len(objs)} tables; split into requests of at most {cap}."))

    if forecast_month_usd is not None:
        cost_cap = float(policy_value(policies, "monthly_cost_cap_usd"))
        if forecast_month_usd > cost_cap:
            checks.append(Check("policy.cost", "Policy: forecast cost", "warn",
                                f"Forecast ${forecast_month_usd:,.0f}/month is above ${cost_cap:,.0f}: an administrator must approve."))
        else:
            checks.append(Check("policy.cost", "Policy: forecast cost", "pass", f"Forecast ${forecast_month_usd:,.0f}/month is within budget."))
    return checks


def failing(checks: list[dict[str, Any]] | list[Check]) -> list[str]:
    out = []
    for c in checks:
        status = c.status if isinstance(c, Check) else c.get("status")
        if status == "fail":
            out.append(c.label if isinstance(c, Check) else c.get("label", ""))
    return out


# --- lifecycle --------------------------------------------------------------------------------------------------
EDITABLE = ("draft", "rejected")
CANCELLABLE = ("draft", "pending_approval", "approved", "rejected", "failed")


def can_approve(actor: str, request: dict[str, Any], *, is_admin: bool, approver_scopes: list[str],
                policies: dict[str, Any]) -> tuple[bool, str]:
    """Who may approve: a data owner for the request's domain (or domain:*) or an admin, with two extra rules:
    independent approval for sensitive classifications, and admin-only above the cost cap."""
    domain = (request.get("domain") or "").lower()
    scoped = any(s in ("domain:*", f"domain:{domain}") for s in approver_scopes)
    if not (is_admin or scoped):
        return False, "Only a data owner for this domain or an administrator can approve."
    if request.get("classification") in policy_value(policies, "independent_approval_classifications") and actor == request.get("requester"):
        return False, f"{str(request.get('classification')).title()} data needs approval by someone other than the requester."
    if request.get("gxp") and actor == request.get("requester"):
        return False, "GxP requests need an independent, e-signed approval (not the requester)."
    cost = request.get("forecast_month_usd")
    if cost is not None and float(cost) > float(policy_value(policies, "monthly_cost_cap_usd")) and not is_admin:
        return False, "The forecast is above the cost cap: an administrator must approve."
    return True, ""


def require_transition(status: str, action: str) -> None:
    allowed = {
        "edit": EDITABLE, "submit": EDITABLE, "approve": ("pending_approval",), "reject": ("pending_approval",),
        "deploy": ("approved", "failed"), "cancel": CANCELLABLE, "promote": ("live",),
    }[action]
    if status not in allowed:
        raise Conflict(f"Cannot {action} a request that is {status.replace('_', ' ')}.")


def require_reason(reason: str | None, what: str) -> str:
    r = (reason or "").strip()
    if len(r) < 5:
        raise BadRequest(f"A reason (5+ characters) is required to {what}.")
    return r[:1000]


def require_actor(ok: bool, why: str) -> None:
    if not ok:
        raise Forbidden(why)
