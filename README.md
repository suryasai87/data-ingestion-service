# Data Ingestion Service

Governed, self-service ingestion into **Foundation** on Databricks: a guided form or a conversational assistant,
an **AI forecast** of cost, time to first data, freshness and SLA before you submit, data-owner approval, and real
**Lakeflow Connect** pipelines, monitored and reconciled. It runs as a Databricks App on Lakebase.

**Live:** https://data-ingestion-service-1234567890123456.aws.databricksapps.com (your-workspace)

| Doc | What's in it |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product brief: problem, personas, scope, mapping to the success criteria, next steps |
| [docs/DESIGN.md](docs/DESIGN.md) | UI/UX design language, tokens, brand pack, components |
| [docs/PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md) | Architecture, data model, forecast model, deploy runbook, tests, found-and-fixed |
| [docs/API.md](docs/API.md) | HTTP API and the error contract |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Verified Lakeflow Connect / Lakebase / pricing facts, incl. what was proven live |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | Access model, Unity Catalog grants (admin, SP, users), OBO + OpenTelemetry |
| [docs/gxp/VALIDATION.md](docs/gxp/VALIDATION.md) | GxP validation pack: risk, URS → tests traceability, IQ/OQ/PQ, Part 11 / Annex 11 |
| [Pitch deck (FY27 template)](https://docs.google.com/presentation/d/13oW2miLabZW4HyENw43m83bxXJ-GdKx1DKd2SLyz5wU/edit) | 19-slide product pitch against the success criteria (rebuild: `deck/gslides/deck.py`) |
| [Google Doc](https://docs.google.com/document/d/1khUrdBVkTGxOk4HkWS2elXqsl-KqTKWa7Ik5R0dqEno/edit) | Product brief + project documentation, for sharing |
| [Confluence (FE › HLS Field Engineering)](https://databricks.atlassian.net/wiki/spaces/FE/pages/7004717057) | Demo page: talk track, AE positioning, discovery, objections, SA architecture, proof, 15 screenshots |

## Features

| Area | What it does |
|---|---|
| Guided request | Source → Objects → Destination → Schedule → Ownership → Review; live source browse (keys, rows, cursor candidates); one versioned configuration |
| Assistant | Plain language → the same configuration (Claude on Databricks; rules fallback); grounded against the real source; submits for approval, never deploys |
| AI forecast | Monthly cost P50/P90, first data, freshness P90, SLA attainment, incidents/month; trained on 206 real Lakeflow Connect pipelines (365 days, system tables); one-click what-ifs |
| Governance | Access + schema + policy checks, Lakeflow validation, data-owner approval, independent approval for confidential / restricted, admin-only above the cost cap, audit trail |
| Deploy | Lakeflow Connect: shared gateway per source DB (CDC), serverless ingestion pipeline, schedule job, FinOps tags, event log; bundle YAML export |
| Operate | Freshness vs SLA, reconciliation, rows per update, cost MTD vs forecast; Run now, Pause, Pause all (admins) and **Unpause pipeline** (schedule back on + an update starts immediately); guardian job auto-retries transient failures and tickets the rest (never for paused pipelines) |
| Admin | Deployer is admin; delegate admins and data owners to any user in the app; policies; connector switches; audit; per-user usage |
| Connectors | 48 connectors covering all 50 UC connection types: database CDC / query-based, federation (foreign catalog), SaaS, SFTP + volumes (Auto Loader), REST APIs (HTTP connection), Kafka; `GET /api/connection-types` |
| Access model | Source used only by the app's service principal; pipelines run as the SP; readers get USE CATALOG / USE SCHEMA / SELECT only, granted + verified automatically |
| GxP | 21 CFR Part 11 e-signatures (SSO + PIN), Dev → UAT → Prod promotion, automated 14-check qualification, SHA-256 evidence pack in a UC volume |
| ServiceNow | Request ticket per request (Table API or Service Catalog order), lifecycle sync, incidents per failure episode, CMDB prefill, inbound from a catalog item; simulator when no instance is configured |
| OBO + OTEL | Previews run with the user's token; every call attributed to the user; Apps telemetry → UC tables (logins, spans, metrics) |
| Brand | Brand packs in `app/branding/<key>/brand.json` (`DIS_BRAND`, default `databricks` = neutral); add your own pack for a customer logo |

## Quick start

```bash
scripts/deploy.sh                 # build UI, deploy bundle, setup + history jobs, start the app, verify 200 + RUNNING
scripts/deploy.sh --code-only     # app code only
scripts/test.sh                   # offline: backend (108) + frontend (89)
DIS_URL=<app url> scripts/test.sh live            # + live integration (creates real pipelines)
(cd tests/e2e && APP_URL=<app url> TOKEN=<token> node journeys.mjs)   # browser e2e
(cd tests/e2e && APP_URL=<app url> TOKEN=<token> RID=<paused request> node unpause.mjs)   # Unpause → running, then re-pause
```

## Install in another workspace

The repo is one Databricks Asset Bundle: the app, three Lakebase-backed jobs (setup, history, guardian), the Lakebase
store and demo source projects, and every grant the app's service principal needs.

1. **Prerequisites**, granted once by a metastore or workspace admin; details in [docs/PERMISSIONS.md](docs/PERMISSIONS.md):
   - for the deployer:
     - `CREATE CATALOG` (needed only if the catalog doesn't exist yet), plus ownership of the target catalog or `MANAGE` on it;
     - `CREATE CONNECTION`, for CDC databases, SFTP and HTTP sources;
     - `USE` + `SELECT` on `system.billing`, `system.lakeflow`, `system.query` and `system.access`, with those schemas enabled;
   - a SQL warehouse;
   - Databricks CLI ≥ 1.20 (bundle `postgres_projects`), Node 20 and Python 3.11 on your machine.
2. **Deploy**:
   ```bash
   git clone https://github.com/suryasai87/data-ingestion-service && cd data-ingestion-service
   databricks auth login --host https://<workspace> --profile <P>
   scripts/deploy.sh -t new_workspace --profile <P> --var uc_catalog=<catalog> --var warehouse_id=<warehouse id>
   ```
   Optional `--var` values:
   - `brand=databricks`, the neutral brand;
   - `servicenow_mode=rest servicenow_instance=<name>`, together with the `SNOW_*` app secrets;
   - `demo_http_connection=<http connection>`;
   - `platform_admins=<a@x.com,b@x.com>`;
   - `allow_deploy=false`, read-only kiosk.

   The deployer is always an administrator.
3. **What the script does**:
   1. builds the UI;
   2. runs `bundle deploy`;
   3. runs the setup job: SP grants, Foundation schemas, volumes, seed source, system-table probe, OTEL grants;
   4. runs the history job: trains the forecast on this workspace's Lakeflow Connect history, falling back to shipped priors;
   5. starts the app;
   6. checks it returns 200 and `RUNNING`.
4. **Verify** with `DIS_URL=<app url> scripts/test.sh live`. This creates real query-based, REST API and volume pipelines, then checks read-only grants and source isolation.

Every operation in the UI is also an HTTP API, for example ServiceNow, CI or another app submitting requests. See [docs/API.md](docs/API.md).

## Layout

```
app/                 FastAPI monolith (the Databricks App source)
  core/              config, Lakebase pool + breaker, warehouse, repo (SQL), tiers, access, LLM
  modules/           catalog · sources · requests (rules, service) · forecast (engine, service, priors.json)
                     deploy (specs, codegen, executor) · monitor · assistant · admin · platform
                     gxp (esign, oq) · itsm (servicenow, simulator) · uc_access · usage
  migrations/        additive Lakebase DDL (001 init … 005 usage rollup)
  branding/          brand packs (databricks)
  static/            built UI (committed: bundle sync honours .gitignore)
frontend/            React 19 + Vite + Tailwind v4 tokens + framer-motion + recharts
jobs/                setup · history (train the forecast) · guardian (every 30 min)
resources/           bundle: Lakebase projects, jobs, experiment, app
tests/unit           pytest against a throwaway real Postgres
tests/live           against the deployed app (real pipelines)
tests/e2e            Playwright journeys + screenshots
deck/gslides/        the pitch deck builder (FY27 template, copy-and-mutate)
docs/                PRD, design, API, research, permissions, GxP validation, project documentation
```
