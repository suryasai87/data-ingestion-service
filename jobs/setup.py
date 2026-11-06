"""Setup job: idempotent bootstrap of everything the Data Ingestion Service runs on. Runs as the DEPLOYER.

    python jobs/setup.py --root . --app-name data-ingestion-service --uc-catalog <cat> ... [--check] [--rotate]

1. Unity Catalog: the service schema (history, model, event logs, mirror), the gateway staging schema and the
   Foundation schemas per environment; the app SP gets ALL PRIVILEGES on them (it owns the pipelines it creates).
2. Store (Lakebase): migrations, policy seeds (destinations), the app SP's OAuth role + grants.
3. Demo source (Lakebase "ERP" Postgres): database, generic finance / procurement / quality tables with primary
   keys + seed rows, a REPLICATION role whose password lives only in the secret scope, the publication + a
   logical replication slot (pgoutput), and the app SP's OAuth role (browse, reconcile, demo activity).
4. Secret scope + key (credentials in a vault); the app SP gets READ.
5. The demo source in Unity Catalog: a database catalog (query-based ingestion, browse, reconcile) and, when the
   deployer may create connections, a POSTGRESQL connection (log-based CDC through a gateway).
6. The app SP may create clusters (ingestion gateways run on classic compute).
Every step prints what it did; nothing outside this deployment's own resources is touched.
"""
from __future__ import annotations

import argparse
import os
import re
import secrets
import sys
import time
from typing import Any

def _jobs_dir() -> str:
    """spark_python_task exec()s the file (no __file__): fall back to <--root>/jobs."""
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:
        a = sys.argv
        return os.path.join(a[a.index("--root") + 1] if "--root" in a else ".", "jobs")


sys.path.insert(0, _jobs_dir())
import _bootstrap  # noqa: E402

ROOT = _bootstrap.init()

import psycopg  # noqa: E402
from psycopg import sql  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402

from core import config, lakebase, migrate, repo  # noqa: E402
from core.lakebase import Lakebase  # noqa: E402
from modules.requests import rules  # noqa: E402

SOURCE_TABLES = ["finance.journal_header", "finance.journal_line", "finance.vendor", "finance.cost_center",
                 "procurement.purchase_order", "procurement.po_item", "quality.inspection_lot"]

SOURCE_DDL = """
CREATE SCHEMA IF NOT EXISTS finance;
CREATE SCHEMA IF NOT EXISTS procurement;
CREATE SCHEMA IF NOT EXISTS quality;
CREATE TABLE IF NOT EXISTS finance.cost_center (
  cost_center text PRIMARY KEY, name text NOT NULL, company_code text NOT NULL, valid_from date NOT NULL,
  valid_to date NOT NULL DEFAULT '9999-12-31', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS finance.vendor (
  vendor_id bigint PRIMARY KEY, name text NOT NULL, country text NOT NULL, payment_terms text NOT NULL,
  blocked boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS finance.journal_header (
  doc_id bigint PRIMARY KEY, company_code text NOT NULL, fiscal_year int NOT NULL, doc_type text NOT NULL,
  posting_date date NOT NULL, currency text NOT NULL, reference text, created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS finance.journal_line (
  doc_id bigint NOT NULL, line_no int NOT NULL, gl_account text NOT NULL, cost_center text, amount numeric(18,2) NOT NULL,
  debit_credit char(1) NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (doc_id, line_no));
CREATE TABLE IF NOT EXISTS procurement.purchase_order (
  po_id bigint PRIMARY KEY, vendor_id bigint NOT NULL, company_code text NOT NULL, po_date date NOT NULL,
  status text NOT NULL, total_amount numeric(18,2) NOT NULL, currency text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS procurement.po_item (
  po_id bigint NOT NULL, item_no int NOT NULL, material text NOT NULL, quantity numeric(14,3) NOT NULL,
  unit_price numeric(18,4) NOT NULL, plant text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (po_id, item_no));
CREATE TABLE IF NOT EXISTS quality.inspection_lot (
  lot_id bigint PRIMARY KEY, material text NOT NULL, plant text NOT NULL, batch text NOT NULL, result text NOT NULL,
  inspected_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
"""

# Synthetic, generic content (no customer structures): deterministic so every install reproduces the same counts.
SOURCE_SEED = """
INSERT INTO finance.cost_center SELECT 'CC' || lpad(g::text, 3, '0'), 'Cost center ' || g, (ARRAY['1000','2000','3000'])[1 + g % 3],
  date '2020-01-01' FROM generate_series(1, 120) g ON CONFLICT DO NOTHING;
INSERT INTO finance.vendor SELECT g, 'Vendor ' || g, (ARRAY['US','DE','IE','CH','JP','MX'])[1 + g % 6],
  (ARRAY['NT30','NT45','NT60'])[1 + g % 3], g % 97 = 0 FROM generate_series(1, 500) g ON CONFLICT DO NOTHING;
INSERT INTO finance.journal_header SELECT g, (ARRAY['1000','2000','3000'])[1 + g % 3], 2026, (ARRAY['SA','KR','DR','AB'])[1 + g % 4],
  date '2026-01-01' + (g % 300), (ARRAY['USD','EUR','CHF'])[1 + g % 3], 'REF-' || g, 'seed' FROM generate_series(1, 20000) g ON CONFLICT DO NOTHING;
INSERT INTO finance.journal_line SELECT h, l, (ARRAY['400100','500200','600300','110000','210000'])[1 + (h + l) % 5],
  'CC' || lpad((1 + (h * 7 + l) % 120)::text, 3, '0'), round(((h * 37 + l * 101) % 250000) / 10.0, 2), CASE WHEN l % 2 = 1 THEN 'S' ELSE 'H' END
  FROM generate_series(1, 20000) h, generate_series(1, 3) l ON CONFLICT DO NOTHING;
INSERT INTO procurement.purchase_order SELECT g, 1 + g % 500, (ARRAY['1000','2000','3000'])[1 + g % 3], date '2026-01-01' + (g % 300),
  (ARRAY['OPEN','RELEASED','RECEIVED','CLOSED'])[1 + g % 4], round(((g * 53) % 900000) / 10.0, 2), 'USD' FROM generate_series(1, 5000) g ON CONFLICT DO NOTHING;
INSERT INTO procurement.po_item SELECT p, i, 'MAT-' || lpad(((p * 13 + i) % 800)::text, 5, '0'), 1 + (p + i) % 40,
  round((((p * 17 + i * 3) % 50000) / 100.0)::numeric, 4), (ARRAY['P100','P200','P300'])[1 + (p + i) % 3]
  FROM generate_series(1, 5000) p, generate_series(1, 3) i ON CONFLICT DO NOTHING;
INSERT INTO quality.inspection_lot SELECT g, 'MAT-' || lpad((g % 800)::text, 5, '0'), (ARRAY['P100','P200','P300'])[1 + g % 3],
  'B' || lpad(g::text, 7, '0'), (ARRAY['ACCEPTED','ACCEPTED','ACCEPTED','REJECTED','PENDING'])[1 + g % 5],
  timestamptz '2026-01-01' + (g || ' hours')::interval FROM generate_series(1, 3000) g ON CONFLICT DO NOTHING;
-- Distinct cursor values: a query-based cursor watermark is inclusive (>=), so rows sharing ONE seed timestamp would
-- all be re-read on the first incremental run (seen live: 80,150 rows instead of ~170).
UPDATE finance.cost_center SET updated_at = timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => substr(cost_center, 3)::int);
UPDATE finance.vendor SET updated_at = timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => vendor_id);
UPDATE finance.journal_header SET updated_at = timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => doc_id);
UPDATE finance.journal_line SET updated_at = timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => doc_id * 3 + line_no);
UPDATE procurement.purchase_order SET updated_at = timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => po_id);
UPDATE procurement.po_item SET updated_at = timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => po_id * 3 + item_no);
UPDATE quality.inspection_lot SET updated_at = timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => lot_id);
"""


def log(msg: str) -> None:
    print(f"[setup] {msg}", flush=True)


def api(w: Any, method: str, path: str, body: Any = None, ok_codes: tuple[str, ...] = ()) -> Any:
    try:
        return w.api_client.do(method, path, body=body)
    except Exception as e:  # noqa: BLE001
        if any(c in str(e) for c in ok_codes):
            return None
        raise


def wait_endpoint(w: Any, project: str, timeout: int = 600) -> str:
    ep = f"projects/{project}/branches/production/endpoints/primary"
    t0 = time.time()
    while True:
        r = api(w, "GET", f"/api/2.0/postgres/{ep}") or {}
        st = r.get("status") or {}
        host = (st.get("hosts") or {}).get("host")
        if host and st.get("current_state") in (None, "ACTIVE", "IDLE"):
            return host
        if time.time() - t0 > timeout:
            raise TimeoutError(f"endpoint {ep} not ready: {st}")
        time.sleep(10)


def role_slug(prefix: str, sp: str) -> str:
    s = re.sub(r"[^a-z0-9-]", "-", f"{prefix}-{sp}".lower())[:63].strip("-")
    return s if s[0].isalpha() else "r" + s[:62]


def register_sp_role(w: Any, project: str, sp: str) -> None:
    branch = f"projects/{project}/branches/production"
    rid = role_slug("app-sp", sp)
    api(w, "POST", f"/api/2.0/postgres/{branch}/roles?role_id={rid}",
        {"spec": {"identity_type": "SERVICE_PRINCIPAL", "postgres_role": sp, "auth_method": "LAKEBASE_OAUTH_V1"}},
        ok_codes=("ALREADY_EXISTS", "already exists"))
    for _ in range(30):
        r = api(w, "GET", f"/api/2.0/postgres/{branch}/roles/{rid}", ok_codes=("NOT_FOUND",)) or {}
        if (r.get("status") or {}).get("postgres_role") or r.get("name"):
            break
        time.sleep(3)
    log(f"app SP OAuth role on {project}: {rid}")


def connect(w: Any, project: str, database: str, autocommit: bool = False) -> psycopg.Connection:
    ep = f"projects/{project}/branches/production/endpoints/primary"
    host = wait_endpoint(w, project)
    cred = api(w, "POST", "/api/2.0/postgres/credentials", {"endpoint": ep}) or {}
    return psycopg.connect(host=host, port=5432, dbname=database, user=lakebase.pg_user(w), password=cred["token"],
                           sslmode="require", autocommit=autocommit, row_factory=dict_row, connect_timeout=15)


def uc_grant(w: Any, securable: str, name: str, principal: str, privileges: list[str]) -> None:
    api(w, "PATCH", f"/api/2.1/unity-catalog/permissions/{securable}/{name}",
        {"changes": [{"principal": principal, "add": privileges}]})


def ensure_schema(w: Any, catalog: str, schema: str, comment: str) -> None:
    api(w, "POST", "/api/2.1/unity-catalog/schemas", {"catalog_name": catalog, "name": schema, "comment": comment},
        ok_codes=("ALREADY_EXISTS", "already exists", "SCHEMA_ALREADY_EXISTS"))


def main() -> int:
    ap = argparse.ArgumentParser()
    for a in ("--root", "--app-name", "--uc-catalog", "--uc-schema", "--staging-schema", "--destination-catalog",
              "--store-project", "--source-project", "--source-database", "--demo-connection", "--source-catalog", "--secret-scope", "--warehouse-id"):
        ap.add_argument(a, default="")
    ap.add_argument("--env", action="append", default=[])
    ap.add_argument("--source-owner-sp", default="true", help="make the app SP the owner of the demo source catalog")
    ap.add_argument("--demo-http-connection", default="none", help="an existing UC HTTP connection the app SP may use (API demo)")
    ap.add_argument("--check", action="store_true", help="report only, change nothing")
    ap.add_argument("--rotate", action="store_true", help="rotate the demo replication password")
    a = ap.parse_args()
    w = lakebase.workspace_client()
    me = w.current_user.me().user_name
    log(f"running as {me}")

    sp = None
    try:
        app = w.apps.get(a.app_name)
        sp = app.service_principal_client_id
        log(f"app {a.app_name}: service principal {sp}")
    except Exception as e:  # noqa: BLE001
        log(f"app {a.app_name} not found yet ({type(e).__name__}): SP grants are skipped; re-run setup after the app exists")
    if a.check:
        log("check mode: nothing changed")
        return 0

    # 1. Unity Catalog ------------------------------------------------------------------------------------------
    dest_schemas = [f"foundation_{e}" for e in ("dev", "uat", "prod")]
    ensure_schema(w, a.uc_catalog, a.uc_schema, "Data Ingestion Service: history features, forecast model, request mirror, pipeline event logs")
    ensure_schema(w, a.uc_catalog, a.staging_schema, "Data Ingestion Service: ingestion gateway staging volumes")
    for s in dest_schemas:
        ensure_schema(w, a.destination_catalog, s, f"Foundation ({s.split('_')[1].upper()}): tables landed by the Data Ingestion Service")
    log(f"UC schemas ready: {a.uc_catalog}.{{{a.uc_schema},{a.staging_schema}}}, {a.destination_catalog}.{{{','.join(dest_schemas)}}}")
    if sp:
        for cat in sorted({a.uc_catalog, a.destination_catalog}):
            uc_grant(w, "catalog", cat, sp, ["USE_CATALOG"])
        for s in [f"{a.uc_catalog}.{a.uc_schema}", f"{a.uc_catalog}.{a.staging_schema}"] + [f"{a.destination_catalog}.{x}" for x in dest_schemas]:
            uc_grant(w, "schema", s, sp, ["ALL_PRIVILEGES"])
        log("app SP: USE CATALOG + ALL PRIVILEGES on the service / staging / Foundation schemas")
        # Apps telemetry: the SP creates and appends the OTEL tables (documented: USE SCHEMA, SELECT, MODIFY, CREATE TABLE)
        uc_grant(w, "schema", f"{a.uc_catalog}.{a.uc_schema}", sp, ["USE_SCHEMA", "SELECT", "MODIFY", "CREATE_TABLE"])
        # MANAGE lets the SP grant readers USE CATALOG / USE SCHEMA / SELECT on what its pipelines land (ALL PRIVILEGES
        # does not include granting). Readers never get anything else.
        for x in dest_schemas:
            uc_grant(w, "schema", f"{a.destination_catalog}.{x}", sp, ["MANAGE"])
        try:
            uc_grant(w, "catalog", a.destination_catalog, sp, ["MANAGE"])
            log(f"app SP: MANAGE on {a.destination_catalog} + Foundation schemas (grants readers read-only access)")
        except Exception as e:  # noqa: BLE001
            log(f"MANAGE on catalog {a.destination_catalog} not granted ({type(e).__name__}); readers' USE CATALOG must be granted by its owner")
    api(w, "POST", "/api/2.1/unity-catalog/volumes", {"catalog_name": a.uc_catalog, "schema_name": a.uc_schema, "name": "gxp_evidence",
        "volume_type": "MANAGED", "comment": "GxP qualification evidence packs (SHA-256 manifests)"}, ok_codes=("ALREADY_EXISTS", "already exists"))
    log(f"volume {a.uc_catalog}.{a.uc_schema}.gxp_evidence ready")
    # demo file drop for the files pattern (Auto Loader from a UC volume): a small synthetic CSV, written once
    api(w, "POST", "/api/2.1/unity-catalog/volumes", {"catalog_name": a.uc_catalog, "schema_name": a.uc_schema, "name": "landing_drop",
        "volume_type": "MANAGED", "comment": "Demo file drop (files pattern)"}, ok_codes=("ALREADY_EXISTS", "already exists"))
    drop = f"/Volumes/{a.uc_catalog}/{a.uc_schema}/landing_drop/lab_results/batch_0001.csv"
    try:
        w.files.get_metadata(drop)
    except Exception:  # noqa: BLE001 - not there yet
        import io
        rows = ["sample_id,lot_id,test,result,unit,tested_at"] + [
            f"S{i:05d},{1000 + i % 300},{['assay', 'ph', 'endotoxin', 'bioburden'][i % 4]},{round(5 + (i * 37 % 100) / 10, 2)},"
            f"{['%', 'pH', 'EU/mL', 'CFU'][i % 4]},2026-10-{1 + i % 28:02d}T{i % 24:02d}:00:00Z" for i in range(1, 501)]
        w.files.upload(drop, io.BytesIO(("\n".join(rows) + "\n").encode()), overwrite=True)
        log(f"demo file drop seeded: {drop} (500 rows)")
    if sp and a.demo_http_connection not in ("", "none"):
        try:
            uc_grant(w, "connection", a.demo_http_connection, sp, ["USE_CONNECTION"])
            log(f"app SP USE CONNECTION on HTTP connection {a.demo_http_connection} (API pattern demo)")
        except Exception as e:  # noqa: BLE001
            log(f"USE CONNECTION on {a.demo_http_connection} not granted ({type(e).__name__}): the API demo needs its owner to grant it")

    # 2. Store ---------------------------------------------------------------------------------------------------
    store = Lakebase(endpoint=f"projects/{a.store_project}/branches/production/endpoints/primary", database="databricks_postgres",
                     schema=config.LAKEBASE_SCHEMA, pool_max=2)
    wait_endpoint(w, a.store_project)
    applied = migrate.apply(store, config.LAKEBASE_SCHEMA)
    log(f"store migrations applied: {applied or 'none (up to date)'}")
    dests = [{"environment": e, "label": f"Foundation · {e.upper()}", "catalog": a.destination_catalog, "schema": f"foundation_{e}",
              "requires_approval": True} for e in ("dev", "uat", "prod")]
    defaults = {k: v["value"] for k, v in rules.DEFAULT_POLICIES.items()}
    defaults["destinations"] = dests
    log(f"policies seeded: {repo.seed_policies(store, defaults, me)} new")
    if sp:
        register_sp_role(w, a.store_project, sp)
        s = config.LAKEBASE_SCHEMA
        with store.connection() as c, c.cursor() as cur:
            cur.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(s), sql.Identifier(sp)))
            cur.execute(sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {} TO {}").format(sql.Identifier(s), sql.Identifier(sp)))
            cur.execute(sql.SQL("GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA {} TO {}").format(sql.Identifier(s), sql.Identifier(sp)))
            cur.execute(sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA {} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}").format(sql.Identifier(s), sql.Identifier(sp)))
            cur.execute(sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA {} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {}").format(sql.Identifier(s), sql.Identifier(sp)))
        log(f"app SP granted read/write on store schema {s}")
    store.close()

    # 3. Demo source -----------------------------------------------------------------------------------------------
    host = wait_endpoint(w, a.source_project)
    with connect(w, a.source_project, "databricks_postgres", autocommit=True) as c:
        if not c.execute("SELECT 1 FROM pg_database WHERE datname = %s", (a.source_database,)).fetchone():
            c.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(a.source_database)))
            log(f"created source database {a.source_database}")
    scope, key = a.secret_scope, "demo_replication_password"
    api(w, "POST", "/api/2.0/secrets/scopes/create", {"scope": scope}, ok_codes=("RESOURCE_ALREADY_EXISTS", "already exists"))
    have_secret = any(s.get("key") == key for s in (api(w, "GET", f"/api/2.0/secrets/list?scope={scope}") or {}).get("secrets", []))
    password = None
    if a.rotate or not have_secret:
        password = secrets.token_urlsafe(24).replace("-", "x").replace("_", "y") + "Aa9"
        api(w, "POST", "/api/2.0/secrets/put", {"scope": scope, "key": key, "string_value": password})
        log(f"replication password {'rotated' if have_secret else 'created'} in secret scope {scope}/{key} (value never printed)")
    with connect(w, a.source_project, a.source_database) as c:
        c.execute(SOURCE_DDL)
        if not c.execute("SELECT 1 FROM finance.journal_header LIMIT 1").fetchone():  # seed once: demo activity must survive re-runs
            c.execute(SOURCE_SEED)
            log("seeded the source tables")
        exists = c.execute("SELECT 1 FROM pg_roles WHERE rolname = 'dis_replication'").fetchone()
        if not exists:
            if password is None:  # secret exists but the role does not (fresh source): rotate so both match
                password = secrets.token_urlsafe(24).replace("-", "x").replace("_", "y") + "Aa9"
                api(w, "POST", "/api/2.0/secrets/put", {"scope": scope, "key": key, "string_value": password})
            c.execute(sql.SQL("CREATE ROLE dis_replication WITH LOGIN REPLICATION PASSWORD {}").format(sql.Literal(password)))
            log("created replication role dis_replication")
        elif password is not None:
            c.execute(sql.SQL("ALTER ROLE dis_replication WITH LOGIN REPLICATION PASSWORD {}").format(sql.Literal(password)))
        c.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO dis_replication").format(sql.Identifier(a.source_database)))
        for sch in ("finance", "procurement", "quality"):
            c.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO dis_replication").format(sql.Identifier(sch)))
            c.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO dis_replication").format(sql.Identifier(sch)))
            c.execute(sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA {} GRANT SELECT ON TABLES TO dis_replication").format(sql.Identifier(sch)))
        tables = sql.SQL(", ").join(sql.SQL(".").join(map(sql.Identifier, t.split("."))) for t in SOURCE_TABLES)
        if c.execute("SELECT 1 FROM pg_publication WHERE pubname = 'dis_publication'").fetchone():
            c.execute(sql.SQL("ALTER PUBLICATION dis_publication SET TABLE {}").format(tables))
        else:
            c.execute(sql.SQL("CREATE PUBLICATION dis_publication FOR TABLE {}").format(tables))
        counts = {t: c.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(sql.SQL(".").join(map(sql.Identifier, t.split("."))))).fetchone()["n"]
                  for t in SOURCE_TABLES}
        log(f"source tables + publication dis_publication ready: {counts}")
    if password is None:
        try:
            import base64
            v = (api(w, "GET", f"/api/2.0/secrets/get?scope={scope}&key={key}") or {}).get("value")
            password = base64.b64decode(v).decode() if v else None
        except Exception as e:  # noqa: BLE001
            log(f"could not read the replication secret back ({type(e).__name__}); slot / connection step uses --rotate next time")
    if password:
        with psycopg.connect(host=host, port=5432, dbname=a.source_database, user="dis_replication", password=password,
                             sslmode="require", autocommit=True, row_factory=dict_row, connect_timeout=15) as rc:
            if not rc.execute("SELECT 1 FROM pg_replication_slots WHERE slot_name = 'dis_slot'").fetchone():
                rc.execute("SELECT pg_create_logical_replication_slot('dis_slot', 'pgoutput')")
                log("created logical replication slot dis_slot (pgoutput)")
            else:
                log("replication slot dis_slot exists")
    if sp:
        register_sp_role(w, a.source_project, sp)
        with connect(w, a.source_project, a.source_database) as c:
            c.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(a.source_database), sql.Identifier(sp)))
            for sch in ("finance", "procurement", "quality"):
                c.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(sch), sql.Identifier(sp)))
                c.execute(sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {} TO {}").format(sql.Identifier(sch), sql.Identifier(sp)))
        log("app SP can browse the source and write demo activity")
        api(w, "POST", "/api/2.0/secrets/acls/put", {"scope": scope, "principal": sp, "permission": "READ"})
        log(f"app SP READ on secret scope {scope}")

    # 5. The demo source in Unity Catalog ---------------------------------------------------------------------
    # (a) a database catalog over the source DB: always possible with CREATE CATALOG; Lakeflow Connect ingests it
    #     query-based (ingest_from_uc_foreign_catalog), the warehouse can browse / reconcile it.
    cat = a.source_catalog
    if not api(w, "GET", f"/api/2.1/unity-catalog/catalogs/{cat}", ok_codes=("NOT_FOUND", "does not exist", "CATALOG_DOES_NOT_EXIST")):
        api(w, "POST", f"/api/2.0/postgres/catalogs?catalog_id={cat}",
            {"spec": {"postgres_database": a.source_database, "branch": f"projects/{a.source_project}/branches/production"}})
        for _ in range(40):
            if api(w, "GET", f"/api/2.1/unity-catalog/catalogs/{cat}", ok_codes=("NOT_FOUND", "does not exist", "CATALOG_DOES_NOT_EXIST")):
                break
            time.sleep(5)
        log(f"registered the source database as UC catalog {cat}")
    if sp:
        meta = api(w, "GET", f"/api/2.1/unity-catalog/catalogs/{cat}") or {}
        if meta.get("owner") != sp:
            uc_grant(w, "catalog", cat, sp, ["USE_CATALOG", "USE_SCHEMA", "SELECT"])
            if a.source_owner_sp == "true":
                # headless source: the pipeline identity owns the source catalog, so no person keeps implicit access
                api(w, "PATCH", f"/api/2.1/unity-catalog/catalogs/{cat}", {"owner": sp})
                log(f"source catalog {cat}: owner is now the app service principal (people have no access)")
        else:
            log(f"source catalog {cat} is owned by the app service principal")
    # (b) optional: a POSTGRESQL connection enables log-based CDC through an ingestion gateway. Needs CREATE
    #     CONNECTION on the metastore; without it the service offers query-based ingestion for this source.
    if password:
        opts = {"host": host, "port": "5432", "user": "dis_replication", "password": password}
        try:
            existing = api(w, "GET", f"/api/2.1/unity-catalog/connections/{a.demo_connection}", ok_codes=("NOT_FOUND", "does not exist"))
            if existing:
                api(w, "PATCH", f"/api/2.1/unity-catalog/connections/{a.demo_connection}", {"options": opts})
                log(f"connection {a.demo_connection} updated (CDC enabled)")
            else:
                api(w, "POST", "/api/2.1/unity-catalog/connections", {"name": a.demo_connection, "connection_type": "POSTGRESQL", "options": opts,
                    "comment": "Data Ingestion Service demo ERP source (Lakebase Postgres, pgoutput logical replication)"})
                log(f"connection {a.demo_connection} created (CDC enabled)")
            if sp:
                uc_grant(w, "connection", a.demo_connection, sp, ["USE_CONNECTION"])
                log(f"app SP USE CONNECTION on {a.demo_connection}")
        except Exception as e:  # noqa: BLE001 - CDC stays off; everything else works
            log(f"CDC connection skipped: {type(e).__name__}: {' '.join(str(e).split())[:200]} "
                f"-> a metastore admin can grant CREATE CONNECTION (or create {a.demo_connection}) to enable log-based CDC")

    # 6. System tables (forecast training, cost MTD, usage rollups run as the deployer) ------------------------------
    for t in ("system.billing.usage", "system.billing.list_prices", "system.lakeflow.pipelines", "system.lakeflow.pipeline_update_timeline",
              "system.query.history"):
        try:
            from core import warehouse
            warehouse.query(f"SELECT 1 FROM {t} LIMIT 1", timeout=120)
            log(f"system table readable by the deployer: {t}")
        except Exception as e:  # noqa: BLE001
            log(f"system table NOT readable: {t} ({str(e)[:120]}) -> a metastore admin grants USE CATALOG system, USE SCHEMA, SELECT")

    # 7. Cluster creation for ingestion gateways ----------------------------------------------------------------
    if sp:
        try:
            res = api(w, "GET", f"/api/2.0/preview/scim/v2/ServicePrincipals?filter=applicationId%20eq%20%22{sp}%22") or {}
            sp_id = (res.get("Resources") or [{}])[0].get("id")
            if sp_id:
                api(w, "PATCH", f"/api/2.0/preview/scim/v2/ServicePrincipals/{sp_id}",
                    {"schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
                     "Operations": [{"op": "add", "path": "entitlements", "value": [{"value": "allow-cluster-create"}]}]})
                log("app SP may create clusters (ingestion gateways run on classic compute)")
        except Exception as e:  # noqa: BLE001 - needs a workspace admin; report, don't fail the rest
            log(f"could not grant allow-cluster-create ({type(e).__name__}: {str(e)[:160]}): CDC gateways will fail until an admin grants it")
    log("done")
    return 0


if __name__ == "__main__":
    rc = main()
    if rc:  # never sys.exit(0): the job runner (IPython) reports SystemExit(0) as a failure
        raise SystemExit(rc)
