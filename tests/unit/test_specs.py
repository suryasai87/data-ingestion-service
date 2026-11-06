"""Spec builders: the exact Lakeflow Connect payloads (shapes verified against the docs + SDK, 2026-10-31)."""
from modules.catalog import registry
from modules.deploy import specs
from modules.requests import rules


def cfg(connector="postgresql", pattern="cdc", mode="interval", scd="SCD_TYPE_1", cursor=None):
    return rules.normalize({
        "title": "Finance journals", "source": {"connector": connector, "pattern": pattern, "connection": "conn_a", "database": "erp"},
        "objects": [{"schema": "finance", "table": "journal_header", "primary_keys": ["doc_id"], "cursor_column": cursor}],
        "schema": {"scd_type": scd}, "destination": {"environment": "dev", "catalog": "cat", "schema": "foundation_dev"},
        "schedule": {"mode": mode, "interval_minutes": 15, "sla_minutes": 30},
        "ownership": {"owner": "o@x.com", "classification": "confidential", "domain": "finance", "cost_center": "CC-1"},
    })


def build(c, **kw):
    return specs.build("IR-1001", c, registry.get(c["source"]["connector"]), staging_catalog="cat", staging_schema="stg",
                       event_log_catalog="cat", event_log_schema="svc", **kw)


def test_postgres_gateway_cdc():
    p = build(cfg(), slot={"slot_name": "dis_slot", "publication_name": "dis_publication"})
    gd = p["gateway"]["gateway_definition"]
    assert gd["connection_name"] == "conn_a" and gd["gateway_storage_catalog"] == "cat" and gd["gateway_storage_schema"] == "stg"
    ing = p["ingestion"]["ingestion_definition"]
    assert ing["ingestion_gateway_id"] == "${gateway.pipeline_id}"
    t = ing["objects"][0]["table"]
    assert (t["source_catalog"], t["source_schema"], t["source_table"]) == ("erp", "finance", "journal_header")
    assert t["table_configuration"] == {"scd_type": "SCD_TYPE_1", "primary_keys": ["doc_id"]}
    assert ing["source_configurations"][0]["catalog"]["postgres"]["slot_config"] == {"slot_name": "dis_slot", "publication_name": "dis_publication"}
    assert p["ingestion"]["serverless"] is True and p["ingestion"]["event_log"]["name"] == "dis_event_log_ir_1001"
    assert p["ingestion"]["tags"]["dis_request"] == "IR-1001" and p["ingestion"]["tags"]["dis_classification"] == "confidential"


def test_existing_gateway_is_reused():
    p = build(cfg(), gateway_id="gw-123")
    assert p["gateway"] is None
    assert p["ingestion"]["ingestion_definition"]["ingestion_gateway_id"] == "gw-123"


def test_integrated_cdc_sets_connector_type_and_staging():
    p = build(cfg(connector="mysql"))
    ing = p["ingestion"]["ingestion_definition"]
    assert p["gateway"] is None and ing["connector_type"] == "CDC" and ing["connection_name"] == "conn_a"
    assert ing["data_staging_options"] == {"catalog_name": "cat", "schema_name": "stg"}


def test_oracle_needs_preview_channel():
    assert build(cfg(connector="oracle"))["ingestion"]["channel"] == "PREVIEW"


def test_query_based_cursor_and_hard_delete_sync_only_scd1():
    p = build(cfg(pattern="query", cursor="updated_at"))
    tc = p["ingestion"]["ingestion_definition"]["objects"][0]["table"]["table_configuration"]
    assert p["ingestion"]["ingestion_definition"]["connector_type"] == "QUERY_BASED"
    assert tc["query_based_connector_config"]["cursor_columns"] == ["updated_at"]
    assert tc["query_based_connector_config"]["hard_deletion_sync_min_interval_in_seconds"] == 86400
    p2 = build(cfg(pattern="query", cursor="updated_at", scd="SCD_TYPE_2"))
    tc2 = p2["ingestion"]["ingestion_definition"]["objects"][0]["table"]["table_configuration"]
    assert "hard_deletion_sync_min_interval_in_seconds" not in tc2["query_based_connector_config"]


def test_saas_has_no_source_catalog():
    c = cfg(connector="salesforce", pattern="saas")
    t = build(c)["ingestion"]["ingestion_definition"]["objects"][0]["table"]
    assert "source_catalog" not in t and "connector_type" not in build(c)["ingestion"]["ingestion_definition"]


def test_schedule_job_and_continuous():
    p = build(cfg())
    assert p["job"]["schedule"]["quartz_cron_expression"] == "0 0/15 * * * ?"
    assert p["job"]["tasks"][0]["max_retries"] == 3
    assert build(cfg(mode="continuous"))["job"] is None
    assert build(cfg(mode="continuous"))["ingestion"]["continuous"] is True


def test_quartz():
    assert specs.quartz(5) == "0 0/5 * * * ?"
    assert specs.quartz(240) == "0 0 0/4 * * ?"
    assert specs.quartz(1440) == "0 0 2 * * ?"


def test_bundle_yaml_links_resources():
    y = specs.bundle_yaml("IR-1001", build(cfg()))
    assert "resources:" in y and "ir_1001_gateway:" in y and "ir_1001_ingestion:" in y and "ir_1001_schedule:" in y
    assert "${resources.pipelines.ir_1001_gateway.id}" in y and "${resources.pipelines.ir_1001_ingestion.id}" in y


def test_config_hash_is_stable_and_sensitive():
    a, b = cfg(), cfg()
    assert specs.config_hash(a) == specs.config_hash(b)
    b["schedule"]["interval_minutes"] = 30
    assert specs.config_hash(a) != specs.config_hash(b)


def test_query_based_from_uc_catalog():
    c = cfg(pattern="query", cursor="updated_at")
    c["source"].update({"connection": "dis_erp_source", "via": "uc_catalog"})
    ing = build(c)["ingestion"]["ingestion_definition"]
    assert ing["ingest_from_uc_foreign_catalog"] is True and "connection_name" not in ing
    assert ing["objects"][0]["table"]["source_catalog"] == "dis_erp_source"
