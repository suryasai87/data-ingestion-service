"""Every UC connection type maps to a pattern, and every pattern produces a valid spec (generated code compiles)."""
import pytest

from modules.catalog import registry
from modules.deploy import specs
from modules.requests import rules

DROPDOWN = ["MYSQL", "POSTGRESQL", "SQLSERVER", "ORACLE", "TERADATA", "BIGQUERY", "SNOWFLAKE", "REDSHIFT", "SQLDW", "DATABRICKS",
            "SALESFORCE_DATA_CLOUD", "HIVE_METASTORE", "GLUE", "JDBC", "ICEBERG_REST", "PALANTIR", "SALESFORCE", "SERVICENOW",
            "WORKDAY_RAAS", "GA4_RAW_DATA", "CONFLUENCE", "JIRA", "HUBSPOT", "ZENDESK", "META_MARKETING", "TIKTOK_ADS", "GOOGLE_ADS",
            "NETSUITE", "DYNAMICS365", "SMARTSHEET", "OUTLOOK", "SLACK", "GITHUB", "OKTA_SYSTEM_LOGS", "AKAMAI_WAF", "GOOGLE_DRIVE",
            "SHAREPOINT", "API_SOURCE", "COMMUNITY", "GENERIC_LAKEFLOW_CONNECT", "SFTP", "HTTP", "KAFKA", "RABBITMQ", "MANAGED_POSTGRESQL",
            "POWER_BI", "AWS_SECRETS_MANAGER", "DATABRICKS_DR"]


def test_every_dropdown_type_is_classified():
    types = {t["connection_type"]: t for t in registry.connection_types()}
    missing = [t for t in DROPDOWN if t not in types]
    assert not missing, missing
    assert types["POWER_BI"]["status"] == "not_a_source" and types["SFTP"]["patterns"] == ["files"] and types["HTTP"]["patterns"] == ["api"]


def base(connector, pattern, objects, **src):
    return rules.normalize({"title": "t", "source": {"connector": connector, "pattern": pattern, "connection": "conn_x", **src},
                            "objects": objects, "destination": {"environment": "dev", "catalog": "cat", "schema": "foundation_dev"},
                            "schedule": {"mode": "interval", "interval_minutes": 60, "sla_minutes": 120},
                            "ownership": {"owner": "o@x.com", "classification": "internal"}})


def build(cfg):
    return specs.build("IR-9", cfg, registry.get(cfg["source"]["connector"]), staging_catalog="cat", staging_schema="stg",
                       event_log_catalog="cat", event_log_schema="svc", source_dir="/Workspace/Users/sp/dis")


def test_federation_reads_the_foreign_catalog():
    c = base("snowflake", "federation", [{"schema": "sales", "table": "orders", "primary_keys": ["id"], "cursor_column": "updated_at"}],
             foreign_catalog="snow_fc")
    ing = build(c)["ingestion"]["ingestion_definition"]
    assert ing["ingest_from_uc_foreign_catalog"] and ing["objects"][0]["table"]["source_catalog"] == "snow_fc"
    assert ing["objects"][0]["table"]["table_configuration"]["query_based_connector_config"]["cursor_columns"] == ["updated_at"]
    no_fc = base("snowflake", "federation", [{"schema": "s", "table": "t", "primary_keys": ["id"], "cursor_column": "u"}])
    ch = {x.key: x.status for x in rules.evaluate(no_fc, {**registry.get("snowflake"), "enabled": True}, {}, [{"environment": "dev", "catalog": "cat", "schema": "foundation_dev"}])}
    assert ch["source.foreign_catalog"] == "fail"


def test_sftp_generates_auto_loader_code_that_compiles():
    c = base("sftp", "files", [{"schema": "files", "table": "vendor_invoices", "options": {"path": "/outbound/invoices/*.csv", "format": "csv"}}],
             endpoint={"host": "sftp.example.com", "port": "22", "user": "ingest"})
    p = build(c)
    code = p["source_code"]
    compile(code, "gen.py", "exec")
    assert "sftp://ingest@sftp.example.com:22/outbound/invoices/*.csv" in code and "'databricks.connection': 'conn_x'" in code
    assert p["ingestion"]["libraries"] == [{"file": {"path": "/Workspace/Users/sp/dis/ir_9_v1.py"}}] and p["job"]["schedule"]


def test_volume_files_need_no_connection():
    c = base("volume", "files", [{"schema": "files", "table": "lab_results", "options": {"path": "/Volumes/cat/landing/drop/lab/", "format": "json"}}])
    code = build(c)["source_code"]
    compile(code, "gen.py", "exec")
    assert "'/Volumes/cat/landing/drop/lab/'" in code and "databricks.connection" not in code


def test_api_generates_a_pipeline_over_the_http_connection():
    c = base("http", "api", [{"schema": "api", "table": "forecast_nyc",
                              "options": {"path": "/v1/forecast", "params": {"latitude": "40.71", "longitude": "-74.01"}}}])
    p = build(c)
    compile(p["source_code"], "gen.py", "exec")
    assert "http_request" in p["source_code"] and "'/v1/forecast'" in p["source_code"]
    assert p["ingestion"]["environment"]["dependencies"]


def test_kafka_managed_connector_spec():
    c = base("kafka", "stream", [{"schema": "kafka", "table": "orders_raw", "options": {"topic": "orders", "value_format": "avro"}}])
    p = build(c)["ingestion"]
    t = p["ingestion_definition"]["objects"][0]["table"]
    assert p["continuous"] is True and p["channel"] == "PREVIEW"
    assert t["connector_options"]["kafka_options"]["topics"] == ["orders"] and t["connector_options"]["kafka_options"]["value_transformer"]["format"] == "AVRO"


def test_api_source_and_community_templates():
    a = build(base("api_source", "saas", [{"schema": "boards", "table": "items", "options": {"board_id": "123"}}], options={"source_name": "monday_com"}))
    ing = a["ingestion"]["ingestion_definition"]
    assert ing["source_configurations"][0]["api_source_connector_config"]["configs"] == {"source_name": "monday_com"}
    assert ing["objects"][0]["table"]["connector_options"]["api_source_connector_options"]["options"] == {"board_id": "123"}
    cm = build(base("community", "community", [{"schema": "x", "table": "y"}], options={"wheel": "/Volumes/c/s/w/connector.whl"}))["ingestion"]
    assert cm["ingestion_definition"]["source_type"] == "COMMUNITY" and cm["environment"]["dependencies"] == ["/Volumes/c/s/w/connector.whl"]


@pytest.mark.parametrize("pattern,need", [("files", "path"), ("api", "path"), ("stream", "topic")])
def test_pattern_specific_checks(pattern, need):
    connector = {"files": "sftp", "api": "http", "stream": "kafka"}[pattern]
    c = base(connector, pattern, [{"schema": "x", "table": "y"}])
    ch = {x.key: x.status for x in rules.evaluate(c, {**registry.get(connector), "enabled": True}, {}, [{"environment": "dev", "catalog": "cat", "schema": "foundation_dev"}])}
    assert ch[f"schema.{need}"] == "fail"


def test_connection_types_endpoint(client):
    r = client.get("/api/connection-types").json()
    assert len(r["items"]) >= 48


def test_volume_source_needs_no_connection():
    c = base("volume", "files", [{"schema": "files", "table": "lab", "options": {"path": "/Volumes/c/s/v/lab/", "format": "csv"}}], connection=None)
    c["source"]["connection"] = None
    ch = {x.key: x.status for x in rules.evaluate(c, {**registry.get("volume"), "enabled": True}, {}, [{"environment": "dev", "catalog": "cat", "schema": "foundation_dev"}])}
    assert ch["config.complete"] == "pass"
