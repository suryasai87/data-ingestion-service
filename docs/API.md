# Data Ingestion Service: HTTP API

All JSON. Types are in `frontend/src/lib/types.ts` (the contract) and mirrored by the FastAPI routers in
`app/modules/*/router.py`. Reads never answer 500: they degrade through Lakebase → Lakehouse (warehouse) → built-in
(labelled `synthetic`) and say which tier answered in `source` (+ `degraded_reason`). Governed writes fail loudly in
this order: **400** bad input → **503** store down / read-only kiosk → **403** not allowed → **409** wrong state.

## Platform
| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ok, version, lakebase:{configured,open,last_error}, warehouse, brand}` |
| GET | `/api/brand` | `Brand` |
| GET | `/api/me` | `Me` |
| GET | `/api/home` | `HomeStats` |
| GET | `/api/platform/resources` | `{groups: ResourceGroup[]}` ("Where it runs" deep links) |

## Catalog, sources, destinations
| Method | Path | Returns |
|---|---|---|
| GET | `/api/connectors` | `{source, items: Connector[]}` |
| PUT | `/api/connectors/{id}` | admin: `{enabled}` → `Connector` |
| GET | `/api/connections?connector=<id>` | `{source, items: Connection[]}` |
| GET | `/api/connections/{name}/objects` | `ObjectsResponse` (federation / direct / manual browse) |
| GET | `/api/destinations` | `{source, items: Destination[]}` |

## Forecast
| Method | Path | Returns |
|---|---|---|
| POST | `/api/forecast` | body `{config: IngestionConfig}` → `Forecast` |
| GET | `/api/forecast/model` | `ModelCard` |

## Requests
| Method | Path | Notes |
|---|---|---|
| GET | `/api/requests?scope=mine\|all\|approvals&status=` | `{source, items: IngestRequest[]}` |
| POST | `/api/validate` | body `{config}` → `{checks: CheckResult[]}` (live checks while editing, nothing saved) |
| POST | `/api/requests` | body `{config, channel}` → `RequestDetail` (a draft, version 1) |
| GET | `/api/requests/{id}` | `RequestDetail` |
| PUT | `/api/requests/{id}` | body `{config}` → new immutable version (draft / rejected only) |
| POST | `/api/requests/{id}/validate` | re-run checks (incl. a Lakeflow `dry_run`) |
| POST | `/api/requests/{id}/submit` | needs no failing check → `pending_approval` |
| POST | `/api/requests/{id}/approve` | body `{reason}`; data owner or admin; independent approval for confidential / restricted |
| POST | `/api/requests/{id}/reject` | body `{reason}` |
| POST | `/api/requests/{id}/deploy` | approver / admin; background: gateway → ingestion pipeline → schedule job → first update |
| POST | `/api/requests/{id}/cancel` | body `{reason}` |
| GET | `/api/requests/{id}/spec` | `Spec` (gateway / ingestion / job JSON + bundle YAML) |

## Pipelines (operate)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/pipelines` | `{source, items: PipelineHealth[]}` |
| POST | `/api/pipelines/{request_id}/run` | start one update now; never changes the schedule (a paused pipeline stays paused) |
| POST | `/api/pipelines/{request_id}/pause` | cost control: schedule off, in-flight scheduled run cancelled, pipeline stopped, gateway stopped unless shared; `{done}`. `/stop` is the v0.1 alias |
| POST | `/api/pipelines/{request_id}/unpause` | gateway started (CDC), schedule back on, an update started now; `{update_id, done}` |
| POST | `/api/pipelines/pause-all` | admin: pause every live pipeline not already paused; `{paused, already_paused, failed}` |
| POST | `/api/pipelines/{request_id}/reconcile` | source vs Foundation row counts |
| GET | `/api/pipelines/{request_id}/incidents` | `{items}` |
| POST | `/api/demo/source-activity` | admin: insert / update / delete rows in the demo source |

## Assistant
| Method | Path | Notes |
|---|---|---|
| POST | `/api/assistant/chat` | body `{session_id?, message}` → `ChatReply` |
| POST | `/api/assistant/{session_id}/submit` | creates the request from the confirmed draft (channel `chat`) and submits it |

## Administration (admins only; non-admin = 403)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/admins` | `{items:[{email, source, granted_by, granted_at, reason, removable}]}` |
| POST | `/api/admin/admins` | `{email, reason}` |
| DELETE | `/api/admin/admins/{email}` | `{reason}`; deployer/bootstrap and the last admin answer 409 |
| GET | `/api/admin/workspace-users?q=` | `{source, items:[{email, name, active}]}` |
| GET | `/api/admin/approvers` | `{items:[{email, scope, granted_by, granted_at, reason}]}` |
| POST | `/api/admin/approvers` | `{email, scope, reason}` (scope `domain:finance` or `domain:*`) |
| DELETE | `/api/admin/approvers/{email}?scope=` | `{reason}` |
| GET | `/api/admin/policies` | `{source, items:[{key, label, description, value, updated_by, updated_at}]}` |
| PUT | `/api/admin/policies/{key}` | `{value}` |
| GET | `/api/admin/audit?limit=` | `{items:[{at, actor, action, entity, entity_id, detail}]}` |
