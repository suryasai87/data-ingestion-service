"""Per-user usage and cost analytics.

Capture: every /api call is attributed to the signed-in user (the identity Databricks Apps forwards; with user
authorization the user's own token is forwarded too, so queries the app runs ON BEHALF OF the user are executed as
them and land in system.query.history under their name). Events are queued and written to Lakebase in batches
(usage_event), and exported as OpenTelemetry spans / metrics (core/otel.py).
Analytics: sessions, calls, governed actions, requests, forecast vs actual cost of the pipelines a user owns, and the
warehouse usage of their on-behalf-of queries (rolled up by the guardian from system.query.history).
"""
from __future__ import annotations

import logging
import queue
import re
import threading
import time
from typing import Any

from psycopg.types.json import Jsonb

from core import config, lakebase, otel, repo

log = logging.getLogger("dis.usage")
_q: "queue.Queue[tuple]" = queue.Queue(maxsize=20000)
_last_seen: dict[str, float] = {}
SESSION_GAP_S = 1800.0
RID = re.compile(r"/(IR-[0-9A-Z-]+)")
_started = False
ACTIONS = {("POST", "/api/requests"): "request.create", ("POST", "/api/requests/{id}/submit"): "request.submit",
           ("POST", "/api/requests/{id}/approve"): "request.approve", ("POST", "/api/requests/{id}/reject"): "request.reject",
           ("POST", "/api/requests/{id}/deploy"): "request.deploy", ("POST", "/api/requests/{id}/promote"): "request.promote",
           ("POST", "/api/assistant/chat"): "assistant.chat", ("POST", "/api/forecast"): "forecast"}


def route_of(path: str) -> str:
    return RID.sub("/{id}", path)


def record(email: str, method: str, path: str, status: int, ms: float, obo: bool, kind: str = "api", detail: dict | None = None) -> None:
    if not config.USAGE_CAPTURE:
        return
    route = route_of(path)
    m = RID.search(path)
    now = time.time()
    events = []
    if now - _last_seen.get(email, 0) > SESSION_GAP_S:
        events.append((email, "login", None, None, None, None, None, obo, {}))
        otel.count("logins", 1, {"enduser.id": email})
    _last_seen[email] = now
    events.append((email, kind, method, route, status, ms, m.group(1) if m else None, obo, detail or {}))
    action = ACTIONS.get((method, route))
    if action and status < 400:
        otel.count("actions", 1, {"enduser.id": email, "action": action})
    otel.count("calls", 1, {"enduser.id": email, "http.route": route, "http.status_code": status})
    otel.count("duration", ms, {"http.route": route})
    tid = otel.trace_id()
    for e in events:
        try:
            _q.put_nowait((*e, tid))
        except queue.Full:
            return
    _ensure_flusher()


def _ensure_flusher() -> None:
    global _started
    if _started or config.OFFLINE and not lakebase.get().configured:
        return
    _started = True
    threading.Thread(target=_flush_loop, daemon=True, name="usage-flush").start()


def flush() -> int:
    batch = []
    while not _q.empty() and len(batch) < 1000:
        batch.append(_q.get_nowait())
    if not batch:
        return 0
    lb = lakebase.get()
    if not lb.configured:
        return 0
    try:
        with lb.connection() as c, c.cursor() as cur:
            cur.executemany(f"INSERT INTO {repo.S()}.usage_event (user_email, kind, method, route, status, duration_ms, request_id, obo, detail, trace_id) "
                            f"VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                            [(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], Jsonb(e[8]), e[9]) for e in batch])
        return len(batch)
    except Exception as ex:  # noqa: BLE001 - analytics must not break the app; drop the batch
        log.info("usage flush skipped: %s", ex)
        return 0


def _flush_loop() -> None:
    while True:
        time.sleep(3)
        flush()


import os as _os

OTEL_LOGS = _os.environ.get("OTEL_LOGS_TABLE", "")
OTEL_SPANS = _os.environ.get("OTEL_TRACES_TABLE", "")
_otel_err: dict[str, str | None] = {"last": None}


def _quoted(name: str) -> str:
    return ".".join(f"`{p}`" for p in name.split("."))


def otel_by_user(days: int) -> dict[str, dict[str, int]]:
    """From the Apps telemetry tables in Unity Catalog: platform login events (otel_logs, event.name = app.auth) and
    the app's spans (enduser.id). Empty when telemetry is off or the tables do not exist yet."""
    from core import warehouse

    out: dict[str, dict[str, int]] = {}
    if not (OTEL_LOGS and OTEL_SPANS) or config.OFFLINE:
        return out
    try:
        for r in warehouse.query(
                f"SELECT coalesce(attributes:['user.email']::string, attributes:['user_email']::string, attributes:['enduser.id']::string, "
                f"attributes:['user.id']::string, attributes:['user']::string) AS u, count(*) AS n FROM {_quoted(OTEL_LOGS)} "
                f"WHERE attributes:['event.name']::string = 'app.auth' AND time >= current_timestamp() - INTERVAL {int(days)} DAYS GROUP BY 1",
                timeout=60):
            if r["u"]:
                out.setdefault(r["u"].lower(), {})["logins"] = int(r["n"])
        for r in warehouse.query(
                f"SELECT attributes:['enduser.id']::string AS u, count(*) AS n FROM {_quoted(OTEL_SPANS)} "
                f"WHERE time >= current_timestamp() - INTERVAL {int(days)} DAYS GROUP BY 1", timeout=60):
            if r["u"]:
                out.setdefault(r["u"].lower(), {})["spans"] = int(r["n"])
        _otel_err["last"] = None
    except Exception as e:  # noqa: BLE001
        _otel_err["last"] = f"{type(e).__name__}: {str(e)[:160]}"
    return out


def analytics(days: int = 30) -> dict[str, Any]:
    flush()
    lb = lakebase.get()
    s = repo.S()
    users = lb.query(f"""
        SELECT user_email,
               count(*) FILTER (WHERE kind = 'login') AS sessions,
               count(*) FILTER (WHERE kind = 'api') AS api_calls,
               count(*) FILTER (WHERE kind = 'obo_query') AS obo_queries,
               count(*) FILTER (WHERE obo) AS obo_calls,
               round(avg(duration_ms) FILTER (WHERE kind = 'api')::numeric, 1) AS avg_ms,
               max(at) AS last_seen
        FROM {s}.usage_event WHERE at > now() - make_interval(days => %s) GROUP BY user_email ORDER BY api_calls DESC LIMIT 500""", (days,))
    acts = lb.query(f"""SELECT actor, action, count(*) AS n FROM {s}.audit WHERE at > now() - make_interval(days => %s)
                        AND action IN ('request.create','request.submit','request.approve','request.reject','request.deploy','request.promote','esign.sign','gxp.oq')
                        GROUP BY 1, 2""", (days,))
    owned = lb.query(f"""SELECT coalesce(owner, requester) AS email, count(*) FILTER (WHERE status = 'live') AS live,
                         count(*) AS requests,
                         round(sum(coalesce((forecast->'cost'->'month'->>'p50')::numeric, 0)) FILTER (WHERE status = 'live'), 2) AS forecast_month_usd
                         FROM {s}.request GROUP BY 1""")
    cost = lb.query(f"""SELECT coalesce(r.owner, r.requester) AS email, round(sum(coalesce(p.cost_mtd_usd, 0))::numeric, 2) AS cost_mtd_usd
                        FROM {s}.request r JOIN {s}.pipeline_snapshot p ON p.request_id = r.id GROUP BY 1""")
    try:
        roll = lb.query(f"""SELECT user_email, sum(queries) AS wh_queries, sum(duration_ms) AS wh_duration_ms, sum(read_bytes) AS wh_read_bytes
                            FROM {s}.usage_rollup WHERE day > current_date - %s GROUP BY 1""", (days,))
    except Exception:  # noqa: BLE001 - the guardian has not rolled up yet
        roll = []
    by: dict[str, dict[str, Any]] = {}
    for u in users:
        by[u["user_email"]] = {**repo.row(u), "actions": {}}
    for a in acts:
        by.setdefault(a["actor"], {"user_email": a["actor"], "actions": {}})["actions"][a["action"]] = a["n"]
    for o in owned:
        if o["email"]:
            by.setdefault(o["email"], {"user_email": o["email"], "actions": {}}).update({"live": o["live"], "requests": o["requests"],
                                                                                         "forecast_month_usd": float(o["forecast_month_usd"] or 0)})
    for c in cost:
        if c["email"]:
            by.setdefault(c["email"], {"user_email": c["email"], "actions": {}})["cost_mtd_usd"] = float(c["cost_mtd_usd"] or 0)
    for x in roll:
        by.setdefault(x["user_email"], {"user_email": x["user_email"], "actions": {}}).update(
            {"wh_queries": int(x["wh_queries"] or 0), "wh_duration_ms": float(x["wh_duration_ms"] or 0), "wh_read_bytes": int(x["wh_read_bytes"] or 0)})
    daily = lb.query(f"""SELECT date_trunc('day', at)::date AS day, count(*) FILTER (WHERE kind = 'api') AS calls,
                         count(DISTINCT user_email) AS users FROM {s}.usage_event WHERE at > now() - make_interval(days => %s) GROUP BY 1 ORDER BY 1""", (days,))
    otel_rows = otel_by_user(days)
    for u, x in otel_rows.items():
        by.setdefault(u, {"user_email": u, "actions": {}}).update({"otel_logins": x.get("logins", 0), "otel_spans": x.get("spans", 0)})
    items = sorted(by.values(), key=lambda x: -(x.get("api_calls") or 0))
    return {"days": days, "users": items, "daily": [repo.row(d) for d in daily],
            "otel": {"enabled": otel.enabled, "tables": {"logs": OTEL_LOGS or None, "spans": OTEL_SPANS or None}, "users": len(otel_rows),
                     "read_error": _otel_err.get("last")},
            "totals": {"users": len(items), "api_calls": sum(x.get("api_calls") or 0 for x in items),
                       "sessions": sum(x.get("sessions") or 0 for x in items)}}
