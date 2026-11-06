"""Runtime configuration: every per-workspace value comes from the environment (bundle `config.env`), never code."""
from __future__ import annotations

import json
import os


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _str(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return default if v is None or v.strip() in ("", "none", "None") else v.strip()


OFFLINE = _bool("DIS_OFFLINE", False)              # unit tests / offline dev: no Databricks calls at all
BRAND = _str("DIS_BRAND", "databricks")         # brand pack key (branding/<key>/brand.json)
IDENTITY_MODE = _str("IDENTITY_MODE", "apps")      # apps = X-Forwarded-* headers; header = dev proxy; fixed = DEV_USER
DEV_USER = _str("DEV_USER", "")

# Lakebase (the service's transactional store)
LAKEBASE_ENDPOINT = _str("LAKEBASE_ENDPOINT")      # projects/<p>/branches/<b>/endpoints/<e>
LAKEBASE_DATABASE = _str("LAKEBASE_DATABASE", "databricks_postgres")
LAKEBASE_SCHEMA = _str("LAKEBASE_SCHEMA", "ingest")
LAKEBASE_URL = _str("LAKEBASE_URL")                # static DSN for local dev/tests
LAKEBASE_POOL_MAX = int(_str("LAKEBASE_POOL_MAX", "8"))

# Lakehouse
WAREHOUSE_ID = _str("WAREHOUSE_ID")
UC_CATALOG = _str("UC_CATALOG")                    # history / gold / mirror tables live in UC_CATALOG.UC_SCHEMA
UC_SCHEMA = _str("UC_SCHEMA", "data_ingestion_service")
GATEWAY_STORAGE_SCHEMA = _str("GATEWAY_STORAGE_SCHEMA", "dis_gateway_staging")
# Destinations ("Foundation" per environment); policy rows in Lakebase override these defaults.
DESTINATIONS = json.loads(_str("DESTINATIONS_JSON", "[]") or "[]")

# AI
LLM_ENDPOINT = _str("LLM_ENDPOINT", "databricks-claude-sonnet-5")  # Claude 5 rejects `temperature`: never send it

# Governance / safety
PLATFORM_ADMINS = [e.strip().lower() for e in _str("PLATFORM_ADMINS").split(",") if e.strip() and e.strip().lower() != "none"]
ALLOW_MUTATIONS = _bool("ALLOW_MUTATIONS", True)   # false = read-only kiosk: every governed write answers 503
ALLOW_DEPLOY = _bool("ALLOW_DEPLOY", True)         # false = approvals still work, deploy stops at the dry run
GATEWAY_NODE_TYPE = "" if _str("GATEWAY_NODE_TYPE", "auto") == "auto" else _str("GATEWAY_NODE_TYPE")  # auto = platform default
APP_NAME = _str("DATABRICKS_APP_NAME", _str("APP_NAME", "data-ingestion-service"))

# Jobs and demo source (links in "Where it runs", demo connection preselected in the wizard)
SETUP_JOB_ID = _str("SETUP_JOB_ID")
HISTORY_JOB_ID = _str("HISTORY_JOB_ID")
GUARDIAN_JOB_ID = _str("GUARDIAN_JOB_ID")
SOURCE_ACTIVITY_JOB_ID = _str("SOURCE_ACTIVITY_JOB_ID")
DEMO_CONNECTION = _str("DEMO_CONNECTION")          # optional POSTGRESQL UC connection to the demo source (enables CDC)
DEMO_SOURCE_CATALOG = _str("DEMO_SOURCE_CATALOG")  # the demo source registered as a UC database catalog (query-based)
DEMO_SOURCE_PROJECT = _str("DEMO_SOURCE_PROJECT")
DEMO_SOURCE_ENDPOINT = _str("DEMO_SOURCE_ENDPOINT")   # projects/<p>/branches/<b>/endpoints/<e> of the demo source
DEMO_SOURCE_DATABASE = _str("DEMO_SOURCE_DATABASE", "erp")
DEMO_REPLICATION_PASSWORD = os.environ.get("DEMO_REPLICATION_PASSWORD", "")  # app secret resource; never logged
MLFLOW_EXPERIMENT = _str("MLFLOW_EXPERIMENT")

# ServiceNow (modules/itsm): SNOW_MODE=rest|simulator, SNOW_INSTANCE, credentials via app secret resources
ITSM_ENABLED = _bool("ITSM_ENABLED", True)
ITSM_ASYNC = _bool("ITSM_ASYNC", True)

# OpenTelemetry + per-user usage (modules/usage)
USAGE_CAPTURE = _bool("USAGE_CAPTURE", True)
OTEL_SERVICE_NAME = _str("OTEL_SERVICE_NAME", "data-ingestion-service")

VERSION = _str("DIS_VERSION", "0.2.0")


def host() -> str:
    h = _str("DATABRICKS_HOST")
    if h and not h.startswith("http"):
        h = "https://" + h
    return h.rstrip("/")


def uc(table: str) -> str:
    """Fully qualified UC name of one of the service's lakehouse tables."""
    return f"`{UC_CATALOG}`.`{UC_SCHEMA}`.`{table}`"
