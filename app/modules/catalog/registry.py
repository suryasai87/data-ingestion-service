"""The governed connector catalog: which Lakeflow Connect sources the service offers, with which patterns.

Release states are as verified on docs.databricks.com on 2026-10-31 (docs/RESEARCH.md). `status`:
- supported  GA in Lakeflow Connect and wired end to end in this service
- preview    Public Preview / Beta in Lakeflow Connect (may need enrolment); offered with a badge
- extension  not a Lakeflow Connect managed connector: the platform team adds a reusable extension first

`cdc_architecture`: "gateway" = an always-on ingestion gateway on classic compute + a serverless ingestion pipeline;
"integrated" = one serverless pipeline that reads the change log itself (connector_type CDC, no gateway).
Admins can switch a connector off in the app (connector_override); nothing here is per-workspace.
"""
from __future__ import annotations

from typing import Any

DB_CAPS = {"hard_deletes": True, "scd2": True, "min_interval_minutes": 5, "needs_gateway": True, "incremental": True}

CONNECTORS: list[dict[str, Any]] = [
    # --- databases -------------------------------------------------------------------------------------------------
    {"id": "sqlserver", "name": "SQL Server", "category": "database", "patterns": ["cdc", "query"], "status": "supported",
     "connection_type": "SQLSERVER", "cdc_architecture": "gateway", "capabilities": DB_CAPS,
     "description": "Change tracking / CDC through an ingestion gateway (GA). Azure SQL, RDS and on-prem."},
    {"id": "postgresql", "name": "PostgreSQL", "category": "database", "patterns": ["cdc", "query"], "status": "supported",
     "connection_type": "POSTGRESQL", "cdc_architecture": "gateway", "capabilities": DB_CAPS,
     "description": "Logical replication (pgoutput) through an ingestion gateway, or cursor-based queries. CDC is in Public Preview."},
    {"id": "mysql", "name": "MySQL", "category": "database", "patterns": ["cdc", "query"], "status": "supported",
     "connection_type": "MYSQL", "cdc_architecture": "integrated",
     "capabilities": {**DB_CAPS, "needs_gateway": False, "min_interval_minutes": 15},
     "description": "Integrated binlog CDC in one serverless pipeline (GA), or cursor-based queries."},
    {"id": "oracle", "name": "Oracle", "category": "database", "patterns": ["cdc", "query"], "status": "preview",
     "connection_type": "ORACLE", "cdc_architecture": "integrated",
     "capabilities": {**DB_CAPS, "needs_gateway": False, "min_interval_minutes": 15},
     "description": "Integrated CDC (Beta, PREVIEW channel) or cursor-based queries (GA)."},
    {"id": "teradata", "name": "Teradata", "category": "database", "patterns": ["query"], "status": "supported",
     "connection_type": "TERADATA", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": True, "min_interval_minutes": 15, "needs_gateway": False, "incremental": True},
     "description": "Query-based incremental reads on a cursor column (GA)."},
    {"id": "sap", "name": "SAP (S/4HANA, ECC, BW)", "category": "database", "patterns": ["saas"], "status": "extension",
     "connection_type": None, "cdc_architecture": None,
     "capabilities": {"hard_deletes": True, "scd2": False, "min_interval_minutes": 15, "needs_gateway": False, "incremental": True},
     "description": "SAP data products are shared zero-copy through SAP Business Data Cloud (OpenSharing), not a Lakeflow Connect pipeline. The platform team onboards them as an extension."},
    # --- SaaS applications ---------------------------------------------------------------------------------------
    {"id": "salesforce", "name": "Salesforce", "category": "saas", "patterns": ["saas"], "status": "supported",
     "connection_type": "SALESFORCE", "cdc_architecture": None,
     "capabilities": {"hard_deletes": True, "scd2": True, "min_interval_minutes": 15, "needs_gateway": False, "incremental": True},
     "description": "Sales Cloud objects with incremental cursor sync and formula fields (GA)."},
    {"id": "servicenow", "name": "ServiceNow", "category": "saas", "patterns": ["saas"], "status": "supported",
     "connection_type": "SERVICENOW", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": True, "min_interval_minutes": 15, "needs_gateway": False, "incremental": True},
     "description": "Incidents, CMDB and any table via the Table API (GA)."},
    {"id": "workday", "name": "Workday Reports", "category": "saas", "patterns": ["saas"], "status": "supported",
     "connection_type": "WORKDAY_RAAS", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": True, "min_interval_minutes": 60, "needs_gateway": False, "incremental": False},
     "description": "Reports-as-a-Service extracts (GA). Workday HCM objects are in Beta."},
    {"id": "dynamics365", "name": "Dynamics 365", "category": "saas", "patterns": ["saas"], "status": "supported",
     "connection_type": "DYNAMICS365", "cdc_architecture": None,
     "capabilities": {"hard_deletes": True, "scd2": True, "min_interval_minutes": 15, "needs_gateway": False, "incremental": True},
     "description": "Dataverse tables via Azure Synapse Link (GA)."},
    {"id": "netsuite", "name": "NetSuite", "category": "saas", "patterns": ["saas"], "status": "supported",
     "connection_type": "NETSUITE", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": True, "min_interval_minutes": 60, "needs_gateway": False, "incremental": True},
     "description": "SuiteAnalytics records (GA)."},
    {"id": "ga4", "name": "Google Analytics 4", "category": "saas", "patterns": ["saas"], "status": "supported",
     "connection_type": "GA4_RAW_DATA", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": False, "min_interval_minutes": 60, "needs_gateway": False, "incremental": True},
     "description": "Raw event export from BigQuery (GA)."},
    {"id": "jira", "name": "Jira", "category": "saas", "patterns": ["saas"], "status": "preview",
     "connection_type": "JIRA", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": True, "min_interval_minutes": 60, "needs_gateway": False, "incremental": True},
     "description": "Issues, projects and changelogs (Beta, OAuth sign-in by a user)."},
    {"id": "veeva", "name": "Veeva Vault", "category": "saas", "patterns": ["saas"], "status": "preview",
     "connection_type": "VEEVA_VAULT", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": True, "min_interval_minutes": 60, "needs_gateway": False, "incremental": True},
     "description": "Vault objects and document metadata (Beta)."},
    # --- files ---------------------------------------------------------------------------------------------------
    {"id": "sharepoint", "name": "SharePoint", "category": "files", "patterns": ["files"], "status": "supported",
     "connection_type": "SHAREPOINT", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": False, "min_interval_minutes": 60, "needs_gateway": False, "incremental": True},
     "description": "Documents and lists, incrementally (GA)."},
    {"id": "google_drive", "name": "Google Drive", "category": "files", "patterns": ["files"], "status": "supported",
     "connection_type": "GOOGLE_DRIVE", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": False, "min_interval_minutes": 60, "needs_gateway": False, "incremental": True},
     "description": "Files and Sheets, incrementally (GA)."},
    {"id": "sftp", "name": "SFTP", "category": "files", "patterns": ["files"], "status": "preview",
     "connection_type": "SFTP", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": False, "min_interval_minutes": 15, "needs_gateway": False, "incremental": True},
     "description": "Auto Loader over SFTP: new files picked up exactly once (Public Preview)."},
    # --- streaming -----------------------------------------------------------------------------------------------
    {"id": "kafka", "name": "Kafka", "category": "streaming", "patterns": ["stream"], "status": "preview",
     "connection_type": "KAFKA", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": False, "min_interval_minutes": 1, "needs_gateway": False, "incremental": True},
     "description": "Topics into streaming tables (Beta)."},
    {"id": "zerobus", "name": "Zerobus (push API)", "category": "streaming", "patterns": ["stream"], "status": "extension",
     "connection_type": None, "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": False, "min_interval_minutes": 1, "needs_gateway": False, "incremental": True},
     "description": "Applications push records straight into Delta over gRPC; onboarded per producer by the platform team."},
]


SAAS_CAPS = {"hard_deletes": False, "scd2": True, "min_interval_minutes": 60, "needs_gateway": False, "incremental": True}
FED_CAPS = {"hard_deletes": False, "scd2": True, "min_interval_minutes": 15, "needs_gateway": False, "incremental": True}


def _saas(cid: str, name: str, ctype: str, status: str, desc: str, **caps: Any) -> dict[str, Any]:
    return {"id": cid, "name": name, "category": "saas", "patterns": ["saas"], "status": status, "connection_type": ctype,
            "cdc_architecture": None, "capabilities": {**SAAS_CAPS, **caps}, "description": desc}


def _fed(cid: str, name: str, ctype: str, desc: str) -> dict[str, Any]:
    return {"id": cid, "name": name, "category": "warehouse", "patterns": ["federation"], "status": "supported", "connection_type": ctype,
            "cdc_architecture": None, "capabilities": FED_CAPS,
            "description": desc + " Ingested query-based from its Lakehouse Federation foreign catalog (one cursor column per table)."}


# Every connection type in the Unity Catalog "Create connection" dropdown (2026-11), mapped to how it is ingested.
CONNECTORS += [
    _saas("zendesk", "Zendesk", "ZENDESK", "supported", "Tickets, users and organizations, incrementally (GA)."),
    _saas("hubspot", "HubSpot", "HUBSPOT", "supported", "CRM objects, incrementally (GA)."),
    _saas("confluence", "Confluence", "CONFLUENCE", "supported", "Spaces, pages and attachments metadata (GA)."),
    _saas("github", "GitHub", "GITHUB", "preview", "Repositories, issues, pull requests (Beta)."),
    _saas("slack", "Slack", "SLACK", "preview", "Channels and messages (Beta)."),
    _saas("outlook", "Outlook", "OUTLOOK", "preview", "Mail and calendar (Beta)."),
    _saas("google_ads", "Google Ads", "GOOGLE_ADS", "preview", "Campaign performance (Beta)."),
    _saas("meta_marketing", "Meta Ads", "META_MARKETING", "preview", "Ad insights (Beta)."),
    _saas("tiktok_ads", "TikTok Ads", "TIKTOK_ADS", "preview", "Ad insights (Beta)."),
    _saas("smartsheet", "Smartsheet", "SMARTSHEET", "preview", "Sheets and rows (Beta)."),
    _saas("okta", "Okta system logs", "OKTA_SYSTEM_LOGS", "preview", "Okta system log events (Beta)."),
    _saas("akamai", "Akamai WAF", "AKAMAI_WAF", "preview", "Akamai security events (Beta)."),
    _saas("api_source", "Databricks API connector", "API_SOURCE", "preview",
          "Databricks-built API connectors on the generic API framework (e.g. Monday.com), Beta; source options per connector."),
    {"id": "community", "name": "Community / custom connector", "category": "saas", "patterns": ["community"], "status": "extension",
     "connection_type": "COMMUNITY", "cdc_architecture": None, "capabilities": SAAS_CAPS,
     "description": "Lakeflow community connectors (Python Data Source interface, Beta): the platform team publishes the connector wheel once; requests then reuse it."},
    _fed("snowflake", "Snowflake", "SNOWFLAKE", "Snowflake warehouse."),
    _fed("redshift", "Amazon Redshift", "REDSHIFT", "Redshift cluster or serverless."),
    _fed("bigquery", "Google BigQuery", "BIGQUERY", "BigQuery datasets."),
    _fed("synapse", "Azure Synapse", "SQLDW", "Synapse dedicated SQL pool."),
    _fed("databricks", "Databricks (another workspace)", "DATABRICKS", "Tables in another Databricks workspace or metastore."),
    _fed("salesforce_data_cloud", "Salesforce Data Cloud", "SALESFORCE_DATA_CLOUD", "Data Cloud objects."),
    _fed("hive_metastore", "Hive metastore", "HIVE_METASTORE", "Legacy Hive metastore tables (catalog federation)."),
    _fed("glue", "AWS Glue", "GLUE", "Glue Data Catalog tables (catalog federation)."),
    _fed("jdbc", "JDBC (generic)", "JDBC", "Any JDBC source registered for federation."),
    _fed("iceberg_rest", "Iceberg REST catalog", "ICEBERG_REST", "Iceberg tables from a REST catalog (catalog federation)."),
    _fed("palantir", "Palantir Foundry", "PALANTIR", "Foundry datasets (federation)."),
    {"id": "lakebase", "name": "Lakebase Postgres", "category": "database", "patterns": ["query"], "status": "supported",
     "connection_type": "MANAGED_POSTGRESQL", "cdc_architecture": None,
     "capabilities": {**FED_CAPS, "hard_deletes": True},
     "description": "A Lakebase database registered in Unity Catalog (database catalog), ingested query-based; verified live."},
    {"id": "http", "name": "REST API (HTTP connection)", "category": "api", "patterns": ["api"], "status": "supported",
     "connection_type": "HTTP", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": False, "min_interval_minutes": 15, "needs_gateway": False, "incremental": False},
     "description": "Any REST API behind a Unity Catalog HTTP connection (bearer / OAuth); a serverless pipeline calls it each run and lands the JSON response (payload VARIANT) in bronze."},
    {"id": "volume", "name": "Unity Catalog volume (file drop)", "category": "files", "patterns": ["files"], "status": "supported",
     "connection_type": None, "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": False, "min_interval_minutes": 5, "needs_gateway": False, "incremental": True},
     "description": "Files dropped into a UC volume (CSV, JSON, Parquet, Avro, XML), picked up exactly once by Auto Loader."},
    {"id": "rabbitmq", "name": "RabbitMQ", "category": "streaming", "patterns": ["stream"], "status": "extension",
     "connection_type": "RABBITMQ", "cdc_architecture": None,
     "capabilities": {"hard_deletes": False, "scd2": False, "min_interval_minutes": 1, "needs_gateway": False, "incremental": True},
     "description": "RabbitMQ queues (Beta in Lakeflow Connect); onboarded as an extension until its spec is published."},
]
for _c in CONNECTORS:
    if _c["id"] == "sftp":
        _c.update({"status": "supported", "description": "Files on an SFTP server through a UC SFTP connection (password or private key): Auto Loader over sftp://, exactly once."})
    if _c["id"] == "kafka":
        _c.update({"status": "preview", "description": "Kafka topics through the managed Kafka connector (Beta, continuous, PREVIEW channel; admin enables it in Previews)."})

# Connection types that are NOT ingestion sources (listed so the matrix covers the whole dropdown)
NOT_SOURCES = {"POWER_BI": "publishes to Power BI", "AWS_SECRETS_MANAGER": "credential store", "AZURE_KEY_VAULT": "credential store",
               "DATABRICKS_DR": "disaster-recovery replication", "GENERIC_LAKEFLOW_CONNECT": "older community-connector type (use COMMUNITY)"}

BY_ID = {c["id"]: c for c in CONNECTORS}
# connection_type -> connector id (UC connections list)
BY_CONNECTION_TYPE = {c["connection_type"]: c["id"] for c in CONNECTORS if c["connection_type"]}
BY_CONNECTION_TYPE["GENERIC_LAKEFLOW_CONNECT"] = "community"


def connection_types() -> list[dict[str, Any]]:
    """The whole UC connection-type matrix: how each type is ingested (or why it is not a source)."""
    out = [{"connection_type": c["connection_type"], "connector": c["id"], "name": c["name"], "category": c["category"],
            "patterns": c["patterns"], "status": c["status"]} for c in CONNECTORS if c["connection_type"]]
    out += [{"connection_type": t, "connector": None, "name": t.replace("_", " ").title(), "category": "not_a_source",
             "patterns": [], "status": "not_a_source", "note": why} for t, why in NOT_SOURCES.items() if t not in BY_CONNECTION_TYPE or t == "GENERIC_LAKEFLOW_CONNECT"]
    return sorted(out, key=lambda x: (x["category"], x["connection_type"]))


def get(connector_id: str) -> dict[str, Any] | None:
    return BY_ID.get(connector_id)


def meta_for_forecast(connector_id: str) -> dict[str, Any]:
    c = BY_ID.get(connector_id) or {}
    return {"patterns": c.get("patterns", []), "cdc_architecture": c.get("cdc_architecture"),
            "min_interval_minutes": (c.get("capabilities") or {}).get("min_interval_minutes", 5)}
