"""SQL data access for the service's Lakebase store (one implementation; tests run it against a real Postgres).

Every function takes the Lakebase handle so tests can point it at a throwaway database. JSON columns go through
psycopg's Jsonb adapter; timestamps come back as aware datetimes and are serialised by the routers.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from psycopg.types.json import Jsonb

from core import config
from core.lakebase import Lakebase


def S() -> str:
    return config.LAKEBASE_SCHEMA


def iso(v: Any) -> Any:
    return v.isoformat() if isinstance(v, datetime) else v


def row(r: dict[str, Any] | None) -> dict[str, Any] | None:
    return None if r is None else {k: iso(v) for k, v in r.items()}


# --- requests ---------------------------------------------------------------------------------------------------
REQUEST_COLS = ("title", "status", "channel", "requester", "owner", "classification", "environment", "connector",
                "pattern", "n_objects", "version", "pipeline_id", "gateway_id", "job_id", "forecast", "sla_minutes", "gxp", "parent_id")


def create_request(lb: Lakebase, fields: dict[str, Any], config_doc: dict[str, Any], config_hash: str, actor: str) -> str:
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"SELECT nextval('{S()}.request_seq') AS n")
        rid = f"IR-{cur.fetchone()['n']}"
        cols = ["id", *[k for k in REQUEST_COLS if k in fields]]
        vals = [rid, *[Jsonb(fields[k]) if k == "forecast" and fields[k] is not None else fields[k] for k in cols[1:]]]
        cur.execute(f"INSERT INTO {S()}.request ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})", vals)
        cur.execute(f"INSERT INTO {S()}.request_version (request_id, version, config, config_hash, created_by) VALUES (%s, 1, %s, %s, %s)",
                    (rid, Jsonb(config_doc), config_hash, actor))
        cur.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s, 'request.create', 'request', %s, %s)",
                    (actor, rid, Jsonb({"channel": fields.get("channel"), "title": fields.get("title")})))
    return rid


def update_request(lb: Lakebase, rid: str, fields: dict[str, Any], *, expect_status: tuple[str, ...] | None = None,
                   audit: tuple[str, str, dict[str, Any]] | None = None) -> bool:
    """Update columns (optionally only if the status is still one of expect_status); returns False on a lost race."""
    sets = [f"{k} = %s" for k in fields] + ["updated_at = now()"]
    vals = [Jsonb(v) if k == "forecast" and v is not None else v for k, v in fields.items()]
    where = "id = %s"
    params: list[Any] = [*vals, rid]
    if expect_status:
        where += " AND status = ANY(%s)"
        params.append(list(expect_status))
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"UPDATE {S()}.request SET {', '.join(sets)} WHERE {where}", params)
        ok = cur.rowcount == 1
        if ok and audit:
            actor, action, detail = audit
            cur.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s, %s, 'request', %s, %s)",
                        (actor, action, rid, Jsonb(detail)))
    return ok


def add_version(lb: Lakebase, rid: str, version: int, config_doc: dict[str, Any], config_hash: str, actor: str,
                fields: dict[str, Any]) -> bool:
    with lb.connection() as c, c.cursor() as cur:
        sets = ", ".join([f"{k} = %s" for k in fields] + ["version = %s", "updated_at = now()"])
        vals = [Jsonb(v) if k == "forecast" and v is not None else v for k, v in fields.items()]
        cur.execute(f"UPDATE {S()}.request SET {sets} WHERE id = %s AND version = %s AND status IN ('draft','rejected')",
                    [*vals, version, rid, version - 1])
        if cur.rowcount != 1:
            return False
        cur.execute(f"INSERT INTO {S()}.request_version (request_id, version, config, config_hash, created_by) VALUES (%s, %s, %s, %s, %s)",
                    (rid, version, Jsonb(config_doc), config_hash, actor))
        cur.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s, 'request.edit', 'request', %s, %s)",
                    (actor, rid, Jsonb({"version": version, "hash": config_hash[:12]})))
    return True


def get_request(lb: Lakebase, rid: str) -> dict[str, Any] | None:
    r = lb.query(f"SELECT * FROM {S()}.request WHERE id = %s", (rid,))
    return row(r[0]) if r else None


def list_requests(lb: Lakebase, *, requester: str | None = None, statuses: list[str] | None = None, limit: int = 500) -> list[dict[str, Any]]:
    where, params = [], []
    if requester:
        where.append("requester = %s")
        params.append(requester)
    if statuses:
        where.append("status = ANY(%s)")
        params.append(statuses)
    sql = f"SELECT * FROM {S()}.request {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY updated_at DESC LIMIT %s"
    return [row(r) for r in lb.query(sql, (*params, limit))]  # type: ignore[misc]


def get_version(lb: Lakebase, rid: str, version: int | None = None) -> dict[str, Any] | None:
    if version is None:
        r = lb.query(f"SELECT * FROM {S()}.request_version WHERE request_id = %s ORDER BY version DESC LIMIT 1", (rid,))
    else:
        r = lb.query(f"SELECT * FROM {S()}.request_version WHERE request_id = %s AND version = %s", (rid, version))
    return row(r[0]) if r else None


def list_versions(lb: Lakebase, rid: str) -> list[dict[str, Any]]:
    return [row(r) for r in lb.query(f"SELECT version, created_at, created_by, config_hash AS hash FROM {S()}.request_version "
                                     f"WHERE request_id = %s ORDER BY version DESC", (rid,))]  # type: ignore[misc]


def save_checks(lb: Lakebase, rid: str, version: int, checks: list[dict[str, Any]]) -> None:
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"DELETE FROM {S()}.check_result WHERE request_id = %s AND version = %s", (rid, version))
        for i, ch in enumerate(checks):
            cur.execute(f"INSERT INTO {S()}.check_result (request_id, version, key, label, status, detail, ord) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (rid, version, ch["key"], ch["label"], ch["status"], ch.get("detail", ""), i))


def get_checks(lb: Lakebase, rid: str, version: int) -> list[dict[str, Any]]:
    return lb.query(f"SELECT key, label, status, detail FROM {S()}.check_result WHERE request_id = %s AND version = %s ORDER BY ord",
                    (rid, version))


def add_approval(lb: Lakebase, rid: str, version: int, decision: str, actor: str, reason: str) -> None:
    lb.execute(f"INSERT INTO {S()}.approval (request_id, version, decision, actor, reason) VALUES (%s,%s,%s,%s,%s)",
               (rid, version, decision, actor, reason))


def upsert_step(lb: Lakebase, rid: str, version: int, step: str, ord_: int, status: str, detail: str = "") -> None:
    lb.execute(f"INSERT INTO {S()}.deployment_step (request_id, version, step, ord, status, detail, at) VALUES (%s,%s,%s,%s,%s,%s, now()) "
               f"ON CONFLICT (request_id, version, step) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, at = now()",
               (rid, version, step, ord_, status, detail[:2000]))


def list_steps(lb: Lakebase, rid: str, version: int) -> list[dict[str, Any]]:
    return [row(r) for r in lb.query(f"SELECT step, status, detail, at FROM {S()}.deployment_step WHERE request_id = %s AND version = %s "
                                     f"ORDER BY ord", (rid, version))]  # type: ignore[misc]


def audit(lb: Lakebase, actor: str, action: str, entity: str, entity_id: str, detail: dict[str, Any] | None = None) -> None:
    lb.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s,%s,%s,%s,%s)",
               (actor, action, entity, entity_id, Jsonb(detail or {})))


def list_audit(lb: Lakebase, entity: str | None = None, entity_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    if entity_id:
        rows = lb.query(f"SELECT at, actor, action, entity, entity_id, detail FROM {S()}.audit WHERE entity = %s AND entity_id = %s "
                        f"ORDER BY at, id LIMIT %s", (entity, entity_id, limit))
    else:
        rows = lb.query(f"SELECT at, actor, action, entity, entity_id, detail FROM {S()}.audit ORDER BY at DESC, id DESC LIMIT %s", (limit,))
    return [row(r) for r in rows]  # type: ignore[misc]


# --- admins / approvers / policies / connectors ----------------------------------------------------------------
def granted_admins(lb: Lakebase) -> list[dict[str, Any]]:
    return [row(r) for r in lb.query(f"SELECT email, granted_by, granted_at, reason FROM {S()}.app_admin WHERE revoked_at IS NULL ORDER BY granted_at")]  # type: ignore[misc]


def grant_admin(lb: Lakebase, email: str, actor: str, reason: str) -> None:
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"INSERT INTO {S()}.app_admin (email, granted_by, reason) VALUES (%s,%s,%s) ON CONFLICT (email) DO UPDATE "
                    f"SET granted_by = EXCLUDED.granted_by, granted_at = now(), reason = EXCLUDED.reason, revoked_by = NULL, revoked_at = NULL, revoke_reason = NULL",
                    (email, actor, reason))
        cur.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s,'admin.grant','admin',%s,%s)",
                    (actor, email, Jsonb({"reason": reason})))


def revoke_admin(lb: Lakebase, email: str, actor: str, reason: str) -> bool:
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"UPDATE {S()}.app_admin SET revoked_by = %s, revoked_at = now(), revoke_reason = %s WHERE email = %s AND revoked_at IS NULL",
                    (actor, reason, email))
        ok = cur.rowcount == 1
        if ok:
            cur.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s,'admin.revoke','admin',%s,%s)",
                        (actor, email, Jsonb({"reason": reason})))
    return ok


def approvers(lb: Lakebase) -> list[dict[str, Any]]:
    return [row(r) for r in lb.query(f"SELECT email, scope, granted_by, granted_at, reason FROM {S()}.approver WHERE revoked_at IS NULL ORDER BY email, scope")]  # type: ignore[misc]


def grant_approver(lb: Lakebase, email: str, scope: str, actor: str, reason: str) -> None:
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"INSERT INTO {S()}.approver (email, scope, granted_by, reason) VALUES (%s,%s,%s,%s) ON CONFLICT (email, scope) DO UPDATE "
                    f"SET granted_by = EXCLUDED.granted_by, granted_at = now(), reason = EXCLUDED.reason, revoked_by = NULL, revoked_at = NULL",
                    (email, scope, actor, reason))
        cur.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s,'approver.grant','approver',%s,%s)",
                    (actor, email, Jsonb({"scope": scope, "reason": reason})))


def revoke_approver(lb: Lakebase, email: str, scope: str, actor: str, reason: str) -> bool:
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"UPDATE {S()}.approver SET revoked_by = %s, revoked_at = now() WHERE email = %s AND scope = %s AND revoked_at IS NULL",
                    (actor, email, scope))
        ok = cur.rowcount == 1
        if ok:
            cur.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s,'approver.revoke','approver',%s,%s)",
                        (actor, email, Jsonb({"scope": scope, "reason": reason})))
    return ok


def policies(lb: Lakebase) -> list[dict[str, Any]]:
    return [row(r) for r in lb.query(f"SELECT key, value, updated_by, updated_at FROM {S()}.policy")]  # type: ignore[misc]


def set_policy(lb: Lakebase, key: str, value: Any, actor: str) -> None:
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"SELECT value FROM {S()}.policy WHERE key = %s", (key,))
        old = cur.fetchone()
        cur.execute(f"INSERT INTO {S()}.policy (key, value, updated_by) VALUES (%s,%s,%s) ON CONFLICT (key) DO UPDATE "
                    f"SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()", (key, Jsonb(value), actor))
        cur.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s,'policy.set','policy',%s,%s)",
                    (actor, key, Jsonb({"from": old["value"] if old else None, "to": value})))


def seed_policies(lb: Lakebase, defaults: dict[str, Any], actor: str = "setup") -> int:
    n = 0
    with lb.connection() as c, c.cursor() as cur:
        for k, v in defaults.items():
            cur.execute(f"INSERT INTO {S()}.policy (key, value, updated_by) VALUES (%s,%s,%s) ON CONFLICT (key) DO NOTHING", (k, Jsonb(v), actor))
            n += cur.rowcount
    return n


def connector_overrides(lb: Lakebase) -> dict[str, bool]:
    return {r["id"]: r["enabled"] for r in lb.query(f"SELECT id, enabled FROM {S()}.connector_override")}


def set_connector(lb: Lakebase, cid: str, enabled: bool, actor: str) -> None:
    with lb.connection() as c, c.cursor() as cur:
        cur.execute(f"INSERT INTO {S()}.connector_override (id, enabled, updated_by) VALUES (%s,%s,%s) ON CONFLICT (id) DO UPDATE "
                    f"SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()", (cid, enabled, actor))
        cur.execute(f"INSERT INTO {S()}.audit (actor, action, entity, entity_id, detail) VALUES (%s,'connector.set','connector',%s,%s)",
                    (actor, cid, Jsonb({"enabled": enabled})))


# --- forecast model / pipelines / incidents / gateways / chat ------------------------------------------------------
def active_model(lb: Lakebase) -> dict[str, Any] | None:
    r = lb.query(f"SELECT version, trained_at, params, metrics FROM {S()}.forecast_model WHERE active ORDER BY trained_at DESC LIMIT 1")
    return row(r[0]) if r else None


def snapshots(lb: Lakebase) -> dict[str, dict[str, Any]]:
    return {r["request_id"]: row(r) for r in lb.query(f"SELECT * FROM {S()}.pipeline_snapshot")}  # type: ignore[misc]


def upsert_snapshot(lb: Lakebase, rid: str, snap: dict[str, Any]) -> None:
    cols = ["request_id", "pipeline_id", "state", "health", "last_update_at", "last_update_state", "freshness_min",
            "rows_last_update", "cost_mtd_usd", "recon", "incidents_open"]
    vals = [rid, *[Jsonb(snap.get(k)) if k == "recon" and snap.get(k) is not None else snap.get(k) for k in cols[1:]]]
    upd = ", ".join(f"{k} = COALESCE(EXCLUDED.{k}, {S()}.pipeline_snapshot.{k})" for k in cols[2:]) + ", pipeline_id = EXCLUDED.pipeline_id, observed_at = now()"
    lb.execute(f"INSERT INTO {S()}.pipeline_snapshot ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) "
               f"ON CONFLICT (request_id) DO UPDATE SET {upd}", vals)


def set_paused(lb: Lakebase, rid: str, pipeline_id: str, by: str | None) -> None:
    """by = who paused it; None = unpaused. Explicit (upsert_snapshot keeps old values on NULL)."""
    state, health = ("PAUSED", "paused") if by else ("RUNNING", "healthy")
    lb.execute(f"INSERT INTO {S()}.pipeline_snapshot (request_id, pipeline_id, state, health, paused_at, paused_by) "
               f"VALUES (%s, %s, %s, %s, CASE WHEN %s::text IS NULL THEN NULL ELSE now() END, %s) "
               f"ON CONFLICT (request_id) DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id, state = EXCLUDED.state, "
               f"health = EXCLUDED.health, paused_at = EXCLUDED.paused_at, paused_by = EXCLUDED.paused_by, observed_at = now()",
               (rid, pipeline_id, state, health, by, by))


def incidents(lb: Lakebase, rid: str | None = None, open_only: bool = False, limit: int = 100) -> list[dict[str, Any]]:
    where, params = [], []
    if rid:
        where.append("request_id = %s")
        params.append(rid)
    if open_only:
        where.append("status = 'open'")
    sql = f"SELECT * FROM {S()}.incident {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY opened_at DESC LIMIT %s"
    return [row(r) for r in lb.query(sql, (*params, limit))]  # type: ignore[misc]


def open_incident(lb: Lakebase, rid: str, pipeline_id: str | None, kind: str, status: str, title: str, detail: str,
                  ticket_ref: str | None = None) -> int:
    r = lb.query(f"INSERT INTO {S()}.incident (request_id, pipeline_id, kind, status, title, detail, ticket_ref, resolved_at) "
                 f"VALUES (%s,%s,%s,%s,%s,%s,%s, CASE WHEN %s = 'auto_healed' THEN now() END) RETURNING id",
                 (rid, pipeline_id, kind, status, title[:300], detail[:4000], ticket_ref, status))
    return int(r[0]["id"])


def add_recon(lb: Lakebase, rid: str, table: str, source_rows: int | None, target_rows: int | None, status: str) -> None:
    lb.execute(f"INSERT INTO {S()}.reconciliation (request_id, table_name, source_rows, target_rows, status) VALUES (%s,%s,%s,%s,%s)",
               (rid, table, source_rows, target_rows, status))


def latest_recon(lb: Lakebase, rid: str) -> list[dict[str, Any]]:
    return [row(r) for r in lb.query(f"SELECT DISTINCT ON (table_name) table_name, source_rows, target_rows, status, at FROM {S()}.reconciliation "
                                     f"WHERE request_id = %s ORDER BY table_name, at DESC", (rid,))]  # type: ignore[misc]


def gateway_for(lb: Lakebase, connection: str, database: str) -> dict[str, Any] | None:
    r = lb.query(f"SELECT * FROM {S()}.gateway WHERE connection_name = %s AND source_database = %s", (connection, database or ""))
    return row(r[0]) if r else None


def save_gateway(lb: Lakebase, connection: str, database: str, pipeline_id: str, rid: str, slot: str | None, pub: str | None) -> None:
    lb.execute(f"INSERT INTO {S()}.gateway (connection_name, source_database, pipeline_id, slot_name, publication_name, created_by_request) "
               f"VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (connection_name, source_database) DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id, "
               f"stopped_at = NULL", (connection, database or "", pipeline_id, slot, pub, rid))


def chat_get(lb: Lakebase, sid: str) -> dict[str, Any] | None:
    r = lb.query(f"SELECT * FROM {S()}.chat_session WHERE id = %s", (sid,))
    return row(r[0]) if r else None


def chat_save(lb: Lakebase, sid: str, owner: str, turns: list[dict[str, Any]], draft: dict[str, Any], request_id: str | None = None) -> None:
    lb.execute(f"INSERT INTO {S()}.chat_session (id, owner, turns, draft, request_id) VALUES (%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE "
               f"SET turns = EXCLUDED.turns, draft = EXCLUDED.draft, request_id = COALESCE(EXCLUDED.request_id, {S()}.chat_session.request_id), updated_at = now()",
               (sid, owner, Jsonb(turns), Jsonb(draft), request_id))
