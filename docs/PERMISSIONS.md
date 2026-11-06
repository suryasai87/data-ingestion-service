# Permissions and access model

## Access model (enforced and verified)

| Layer | Who | What |
|---|---|---|
| Source | **App service principal only** (the headless pipeline identity) | Uses the UC connection / owns the source catalog. Requesters and readers hold **no** privilege on it. Credentials live in the UC connection or the secret scope, never in code or in a request. |
| Runtime | App service principal | Creates the pipelines; owner = run-as = the SP. Generated pipeline sources live in the SP's own workspace folder, so nobody can edit a pipeline by hand. |
| Target (Foundation / bronze) | Requester, data owner, named readers | **Read only**: `USE CATALOG` + `USE SCHEMA` + `SELECT` per landed table, granted automatically after the first load. Nobody but the SP can `MODIFY`. |

The request detail's **Access** card shows the grants, and **Verify access** checks effective permissions:
- the SP owns every landed table
- readers hold SELECT only
- only the SP can use the source

The same three checks are part of the GxP qualification (`access.*`).

## Unity Catalog and workspace permissions

### Metastore admin (once per metastore)

```sql
GRANT CREATE CONNECTION ON METASTORE TO `<deployer or platform group>`;   -- SFTP, HTTP, database connections
GRANT CREATE CATALOG    ON METASTORE TO `<deployer or platform group>`;   -- Foundation catalog, Lakebase database catalogs
-- system tables (forecast training, cost month-to-date, per-user usage rollups):
--   databricks system-schemas enable <METASTORE_ID> <schema>   (account / metastore admin; billing, lakeflow, access, query)
GRANT USE CATALOG ON CATALOG system TO `<deployer>`;
GRANT USE SCHEMA, SELECT ON SCHEMA system.billing  TO `<deployer>`;
GRANT USE SCHEMA, SELECT ON SCHEMA system.lakeflow TO `<deployer>`;
GRANT USE SCHEMA, SELECT ON SCHEMA system.query    TO `<deployer>`;
GRANT USE SCHEMA, SELECT ON SCHEMA system.access   TO `<deployer>`;
```

The history and guardian jobs read system tables **as the deployer**. The app's service principal needs no system-table access.

### Deployer (platform admin)

- Workspace admin, to create the app and give the SP the `allow-cluster-create` entitlement (CDC gateways run on classic compute).
- Owner of the Foundation catalog and schemas, or `MANAGE` on them.
- Owner of the Lakebase projects (the bundle creates them).

### App service principal (the setup job grants all of this)

| Securable | Privileges | Why |
|---|---|---|
| Foundation schemas (`foundation_dev/uat/prod`) | `ALL PRIVILEGES` + `MANAGE` | Its pipelines create tables there; MANAGE lets it grant readers USE SCHEMA / SELECT |
| Destination catalog | `USE CATALOG` + `MANAGE` | Grant readers USE CATALOG |
| Gateway staging schema | `ALL PRIVILEGES` (incl. `CREATE VOLUME`) | CDC gateway staging volumes |
| Service schema | `USE SCHEMA, SELECT, MODIFY, CREATE TABLE` | Event logs, request mirror, evidence volume, **Apps telemetry tables** |
| Source catalog (demo) | **Owner** | Only the headless identity reads the source |
| Source connections | `USE CONNECTION` | Granted by the connection owner |
| Lakebase store + source | OAuth role (`LAKEBASE_OAUTH_V1`) + schema grants | Service state; source browse / reconciliation |
| Secret scope | `READ` | Replication password, ServiceNow credentials |
| SQL warehouse / model endpoint / jobs | `CAN_USE` / `CAN_QUERY` / `CAN_MANAGE_RUN` | App resources in the bundle |

### Users

| Who | Privileges |
|---|---|
| Everyone who requests data | `CAN USE` on the app. Nothing on the source; `USE CATALOG`, `USE SCHEMA`, `SELECT` on what their requests land. |
| Data owners, admins | Granted inside the app (reason required, audited). No bundle edit or redeploy. |

## On-behalf-of (OBO) and OpenTelemetry

- **OBO:** the app is deployed with Apps **user authorization** scopes `sql`, `catalog.catalogs:read`, `catalog.schemas:read`, `catalog.tables:read`. The user's token is forwarded in `X-Forwarded-Access-Token`.
  - **Data preview:** "Preview data as me" runs `SELECT … LIMIT 20 /* dis-obo */` with that token, so it uses the user's own read-only grant and appears in `system.query.history` under the user's name.
  - **Usage rollup:** the guardian rolls those queries up per user (`usage_rollup`).
- **Every API call** is attributed to the forwarded identity (`usage_event` in Lakebase: session, route, status, latency, OBO flag).
- **OpenTelemetry → Unity Catalog:** the app uses Databricks Apps telemetry (GA), set in the bundle with `telemetry_export_destinations`.
  - The platform writes `dis_otel_logs`, which include **user login events** (`event.name = 'app.auth'`).
  - The app sends one span per API call with `enduser.id` (`dis_otel_spans`), plus metrics (`dis_otel_metrics`).
  - **Administration › Usage** joins all of it per user with forecast and actual pipeline cost.
