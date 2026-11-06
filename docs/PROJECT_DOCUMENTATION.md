# Data Ingestion Service: project documentation

*Version 0.2, deployed 2026-11-01 to your-workspace. See [PRD.md](PRD.md) for the product view, [PERMISSIONS.md](PERMISSIONS.md) for
the access model and grants, [gxp/VALIDATION.md](gxp/VALIDATION.md) for the validation pack.*

## 0. What v0.2 added

| Area | What | Proven |
|---|---|---|
| Connectors | Every UC connection type mapped: federation via foreign catalog, SFTP / volume files (generated Auto Loader pipeline), REST APIs (generated pipeline over an HTTP connection), Kafka (managed, Beta), API_SOURCE / community templates; raw-REST connection listing (the SDK drops newer types) | Live: IR-1009 REST API (Open-Meteo), IR-1010 UC volume CSV; unit: every pattern's spec, generated code compiles |
| Access model | Readers get USE CATALOG / USE SCHEMA / SELECT after the first load; SP owns the source catalog; verifier on effective permissions | Live: grants + verify on IR-1009 / 1010 / 1011..1013 |
| GxP | E-signature (SSO + scrypt PIN, lockout, sealed manifest bound to the config hash), promotion Dev → UAT → Prod, 14-check OQ on the real deployment, evidence ZIP (SHA-256 manifest) in `gxp_evidence` volume | Live: IR-1011 → IR-1012 → IR-1013, SP requester, e-signed "Approved / Released to UAT / Released to Production", OQ PASS ×3, checksums OK; approve without signature = 403 |
| ServiceNow | REQ per request (Table API or Service Catalog `order_now`), work notes per transition, incidents per failure episode + resolution, CMDB business-app prefill, inbound RITM endpoint, guardian backfill | Live on the simulator (REQ0010001…); unit incl. outage → backfill |
| Pause / unpause | Pause (one pipeline) or Pause all (admins): schedule off, scheduled run cancelled, pipeline + unshared gateway stopped, durable `paused_at/by` (migration 006); the guardian neither retries, tickets nor reconciles a paused pipeline. **Unpause pipeline** turns the schedule back on and starts an update immediately | Live 2026-11-01: Pause all paused 7 pipelines (IR-1003 already paused) → all 8 schedules PAUSED, pipelines IDLE; `tests/e2e/unpause.mjs` clicks Unpause on IR-1010 → update RUNNING + schedule on, then re-pauses; unit + vitest |
| OBO + OTEL | User-authorization scopes; preview as the user (`/* dis-obo */`); per-call usage capture; Apps telemetry → `dis_otel_logs/spans/metrics`; per-user usage page | Live: OTEL logins + spans per user, OBO queries rolled up from system.query.history |


## 1. Architecture

```
 Requester ──► Guided form ─┐                         ┌─► Lakeflow Connect (SP-owned)
                            ├─► Approved configuration ┤     gateway (CDC, shared per source DB)
 Requester ──► Assistant ───┘    (Lakebase, versioned) │     ingestion pipeline (serverless) + schedule job
                 │                    │                │     event log ─► UC ─► rows / freshness
                 ▼                    ▼                └─► Foundation (UC schemas per environment)
          AI forecast ◄── forecast_model (Lakebase) ◄── history job ◄── system.lakeflow.* + system.billing.*
                              │
             checks + approval (rules) ─► audit (Lakebase) ─► guardian job: health · retry · tickets ·
                                                               reconcile · cost MTD · UC request mirror
```

| Component | Where |
|---|---|
| App (FastAPI + React) | `data-ingestion-service`, SP `8eaee963-8c75-41a1-94e3-8b6c01b71b1d` |
| Store | Lakebase project `data-ingestion-service`, branch `production`, db `databricks_postgres`, schema `ingest` |
| Demo source | Lakebase project `dis-erp-source`, db `erp` (finance / procurement / quality, 7 tables, 103,620 rows), registered as UC catalog `dis_erp_source` |
| Lakehouse | `main.data_ingestion_service` (features, benchmarks, model, request mirror, pipeline event logs), `.dis_gateway_staging`, Foundation `.foundation_{dev,uat,prod}` |
| Jobs | `data-ingestion-service-setup` (on deploy), `-history` (daily 05:00 UTC), `-guardian` (every 30 min) |
| AI | `databricks-claude-sonnet-5` (assistant), MLflow experiment `/Users/<deployer>/data-ingestion-service-forecast` |
| Secrets | scope `data-ingestion-service` / `demo_replication_password` (app SP: READ) |

Every resource is also linked from **How it works → Where it runs** in the app (built from env at request time).

## 2. Data flow of one request

1. **Draft:** the form or the assistant produces an `IngestionConfig` with six areas: source, objects, schema,
   destination, schedule, ownership (plus operations). It is stored as version 1 with a SHA-256 content hash.
   Every edit is a new immutable version.
2. **Checks** (`modules/requests/rules.py`, pure):
   - configuration complete
   - connector supported / enabled
   - pattern allowed for this source
   - keys, cursor column, SCD 2, name collisions
   - destination allowed, refresh floor, classification and justification, tables per request, forecast cost cap
   - live: source and destination access
3. **Submit** requires no failing check. **Approve** requires:
   - a data owner for the domain (`domain:<name>` / `domain:*`) or an admin
   - for confidential / restricted data, someone other than the requester
   - above the cost cap, an admin
4. **Deploy** (`modules/deploy/executor.py`, background, idempotent):
   1. validate
   2. gateway: reuse or create (CDC)
   3. ingestion pipeline, then a Lakeflow **validate-only update**
   4. CAN_VIEW permissions for the requester and owner
   5. schedule job (Quartz)
   6. first update
5. **Operate:** the Pipelines page reads health from the Pipelines API, rows from the published event log, and
   reconciliation from source vs target counts. The guardian job retries transient failures once, tickets actionable
   ones (one ticket per failure episode), books cost MTD from billing tags and mirrors requests to UC.

## 3. Never-crash design

| Read | Tier 1 | Tier 2 | Tier 3 (labelled "Synthetic") |
|---|---|---|---|
| Requests, request detail | Lakebase | UC `request_mirror` (guardian) | sample requests `IR-SAMPLE-*` |
| Forecast model | Lakebase `forecast_model` | UC `forecast_model` | `app/modules/forecast/priors.json` (snapshot of a real fit) |
| Home KPIs | Lakebase | n/a | sample KPIs |
| Connectors | registry + Lakebase overrides | n/a | registry only |

- Writes fail loudly in order 400 → 503 (store down / kiosk) → 403 → 409. Anything unexpected answers JSON 500 with a
  detail.
- Lakebase pool rules:
  - `max_lifetime` 3000 s and the pool is rebuilt before the OAuth token expires
  - an idle connection is checked on checkout
  - a probe connect when a pool is built
  - a circuit breaker opens on connection failures only
- The UI wraps every page in an ErrorBoundary, and every page shows a source pill.

## 4. Forecast model

- **Training** (`jobs/history.py`): all pipelines of type `INGESTION_PIPELINE` / `INGESTION_GATEWAY` in the account,
  last 365 days. Updates are reassembled from hourly slices. Features per pipeline: duration P50/P90, first load,
  success, retry success, failure episodes, DBUs per update, gateway DBU/hour.
- **Filtering:** abandoned pipelines are dropped (< 3 completed updates or < 20 % success): 206 kept of 1,138.
- **Fitting:** lognormal per `family|pattern`, shrunk toward the pattern and then the global level (k = 8).
- **Prediction** (`app/modules/forecast/engine.py`): analytic cost quantiles plus a 20,000-sample Monte Carlo of
  freshness (wait for the next run + capture lag + update duration + retries / MTTR). SLA attainment = P(latency ≤ SLA).
- **Holdout** (25 % of pipelines, seeded):

| Metric | Value | Global baseline |
|---|---|---|
| Update duration P50 error | 27.8 % MdAPE | 27.8 % |
| Update duration P90 coverage | 88.9 % (target ~90 %) | n/a |
| DBU per update error | 50.7 % MdAPE | 56.2 % |
| Success-rate error | 13.4 pts | n/a |

Honest reading: duration is overhead-dominated (P50 about 1 min everywhere), so families don't beat the baseline on
duration; cost per update does improve. Cadence was tested and rejected (r = 0.04). Priors the history can't learn
are stated in the model JSON:
- table count scaling 0.22
- SCD 2 cost factor 1.15
- start-up times
- gateway VM $0.42/h
- MTTR 240 min
- throughput per family

## 5. Lakeflow Connect patterns supported

| Pattern | Spec | Status here |
|---|---|---|
| Gateway CDC (PostgreSQL, SQL Server) | gateway + ingestion_gateway_id (+ Postgres slot / publication) | Built and unit-tested; needs a POSTGRESQL / SQLSERVER connection. Demo source: blocked by CREATE CONNECTION (below) |
| Integrated CDC (MySQL, Oracle) | `connector_type: CDC` + `data_staging_options` | Built and unit-tested |
| Query-based (connection) | `connector_type: QUERY_BASED`, cursor column | Built and unit-tested |
| Query-based from a UC catalog | `ingest_from_uc_foreign_catalog: true` | **Live**: IR-1001, IR-1003, IR-1005 |
| SaaS / files | `connection_name` + objects | Built and unit-tested |

**Why the demo is query-based:** the deployer has CREATE CATALOG but not CREATE CONNECTION on the shared metastore,
and Lakeflow refuses the Lakebase-managed connection for CDC ("MANAGED_POSTGRESQL is not supported in your
workspace"). The setup job already created the replication role, the publication and the slot. A metastore admin
granting CREATE CONNECTION (or creating `dis_erp_source_pg`) turns CDC on with no code change: re-run setup.

### Showcase run (IR-1005, 2026-10-31)

| Step | Result |
|---|---|
| Request "Finance journals (GL header + lines)", 2 tables, query-based, hourly, forecast $30/month | approved, deployed: validate → pipeline (Lakeflow validated) → permissions → schedule → first run |
| Initial snapshot | 80,000 rows (20,000 + 60,000), reconciliation **match** |
| Source activity: +50 documents (100 lines), 20 lines updated → Run now | 80,150 = 80,150, **match** |
| +10 documents (20 lines), 5 lines updated → Run now | **205 rows** moved (incremental), **match** |

The first incremental run re-read every row because all seed rows shared one `updated_at` and the cursor watermark is
inclusive; the seed now spreads its timestamps (setup job), so a fresh install is incremental from the first run.

## 6. Deploy runbook

```bash
scripts/deploy.sh                                   # full: build, bundle deploy, setup, history, start, verify
scripts/deploy.sh --code-only                       # app code
scripts/deploy.sh -t new_workspace --profile P --var uc_catalog=<cat> --var warehouse_id=<id>
databricks bundle run -t demo dis_history           # retrain the forecast model now
databricks bundle run -t demo dis_guardian          # run the guardian now
```

Admins: the deployer is an admin automatically (`PLATFORM_ADMINS` = deployer). More admins and data owners are
granted inside the app (Administration), with a reason, audited; no redeploy.

Gotchas found on the way (all handled in code):
- Apps reject empty env values.
- `spark_python_task` has no `__file__`.
- The job runner reports `SystemExit(0)` as a failure.
- macOS bash 3.2 + `set -u` + empty arrays.
- The app's secret resource needs the key to exist before the first deploy (the deploy script writes a placeholder).

## 7. Tests

| Suite | Count | Result (2026-10-31) |
|---|---|---|
| Backend unit (`tests/unit`, real throwaway Postgres 15) | 108 | 108 passed, ~5 s |
| Frontend (`tsc` + vitest, 12 files) | 89 | 89 passed |
| Live integration (`tests/live`, deployed app) | 5 | 5 passed, incl. request → Lakeflow-validated pipeline → snapshot → 120 = 120 reconciled → stop, in 2.5 min |
| Browser e2e (`tests/e2e`, Chrome) | 9 routes + 3 journeys | all passed |

Not done yet:
- a timed Lakebase failover drill against the deployed app (the store-down path is covered offline: reads degrade,
  writes 503, bootstrap admins keep working)
- a fresh-install rehearsal in a second workspace

## 8. Found and fixed

| # | Found by | Problem | Fix |
|---|---|---|---|
| 1 | unit | Another user's chat session id was reused, so Bob could overwrite Alice's conversation | Unknown / foreign ids always start a new session |
| 2 | unit | "tables finance.a and finance.b" parsed `finance` as a table | Dot-aware list parsing, qualified names win |
| 3 | unit (92 s suite) | Store down: every read waited the 8 s pool timeout | Probe connect at pool build: fails in ms, breaker opens |
| 4 | design rule | A malformed request answered 503 when the store was down | Validate input before the store / kiosk guard |
| 5 | live | `pipelines.create(dry_run)` rejects every ingestion pipeline | Validation = a Lakeflow validate-only update at deploy |
| 6 | live | No CREATE CONNECTION; MANAGED_POSTGRESQL refused | Demo source as a UC database catalog, query-based; CDC auto-enables |
| 7 | live | `__file__` undefined in spark_python_task | Jobs locate themselves from `--root` |
| 8 | live | `sys.exit(0)` failed the setup job | Exit only on a non-zero code |
| 9 | live | App start failed on an empty env value | `auto` / `none` sentinels |
| 10 | live | Partial snapshot upsert hit NOT NULL → raw 500 | Migration 003 + a JSON 500 handler + test |
| 11 | live | Rows per update showed 0 for upsert flows | Read `num_upserted_rows + num_deleted_rows` |
| 12 | live | A stopped pipeline read as healthy | PAUSED state honoured by health and the guardian |
| 13 | design review | ~70 "tickets/month": counted failed runs | Forecast failure episodes; guardian keeps one ticket per episode |
| 14 | design review | CDC suggested for a source that can't do CDC | Source-aware patterns in the forecast |
| 15 | vitest | Buttons inside `<label>` took the label as accessible name | `Field group` (role=group, aria-labelledby) |
| 16 | agent review | `%%` in model notes | Fixed in the training job |
| 17 | research | databricks-sdk drops SFTP / KAFKA / COMMUNITY / … connection types (`connection_type=None`) | List connections through raw REST, paginated |
| 18 | live | A UC-volume source was refused as "missing a connection" | Connection required only for connector types backed by a UC connection |
| 19 | vitest | API query-parameter field ate a trailing "&" while typing | Keep the raw text; parse alongside |
| 20 | unit | `monkeypatch.undo()` in a test reverted the store fixture too | Scope patches with `monkeypatch.context()` |
| 21 | agent review | Modal re-focused its first field on every re-render (multi-field dialogs) | Focus once per open |
| 22 | live | Transient IP-ACL block mid-run (client IP changed) | Resumable live scripts (`RESUME_RID`), secrets always cleaned up in `finally` |
