"""Pure builders: an approved IngestionConfig -> the exact Lakeflow Connect API payloads (and a bundle YAML).

Shapes verified against docs.databricks.com + databricks-sdk 0.158 on 2026-10-31 (docs/RESEARCH.md):
- gateway CDC (PostgreSQL, SQL Server): an ingestion GATEWAY pipeline (classic compute, always on) +
  a serverless ingestion pipeline with `ingestion_gateway_id`; PostgreSQL adds `source_configurations` with the
  replication slot + publication.
- integrated CDC (MySQL, Oracle): one serverless pipeline, `connection_name` + `connector_type: CDC` +
  `data_staging_options` (Oracle also needs channel PREVIEW). Without `connector_type` a database connection
  defaults to QUERY_BASED, so it is always set explicitly.
- query-based from a UC catalog (`source.via = uc_catalog`, e.g. a Lakebase database catalog or a Lakehouse
  Federation foreign catalog): `ingest_from_uc_foreign_catalog: true`, no connection_name, source_catalog = catalog.
  (Verified live 2026-10-31: a validate-only update COMPLETED. CDC on a MANAGED_POSTGRESQL connection is gated.)
- query-based (databases): `connector_type: QUERY_BASED`, one cursor column per table in
  `table_configuration.query_based_connector_config.cursor_columns`; hard-delete sync only with SCD type 1.
- SaaS / files: `connection_name` + objects, serverless, no gateway.
A triggered pipeline is scheduled by a Jobs `pipeline_task` (Quartz cron); continuous mode sets `continuous: true`.
Every pipeline publishes its event log to Unity Catalog (the guardian reads freshness / rows from it) and carries
FinOps tags (request, owner, cost center, classification, environment).
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

ALLOWED_INTERVALS = (5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720, 1440)


def slug(s: str, n: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:n] or "x"


def ident(s: str, n: int = 48) -> str:
    """A safe SQL / UC identifier fragment (lowercase, underscores)."""
    return re.sub(r"[^a-z0-9_]+", "_", (s or "").lower()).strip("_")[:n] or "x"


def config_hash(cfg: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def quartz(interval_minutes: int) -> str:
    """Quartz cron for 'every N minutes' (N from ALLOWED_INTERVALS)."""
    i = int(interval_minutes)
    if i < 60:
        return f"0 0/{i} * * * ?"
    if i < 1440:
        return f"0 0 0/{i // 60} * * ?"
    return "0 0 2 * * ?"


def tags(rid: str, cfg: dict[str, Any]) -> dict[str, str]:
    o = cfg.get("ownership") or {}
    t = {
        "dis_request": rid,
        "dis_owner": slug(o.get("owner", "").split("@")[0], 60),
        "dis_cost_center": slug(o.get("cost_center", ""), 40) or "unassigned",
        "dis_classification": o.get("classification", "internal"),
        "dis_domain": slug(o.get("domain", ""), 40) or "general",
        "dis_environment": (cfg.get("destination") or {}).get("environment", "dev"),
    }
    return {k: v for k, v in t.items() if v}


def names(rid: str, cfg: dict[str, Any]) -> dict[str, str]:
    env = (cfg.get("destination") or {}).get("environment", "dev")
    base = f"dis-{env}-{rid.lower()}-{slug(cfg.get('title', ''), 28)}".strip("-")
    return {"pipeline": base, "job": f"{base}-schedule", "event_log": ident(f"dis_event_log_{rid}")}


def destination_table(o: dict[str, Any], prefix: str = "") -> str:
    return ident(o.get("destination_table") or f"{prefix}{o['table']}", 120)


def _table_config(cfg: dict[str, Any], o: dict[str, Any], pattern: str) -> dict[str, Any]:
    scd = (cfg.get("schema") or {}).get("scd_type", "SCD_TYPE_1")
    tc: dict[str, Any] = {"scd_type": scd}
    if o.get("primary_keys"):
        tc["primary_keys"] = list(o["primary_keys"])
    if pattern in ("query", "federation"):
        qb: dict[str, Any] = {"cursor_columns": [o["cursor_column"]] if o.get("cursor_column") else []}
        ops = cfg.get("operations") or {}
        if scd == "SCD_TYPE_1" and ops.get("hard_delete_sync", True):
            qb["hard_deletion_sync_min_interval_in_seconds"] = int(ops.get("hard_delete_sync_seconds", 86400))
        tc["query_based_connector_config"] = qb
    return tc


def _objects(cfg: dict[str, Any], pattern: str, source_catalog: str | None) -> list[dict[str, Any]]:
    d = cfg.get("destination") or {}
    prefix = d.get("table_prefix") or ""
    out = []
    for o in cfg.get("objects") or []:
        t: dict[str, Any] = {}
        if source_catalog:
            t["source_catalog"] = source_catalog
        t.update({"source_schema": o["schema"], "source_table": o["table"],
                  "destination_catalog": d["catalog"], "destination_schema": d["schema"],
                  "destination_table": destination_table(o, prefix),
                  "table_configuration": _table_config(cfg, o, pattern)})
        out.append({"table": t})
    return out


def build(rid: str, cfg: dict[str, Any], connector: dict[str, Any], *, staging_catalog: str, staging_schema: str,
          event_log_catalog: str, event_log_schema: str, gateway_id: str | None = None,
          slot: dict[str, str] | None = None, source_dir: str = "/Workspace/Shared/data-ingestion-service/pipelines",
          version: int = 1) -> dict[str, Any]:
    """All payloads for one request. `gateway_id` = an existing (shared) gateway; None = create one."""
    src = cfg.get("source") or {}
    pattern = src.get("pattern", "cdc")
    conn = src.get("connection")
    db = src.get("database") or None
    n = names(rid, cfg)
    d = cfg.get("destination") or {}
    sched = cfg.get("schedule") or {}
    continuous = sched.get("mode") == "continuous"
    tg = tags(rid, cfg)
    arch = connector.get("cdc_architecture") if pattern == "cdc" else None
    category = connector.get("category")

    common: dict[str, Any] = {
        "name": n["pipeline"], "catalog": d["catalog"], "schema": d["schema"], "serverless": True,
        "continuous": bool(continuous), "development": d.get("environment") == "dev", "tags": tg,
        "event_log": {"catalog": event_log_catalog, "schema": event_log_schema, "name": n["event_log"]},
    }
    if connector.get("status") == "preview" and connector.get("id") == "oracle":
        common["channel"] = "PREVIEW"

    gateway: dict[str, Any] | None = None
    ingestion_def: dict[str, Any]
    if pattern == "cdc" and arch == "gateway":
        gw_store = f"dis-gw-{slug(conn or 'conn', 30)}-{slug(db or 'db', 20)}"
        if gateway_id is None:
            gateway = {
                "name": f"dis-gateway-{slug(conn or 'conn', 30)}-{slug(db or 'db', 20)}",
                "catalog": staging_catalog, "schema": staging_schema, "tags": {**tg, "dis_role": "gateway"},
                "gateway_definition": {"connection_name": conn, "gateway_storage_catalog": staging_catalog,
                                       "gateway_storage_schema": staging_schema, "gateway_storage_name": gw_store},
                "event_log": {"catalog": event_log_catalog, "schema": event_log_schema, "name": ident(f"dis_event_log_gw_{conn}_{db}")},
            }
        ingestion_def = {"ingestion_gateway_id": gateway_id or "${gateway.pipeline_id}",
                         "objects": _objects(cfg, pattern, db)}
        if connector.get("id") == "postgresql":
            s = slot or {}
            ingestion_def["source_configurations"] = [{"catalog": {"source_catalog": db, "postgres": {"slot_config": {
                "slot_name": s.get("slot_name", "dis_slot"), "publication_name": s.get("publication_name", "dis_publication")}}}}]
    elif pattern == "cdc":  # integrated
        ingestion_def = {"connection_name": conn, "connector_type": "CDC", "objects": _objects(cfg, pattern, db),
                         "data_staging_options": {"catalog_name": staging_catalog, "schema_name": staging_schema}}
    elif pattern == "federation" or (pattern == "query" and src.get("via") == "uc_catalog"):
        # a Unity Catalog (foreign / database) catalog as the source: no connection_name, source_catalog = the catalog
        fc = conn if src.get("via") == "uc_catalog" else (src.get("foreign_catalog") or None)
        ingestion_def = {"ingest_from_uc_foreign_catalog": True, "objects": _objects(cfg, "query", fc)}
    elif pattern == "query":
        ingestion_def = {"connection_name": conn, "connector_type": "QUERY_BASED", "objects": _objects(cfg, pattern, db)}
    elif pattern == "stream":  # managed Kafka connector (Beta): continuous, PREVIEW channel
        objs = []
        for o in cfg.get("objects") or []:
            opts = o.get("options") or {}
            objs.append({"table": {"source_table": "N/A", "destination_catalog": d["catalog"], "destination_schema": d["schema"],
                                   "destination_table": destination_table(o, d.get("table_prefix") or ""),
                                   "connector_options": {"kafka_options": {"topics": [opts.get("topic") or o["table"]],
                                                                           "starting_offset": opts.get("starting_offset", "earliest"),
                                                                           "key_transformer": {"format": "STRING"},
                                                                           "value_transformer": {"format": (opts.get("value_format") or "JSON").upper()}}}}})
        ingestion_def = {"connection_name": conn, "objects": objs}
        common.update({"continuous": True, "channel": "PREVIEW"})
    elif pattern == "community":  # Lakeflow community connector (Python Data Source), Beta
        ingestion_def = {"connection_name": conn, "source_type": "COMMUNITY", "objects": _objects(cfg, "saas", None)}
        common.update({"channel": "PREVIEW", "configuration": {"pipelines.managedIngestion.registerPythonDataSource": "true"}})
        wheel = (src.get("options") or {}).get("wheel")
        if wheel:
            common["environment"] = {"dependencies": [wheel]}
    else:  # saas (incl. API_SOURCE connectors); source_schema is the connector's object namespace
        ingestion_def = {"connection_name": conn, "objects": _objects(cfg, "saas", None)}
        if connector.get("id") == "api_source":
            ingestion_def["source_configurations"] = [{"api_source_connector_config": {"configs": (src.get("options") or {})}}]
            for ob, o in zip(ingestion_def["objects"], cfg.get("objects") or []):
                ob["table"]["connector_options"] = {"api_source_connector_options": {"options": (o.get("options") or {})}}
        if category == "files":
            for ob in ingestion_def["objects"]:
                ob["table"]["table_configuration"].pop("primary_keys", None)

    if pattern in ("files", "api"):
        # a Lakeflow Declarative Pipeline from generated source (Auto Loader / HTTP connection), not an ingestion_definition
        from modules.deploy import codegen
        prefix = d.get("table_prefix") or ""
        tn = lambda o: destination_table(o, prefix)  # noqa: E731
        h = config_hash(cfg)
        if pattern == "files":
            ep = (src.get("endpoint") or {}) if connector.get("id") == "sftp" else None
            sftp = {**ep, "connection": conn} if ep is not None else None
            code = codegen.files(rid, version, h, cfg, tn, sftp)
        else:
            code = codegen.api(rid, version, h, cfg, tn, conn)
        path = f"{source_dir.rstrip('/')}/{ident(rid)}_v{version}.py"
        ingestion = {**common, "libraries": [{"file": {"path": path}}], "channel": "CURRENT",
                     "configuration": {"dis.request": rid, "dis.connection": conn or ""}}
        if pattern == "api":
            ingestion["environment"] = {"dependencies": ["databricks-sdk>=0.57.0"]}
        job = None
        if not continuous:
            interval = int(sched.get("interval_minutes") or 60)
            ops = cfg.get("operations") or {}
            job = {"name": n["job"], "max_concurrent_runs": 1, "tags": tg,
                   "tasks": [{"task_key": "ingest", "pipeline_task": {"pipeline_id": "${ingestion.pipeline_id}", "full_refresh": False},
                              "max_retries": int(ops.get("retries", 3)), "min_retry_interval_millis": 300000, "retry_on_timeout": True}],
                   "schedule": {"quartz_cron_expression": quartz(interval), "timezone_id": "UTC", "pause_status": "UNPAUSED"}}
        return {"gateway": None, "ingestion": ingestion, "job": job, "source_code": code, "source_path": path}

    ingestion = {**common, "ingestion_definition": ingestion_def}

    job = None
    if not continuous:
        interval = int(sched.get("interval_minutes") or 60)
        ops = cfg.get("operations") or {}
        alerts = [e for e in (ops.get("alert_emails") or []) if "@" in e]
        job = {
            "name": n["job"], "max_concurrent_runs": 1, "tags": tg,
            "tasks": [{"task_key": "ingest", "pipeline_task": {"pipeline_id": "${ingestion.pipeline_id}", "full_refresh": False},
                       "max_retries": int(ops.get("retries", 3)), "min_retry_interval_millis": 300000, "retry_on_timeout": True}],
            "schedule": {"quartz_cron_expression": quartz(interval), "timezone_id": "UTC", "pause_status": "UNPAUSED"},
        }
        if alerts:
            job["email_notifications"] = {"on_failure": alerts}
    return {"gateway": gateway, "ingestion": ingestion, "job": job}


def _yaml_scalar(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if s == "" or re.search(r"[:#\[\]{},&*!|>'\"%@`]|^\s|\s$|^(true|false|null|yes|no|\d[\d.]*)$", s, re.I):
        return json.dumps(s)
    return s


def to_yaml(obj: Any, indent: int = 0) -> str:
    pad = "  " * indent
    if isinstance(obj, dict):
        if not obj:
            return pad + "{}\n"
        out = ""
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and v:
                out += f"{pad}{k}:\n" + to_yaml(v, indent + 1)
            else:
                out += f"{pad}{k}: {_yaml_scalar(v) if not isinstance(v, (dict, list)) else ('{}' if isinstance(v, dict) else '[]')}\n"
        return out
    if isinstance(obj, list):
        out = ""
        for v in obj:
            if isinstance(v, (dict, list)) and v:
                inner = to_yaml(v, indent + 1)
                first, _, rest = inner.partition("\n")
                out += f"{pad}- {first.strip()}\n" + rest
            else:
                out += f"{pad}- {_yaml_scalar(v)}\n"
        return out
    return pad + _yaml_scalar(obj) + "\n"


def bundle_yaml(rid: str, specs: dict[str, Any]) -> str:
    """The same configuration as a Declarative Automation Bundle resource file (GitOps: dev -> uat -> prod)."""
    key = ident(rid)
    res: dict[str, Any] = {"pipelines": {}, "jobs": {}}
    if specs.get("gateway"):
        res["pipelines"][f"{key}_gateway"] = specs["gateway"]
    ing = json.loads(json.dumps(specs["ingestion"]))
    if specs.get("gateway"):
        ing["ingestion_definition"]["ingestion_gateway_id"] = f"${{resources.pipelines.{key}_gateway.id}}"
    res["pipelines"][f"{key}_ingestion"] = ing
    if specs.get("job"):
        job = json.loads(json.dumps(specs["job"]))
        job["tasks"][0]["pipeline_task"]["pipeline_id"] = f"${{resources.pipelines.{key}_ingestion.id}}"
        res["jobs"][f"{key}_schedule"] = job
    if not res["jobs"]:
        res.pop("jobs")
    header = (f"# Data Ingestion Service: approved configuration {rid} as a bundle resource file.\n"
              f"# Drop into resources/ of a bundle and `databricks bundle deploy -t <env>` to promote it.\n")
    return header + to_yaml({"resources": res})
