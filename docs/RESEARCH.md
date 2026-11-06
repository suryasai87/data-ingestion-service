# Verified platform facts (2026-10-31)

What the service relies on, how it was checked, and what was found live in `your-workspace`. Re-verify before
reusing elsewhere: Lakeflow Connect ships monthly.

## Lakeflow Connect

| Fact | Source |
|---|---|
| SQL Server CDC GA (Aug 2025); PostgreSQL CDC Public Preview (Dec 2025, enrolment); MySQL integrated CDC GA (Oct 2026); Oracle integrated CDC Beta (`channel: PREVIEW`); query-based connectors GA (May 2026) | docs release notes 2025/2026 |
| Gateway CDC = an ingestion **gateway** pipeline (`gateway_definition`: connection_name, gateway_storage_catalog/schema/name; classic compute, always on, ≥ 8 cores) + a serverless **ingestion** pipeline (`ingestion_definition.ingestion_gateway_id`) | docs + databricks-sdk 0.158 |
| PostgreSQL adds `source_configurations[].catalog.postgres.slot_config{slot_name, publication_name}`; one publication + one slot per database; pgoutput only; slots are not dropped with the pipeline | docs `postgresql-*` |
| Integrated CDC (MySQL / Oracle / SQL Server behind a flag): one pipeline, `connection_name` + `connector_type: CDC` + `data_staging_options`. A database connection **without** `connector_type` defaults to QUERY_BASED | SDK docstring |
| Query-based: one cursor column per table (`query_based_connector_config.cursor_columns`), hard-delete sync (Beta) only with SCD 1; from a UC catalog: `ingest_from_uc_foreign_catalog: true`, no connection_name | docs |
| `pipelines.create(dry_run=true)` **rejects ingestion pipelines** ("libraries must contain at least one element") | **live**, 3 shapes tried |
| A **validate-only update** (`POST /pipelines/{id}/updates {"validate_only": true}`) validates an ingestion pipeline end to end | **live**: query-based from a Lakebase database catalog COMPLETED |
| A MANAGED_POSTGRESQL connection (a Lakebase database catalog) is refused by query-based ("not supported for query based connector") and by a gateway ("Ingestion source 'MANAGED_POSTGRESQL' is not supported in your workspace. Please contact Databricks support") | **live** |
| Creating a POSTGRESQL connection needs CREATE CONNECTION on the metastore (the deployer here has CREATE CATALOG only) | **live** |
| SAP: no Lakeflow Connect connector; SAP data products come zero-copy through SAP Business Data Cloud (OpenSharing) | docs |

## Lakebase as a source

Lakebase runs `wal_level=logical`; password login is off by default (`enable_pg_native_login`); SQL-created roles
need `WITH LOGIN REPLICATION`; `CREATE PUBLICATION` needs `databricks_superuser`; an idle replication slot is removed
after about 40 h (the app recreates it before a gateway starts). Lakebase is **not** a documented Lakeflow Connect CDC
source. Its native path to Delta is Lakebase Change Data Feed. The demo uses Lakebase only as a stand-in ERP.

## Pricing (AWS list, used by the forecast)

| SKU | $/DBU | Used for |
|---|---|---|
| `ENTERPRISE_JOBS_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA` | 0.45 | managed ingestion pipelines |
| `ENTERPRISE_DLT_ADVANCED_COMPUTE` | 0.36 | the gateway (plus the cloud VM bill) |
| `LAKEFLOW_CONNECT_FREE_USAGE` | 0 | 100 DBU / day / workspace free tier |

The history job reads the live prices from `system.billing.list_prices` on every run.

## System tables (the training data)

- `system.lakeflow.pipelines`: pipeline_type `INGESTION_PIPELINE` / `INGESTION_GATEWAY`, settings (serverless,
  continuous), configuration, tags. SCD-style: take the latest row per pipeline_id. No source or connection column, so
  the connector family is inferred from the pipeline name.
- `system.lakeflow.pipeline_update_timeline`: hourly slices per update. The job reassembles them per update_id
  (min start, max end, last result_state).
- `system.billing.usage`: `billing_origin_product = 'LAKEFLOW_CONNECT'`, joined on `usage_metadata.dlt_pipeline_id`;
  pipeline tags arrive as `custom_tags` (the guardian books cost per request through `dis_request`).

## What the history showed (account-wide, 365 days)

- 961 ingestion pipelines and 177 gateways. Of these, 206 pipelines are usable for training; the rest had no
  completed update in the window, or are abandoned (< 3 completed updates or < 20 % success).
- Updates are overhead-dominated: P50 is about 1 minute, and cadence explains almost nothing (r = 0.04 with
  duration, 0.11 with DBU per update). At these sizes, cost scales with the number of runs, not batch size.
- Failures are sticky: only about 4 % of failed updates are followed by a successful one. Plain retries cannot reach
  a "≥ 90 % auto-healed" target; it takes failure classification (the guardian) plus fixing actionable causes.
