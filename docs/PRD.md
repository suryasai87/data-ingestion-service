# Data Ingestion Service: product brief

*Owner: Lakeflow Connect product (field build). Status: v0.1 live on your-workspace, 2026-10-31.*

## Problem

The customer wants every new table in **Foundation** in under a day, from a self-service request. Today a request
travels by email to an engineer, who writes a pipeline per source. Approvals happen outside the system, cost is
discovered on the bill, and failures are found by consumers. The platform team can't scale that.

## Who it's for

| Persona | Needs |
|---|---|
| Requester (analyst, data engineer, app builder) | Ask for data without knowing what a gateway or a cursor is; know when it lands and what it costs |
| Data owner / approver | Approve with the facts in one place: what, where, how fresh, how sensitive, how much |
| Platform team | One standard runtime; guardrails instead of reviews; extensions instead of one-off pipelines |
| FinOps | Cost per pipeline, per cost center, before and after go-live |

## What we built (v0.1)

1. **Two intake channels, one configuration.** A guided form (Source → Objects → Destination → Schedule → Ownership
   → Review) and a conversational assistant both produce the same versioned *approved configuration*, the six
   areas on the customer's slide 3.
2. **AI forecast before you submit.** Monthly cost (P50/P90), time to first data, freshness P90 and SLA attainment,
   recalculated on every change. The model is trained on real Lakeflow Connect history from system tables: 206
   pipelines, account-wide, 365 days. One-click what-ifs are re-forecast with the same model: relax or tighten the
   schedule, query-based vs CDC, SCD 1 vs 2.
3. **Governance built in.** Checks for access, schema (keys, cursor), policy (destination, refresh floor,
   classification, cost cap, bulk size) and a Lakeflow validate-only update. A data owner approves; confidential and
   restricted data need someone other than the requester; above the cost cap only an admin approves. Everything is
   audited.
4. **Real deployment.** Approved requests deploy as Lakeflow Connect pipelines, owned by the service principal:
   - a shared gateway per source database for CDC
   - a serverless ingestion pipeline and a schedule job
   - FinOps tags and published event logs
   - the same configuration exportable as an Asset Bundle YAML for Dev → UAT → Prod promotion
5. **Operate.** Freshness vs SLA, source-to-Foundation reconciliation, cost month-to-date vs forecast. The guardian
   retries transient failures and tickets actionable ones (an internal queue that is ServiceNow-ready). Run now and
   stop are available for cost control.

## How it maps to the customer's success criteria

| Target | v0.1 |
|---|---|
| < 1 day request → Foundation | Measured on Home (median hours to live). First data predicted per request. |
| 15 min near-real-time | Interval / continuous choice with predicted freshness P90 and SLA attainment |
| 100 % self-service requests | Form + assistant. A ServiceNow intake hook is the next step (v0.2). |
| 100 % loads reconciled | Guardian reconciles row counts on every run; shown per pipeline |
| ≥ 90 % transient failures auto-healed | The guardian separates transient from actionable failures. History says naive retries heal only about 4 %, so this needs classification, not more retries. |
| 100 % releases with GxP evidence | Versioned configs with content hashes, independent approval, full audit trail. GxP evidence pack is v0.2. |

## Design principles

See [DESIGN.md](DESIGN.md): one decision at a time, the forecast is always visible, the same controls for every
channel, calm not empty, never a broken page, motion with a job.

## Known limits and next steps

- **Log-based CDC for the demo source** needs a POSTGRESQL connection, and the deployer lacks CREATE CONNECTION.
  The alternative is Databricks enabling the gated MANAGED_POSTGRESQL ingestion source. Until then the demo runs
  GA query-based ingestion from the Lakebase database catalog. CDC is fully wired and turns on when the connection
  exists.
- **Connector family is inferred from pipeline names.** About a third of history pipelines are named recognisably;
  the rest feed the global prior. With a source column in system tables, every family would be learned.
- **ServiceNow** request intake and ticket push (v0.2), GxP evidence pack per release (v0.2), and per-environment
  promotion in the app (today: bundle YAML export).
