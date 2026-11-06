# Data Ingestion Service: computerised system validation pack

*Scope: the Data Ingestion Service (DIS) app, its jobs and the Lakeflow Connect pipelines it creates. Approach:
GAMP 5 (2nd ed.), risk-based; the platform (Databricks, Lakeflow Connect, Unity Catalog, Lakebase) is a qualified
infrastructure supplier component; DIS configuration and code are Category 4/5. This pack is a template-ready starting
point: the customer's QA owns the final URS, risk assessment and approval.*

## 1. Intended use

Request, approve, deploy and monitor ingestion of source data into the Foundation (landing / bronze) layer, with
controls fit for GxP-relevant data: versioned configuration, independent e-signed approval, automated qualification
of every deployment, read-only access for people, and a complete audit trail.

## 2. Risk assessment (summary)

| Risk | Severity | Control in DIS | Verified by |
|---|---|---|---|
| Wrong / incomplete data reaches Foundation | High | Source-to-target reconciliation on every load; Lakeflow validation before first run | OQ `data.reconciled`, `deploy.validated`; live test |
| Unauthorised change of an approved pipeline | High | Immutable versions + SHA-256; deployed spec compared with the approved version; SP-owned pipelines | OQ `config.integrity`, `deploy.no_drift`, `runtime.identity` |
| Unapproved or self-approved release | High | Independent approver; e-signature (SSO identity + PIN) bound to the version hash | OQ `approval.independent`, `esign.bound`; unit tests |
| People read or alter the source | High | Source owned/used by the service principal only | OQ `access.source_isolated` |
| People alter landed data | High | Readers get USE CATALOG / USE SCHEMA / SELECT only | OQ `access.target_read_only`; executor unit test |
| Silent pipeline failure | Medium | Guardian: health, retries, one ticket per failure episode (ServiceNow) | unit tests, guardian log |
| Evidence lost or altered | Medium | Evidence ZIP with SHA-256 manifest in a UC volume; run SHA-256 in Lakebase | `checksums.sha256`, OQ record |

## 3. User requirements → design → tests (traceability)

| URS | Requirement | Design | Automated verification |
|---|---|---|---|
| URS-01 | Requests through a guided form or chat produce the same configuration | `modules/requests`, `modules/assistant` | `test_api.py::test_lifecycle_*`, `test_assistant_*`, vitest NewRequest / Assistant |
| URS-02 | Configuration checked against policy before submission | `requests/rules.py` | `test_rules.py` (14 tests) |
| URS-03 | Every change is a new immutable version with a content hash | `request_version`, `config_hash` | `test_lifecycle_versioning_and_approval`, OQ `config.integrity` |
| URS-04 | Approval by a data owner; independent for confidential / restricted / GxP | `rules.can_approve` | `test_approval_routing`, `test_independent_approval_for_confidential`, `test_gxp_approval_is_e_signed_and_independent` |
| URS-05 | Deployed pipeline equals the approved configuration; no manual changes | spec builder + executor; SP ownership | `test_specs.py`, `test_executor.py`, OQ `deploy.no_drift`, `deploy.schedule` |
| URS-06 | Definition validated by Lakeflow before use | executor validate-only update | `test_lakeflow_validation_failure_stops_before_schedule`, OQ `deploy.validated` |
| URS-07 | Pipelines run as a headless service identity | executor (SP), owner = run_as = SP | OQ `runtime.identity` |
| URS-08 | Data available after deployment | first run + guardian | live test `test_request_to_live_pipeline_and_reconciliation`, OQ `runtime.first_load` |
| URS-09 | Source and target reconcile on every load | `monitor.reconcile`, guardian | live test (120 = 120, 80,150 = 80,150), OQ `data.reconciled` |
| URS-10 | Least privilege: source SP-only, people read-only on targets | `uc_access`, setup ownership transfer | executor test (grants = USE CATALOG / USE SCHEMA / SELECT only), OQ `access.*` |
| URS-11 | Run history retained | event log published to UC | OQ `records.event_log` |
| URS-12 | Attributable, contemporaneous audit trail | `audit` table, every write | `test_admin_grant_*`, OQ `records.audit_trail` |
| URS-13 | Segregation of duties | approver ≠ requester for GxP | OQ `approval.independent` |
| URS-14 | Electronic signatures per 21 CFR Part 11 | `gxp/esign.py` | `test_pin_hash_and_seal`, `test_pin_rules_and_lockout`, `test_gxp_approval_is_e_signed_and_independent` |
| URS-15 | Dev → UAT → Prod by promotion only, after qualification | `requests.promote`, policy `gxp_prod_via_promotion_only` | `test_promotion_needs_live_and_qualification`, `test_gxp_request_cannot_target_prod_directly` |
| URS-16 | Requests and incidents recorded in ServiceNow | `modules/itsm` | `test_request_lifecycle_creates_and_updates_a_servicenow_request`, `test_incident_opens_and_resolves_in_servicenow`, `test_servicenow_outage_never_blocks_and_is_backfilled` |
| URS-17 | Every user's activity attributable for cost / usage | usage middleware (OBO identity), OpenTelemetry | `test_every_call_is_attributed_to_the_user`, `test_preview_needs_the_users_own_token` |

## 4. Qualification approach

- **IQ (installation):** the setup job is the installation script; its log lists every resource and grant (schemas,
  volume, Lakebase roles, ownership of the source, connection, system-table readability). Re-run it to re-verify.
- **OQ (operation):** `POST /api/requests/{id}/qualify` (and automatically after the first load of a GxP request)
  runs the checks above against the real deployed state and stores the run with its SHA-256; the evidence ZIP
  (`report.html`, `report.json`, approved configuration, deployed specs, audit trail, signatures, manifest,
  `checksums.sha256`) is written to `<catalog>.<schema>.gxp_evidence`.
- **PQ (performance):** the customer runs representative requests per connector family in UAT and reviews
  reconciliation, freshness against SLA and incidents over an agreed period (the Pipelines page + guardian log).

## 5. 21 CFR Part 11 / EU Annex 11

| Clause | How DIS meets it |
|---|---|
| 11.10(a) validation | This pack + automated OQ per deployment |
| 11.10(c) record protection | Lakebase (PITR), UC event logs, evidence ZIPs with SHA-256 manifests |
| 11.10(d) limited access | Databricks SSO; app roles (admin, data owner); source SP-only; readers SELECT-only |
| 11.10(e) audit trail | Append-only `audit` table: who, what, when, why (reason required on every decision) |
| 11.10(f) operational checks | Lifecycle state machine (409 on out-of-order steps), checks before submit |
| 11.10(g) authority checks | Approver scopes, independent approval, admin-only above the cost cap |
| 11.50 manifestation | Printed name, UTC date/time and meaning on every signature (UI + report) |
| 11.70 linking | Signature bound to request id + version + config SHA-256, sealed with a manifest hash (tamper detected) |
| 11.100 uniqueness | One SSO identity per person; PIN per identity; admin can reset, never see or set |
| 11.200(a) components | Component 1: authenticated SSO identity; component 2: signing PIN (scrypt-hashed), lockout after 3 failures |
| Annex 11 §10 change management | Promotion Dev → UAT → Prod as new linked requests with their own e-signed approval |
| Annex 11 §12 security | No credentials in code; source credentials in UC connections / secret scope |

## 6. Limitations to record as deviations or CAPAs

- The signing PIN is the second component; a site may require re-entry of the SSO password instead (not possible
  inside a Databricks App session); document the PIN control in the site's procedure.
- ServiceNow runs in **simulator** mode until an instance is configured; the integration test against the real
  instance must be executed in UAT.
- The demo source uses query-based ingestion (no log-based CDC) because no POSTGRESQL connection can be created in
  the demo workspace; CDC pipelines are covered by unit tests only.
