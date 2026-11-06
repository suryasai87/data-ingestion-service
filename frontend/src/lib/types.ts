// Shared API contract (mirrors app/modules/*/models.py). Every read carries `source` so the UI can show which tier
// served it: "lakebase" (live store), "warehouse" (Unity Catalog gold), "workspace" (live Databricks API) or
// "synthetic" (built-in, labelled, never silently mixed in).
export type Tier = "lakebase" | "warehouse" | "workspace" | "synthetic";

export interface Sourced {
  source: Tier;
  degraded_reason?: string | null;
}

export interface Brand {
  key: string;
  company: string;
  product: string;
  hero_title: string;
  hero_subtitle: string;
  destination_label: string;
  logo_url: string | null;
  powered_by: string;
  palette: { brand_h: number; brand_s: string };
}

export interface Me {
  email: string;
  name: string;
  is_admin: boolean;
  is_approver: boolean;
  approver_scopes: string[];
  kiosk: boolean;
  environment_note?: string | null;
}

export type Category = "database" | "warehouse" | "saas" | "files" | "api" | "streaming";
export type Pattern = "cdc" | "query" | "federation" | "saas" | "files" | "api" | "stream" | "community";

export interface Connector {
  id: string;            // e.g. "postgresql"
  name: string;          // "PostgreSQL"
  category: Category;
  patterns: Pattern[];   // supported ingestion patterns, first = default
  status: "supported" | "preview" | "extension";
  connection_type: string | null; // UC connection_type, e.g. "POSTGRESQL"
  capabilities: {
    hard_deletes: boolean;
    scd2: boolean;
    min_interval_minutes: number;
    needs_gateway: boolean;
    incremental: boolean;
  };
  description: string;
  enabled: boolean;
  history_pipelines?: number; // pipelines in the forecast training history for this family
}

export interface Connection {
  name: string;
  connection_type: string;
  host: string | null;
  owner: string | null;
  usable: boolean;           // the service can use it (USE CONNECTION + policy)
  foreign_catalog: string | null; // browse source objects through Lakehouse Federation when present
  comment?: string | null;
  demo?: boolean;
  via?: "connection" | "uc_catalog"; // uc_catalog = a Unity Catalog database / foreign catalog read query-based
  patterns?: Pattern[];               // patterns this particular source supports
}

export interface SourceTable {
  schema: string;
  name: string;
  rows_est: number | null;
  size_bytes: number | null;
  primary_keys: string[];
  columns: number;
  cursor_candidates: string[];
  cdc_ready: boolean;
  issues: string[];
}

export interface ObjectsResponse extends Sourced {
  connection: string;
  schemas: string[];
  tables: SourceTable[];
  browse: "federation" | "direct" | "manual";
}

export interface Destination {
  environment: "dev" | "uat" | "prod";
  label: string;
  catalog: string;
  schema: string;
  allowed: boolean;
  requires_approval: boolean;
}

export type ScdType = "SCD_TYPE_1" | "SCD_TYPE_2";
export type Classification = "public" | "internal" | "confidential" | "restricted";

export interface ObjectSpec {
  schema: string;
  table: string;
  primary_keys: string[];
  cursor_column?: string | null;
  destination_table?: string | null;
  rows_est?: number | null;
  options?: Record<string, unknown>; // files: path/format/header · api: path/method/params · stream: topic/value_format
}

export interface IngestionConfig {
  title: string;
  source: { connector: string; pattern: Pattern; connection: string | null; database?: string | null; via?: "connection" | "uc_catalog" };
  objects: ObjectSpec[];
  schema: { scd_type: ScdType; evolution: "add_new_columns" | "none" };
  destination: { environment: Destination["environment"]; catalog: string; schema: string; table_prefix?: string };
  schedule: { mode: "continuous" | "interval"; interval_minutes: number; sla_minutes: number };
  ownership: {
    owner: string; classification: Classification; domain: string; cost_center: string; justification: string;
    gxp?: boolean;                                      // GxP-relevant: e-signed approval, qualification, Dev → UAT → Prod
    readers?: string[];                                 // extra read-only principals: emails or group:<name>
    business_app?: { sys_id: string; name: string } | null; // ServiceNow CMDB business application
  };
  operations: { retries: number; recovery: "auto_retry_then_ticket" | "ticket_only"; reconciliation: boolean; alert_emails: string[] };
}

export interface Range { p50: number; p90: number }

export interface Recommendation {
  id: string;
  title: string;
  detail: string;
  delta: { cost_month?: number; freshness_p90_min?: number; sla_pct?: number };
  patch: Record<string, unknown>;
}

export interface Forecast extends Sourced {
  model_version: string;
  basis: { n_pipelines: number; n_updates: number; workspaces: number; window_days: number; match: "family" | "pattern" | "global"; family: string };
  cost: { month: Range; dbu_day: number; usd_per_dbu: number; breakdown: { label: string; usd_month: number; pct: number }[] };
  first_data_min: Range;
  freshness_min: Range;
  sla: { target_min: number; attainment_pct: number };
  reliability: { success_rate: number; auto_heal_rate: number; expected_tickets_month: number };
  confidence: "high" | "medium" | "low";
  drivers: string[];
  recommendations: Recommendation[];
}

export type RequestStatus =
  | "draft" | "pending_approval" | "approved" | "rejected" | "deploying" | "live" | "failed" | "cancelled";

export interface CheckResult { key: string; label: string; status: "pass" | "warn" | "fail"; detail: string }

export interface IngestRequest {
  id: string;
  title: string;
  status: RequestStatus;
  channel: "app" | "chat" | "servicenow" | "api";
  requester: string;
  owner: string;
  classification: Classification;
  environment: Destination["environment"];
  connector: string;
  pattern: Pattern;
  n_objects: number;
  version: number;
  created_at: string;
  updated_at: string;
  pipeline_id: string | null;
  gateway_id: string | null;
  job_id: string | null;
  forecast_month_usd: number | null;
  sla_minutes: number | null;
  gxp?: boolean;
  parent_id?: string | null;      // promoted from this request (Dev → UAT → Prod)
  ticket_number?: string | null;  // ServiceNow request number
}

export interface TimelineEvent { at: string; actor: string; action: string; detail: string }

export interface RequestDetail extends Sourced {
  request: IngestRequest;
  config: IngestionConfig;
  versions: { version: number; created_at: string; created_by: string; hash: string }[];
  checks: CheckResult[];
  forecast: Forecast | null;
  timeline: TimelineEvent[];
  deployment: { step: string; status: "pending" | "running" | "done" | "failed" | "skipped"; detail: string; at: string | null }[];
  links: { label: string; url: string }[];
  can: {
    edit: boolean; submit: boolean; approve: boolean; deploy: boolean; cancel: boolean;
    promote?: boolean; qualify?: boolean; sign_required?: boolean;
  };
  itsm?: ItsmLink[];
  itsm_mode?: "rest" | "simulator";
  gxp?: GxpInfo | null;
  access?: AccessModel | null;
  lineage?: { parent_id: string | null; children: string[] };
  next_env?: "uat" | "prod" | null;
}

// --- ServiceNow -------------------------------------------------------------------------------------------------
export interface ItsmLink {
  kind: "request" | "incident";
  table_name: string;
  sys_id: string;
  number: string | null;
  url: string | null;      // only when a real instance is configured
  state: string | null;
  synced_at: string;
  incident_id?: number | null;
}

export interface ItsmStatus {
  mode: "rest" | "simulator";
  instance: string | null;
  request_table: string;
  incident_table: string;
  assignment_group: string | null;
}

export interface CmdbApp {
  sys_id: string;
  name: string;
  owner: string | null;
  domain: string;
  cost_center: string | null;
  support_group: string | null;
  gxp: boolean;
}

export interface CmdbResponse {
  items: CmdbApp[];
  source: "servicenow" | "simulator" | "synthetic";
  degraded_reason?: string | null;
}

// --- GxP (21 CFR Part 11) ---------------------------------------------------------------------------------------
export interface ESignature {
  signer: string;
  printed_name: string;
  meaning: string;
  reason: string;
  signed_at: string;
  version: number;
  config_hash: string;
  manifest_hash: string;
  intact: boolean;
}

export type GxpCheck = CheckResult & { requirement?: string };

export interface GxpEvidence {
  id: number;
  version: number;
  verdict: "PASS" | "FAIL" | "PASS_WITH_DEVIATIONS";
  sha256: string;
  volume_path: string | null;
  created_by: string;
  created_at: string;
  checks: GxpCheck[];
}

export interface GxpInfo { enabled: boolean; signatures: ESignature[]; evidence: GxpEvidence | null }

export interface PinStatus { has_pin: boolean; set_at: string | null; locked_until: string | null }

// --- Unity Catalog access model ---------------------------------------------------------------------------------
export interface AccessGrant {
  principal: string;
  securable: string;
  privileges: string;   // comma separated, e.g. "USE_CATALOG"
  status: "granted" | "pending" | "failed";
  detail: string;
  at: string;
}

export interface AccessModel {
  run_as: string;
  service_principal: string;
  source: { securable: string | null; kind: string; who: string };
  target: { tables: string[]; readers: string[]; privileges: string[] };
  grants: AccessGrant[];
  checks?: CheckResult[];
}

export interface DataPreview {
  table: string;
  tables: string[];
  rows: Record<string, unknown>[];
  as_user: string;
  columns: string[];
}

export interface Spec { gateway: object | null; ingestion: object; job: object | null; bundle_yaml: string }

export interface PipelineHealth {
  request_id: string;
  title: string;
  pipeline_id: string;
  state: string;
  health: "healthy" | "degraded" | "failing" | "paused" | "stopped" | "unknown";
  /** Set while the service has the pipeline paused (schedule off, pipeline stopped); cleared by Unpause. */
  paused_at?: string | null;
  paused_by?: string | null;
  last_update_at: string | null;
  last_update_state: string | null;
  freshness_min: number | null;
  sla_minutes: number | null;
  rows_last_update: number | null;
  cost_mtd_usd: number | null;
  forecast_month_usd: number | null;
  recon: { status: "match" | "drift" | "pending"; source_rows: number | null; target_rows: number | null } | null;
  incidents_open: number;
  url: string | null;
}

export interface ChatTurn { role: "user" | "assistant"; content: string }

export interface ChatReply {
  session_id: string;
  reply: string;
  draft: Partial<IngestionConfig>;
  missing: string[];
  ready: boolean;
  checks: CheckResult[];
  llm: "live" | "rules";
}

export interface ResourceGroup { title: string; items: { label: string; value: string; url?: string | null }[] }

export interface HomeStats extends Sourced {
  requests_open: number;
  pipelines_live: number;
  tables_live: number;
  median_hours_to_live: number | null;
  sla_attainment_pct: number | null;
  cost_mtd_usd: number | null;
  forecast_accuracy_pct: number | null;
  recent: IngestRequest[];
}

export interface ModelCard extends Sourced {
  version: string;
  trained_at: string | null;
  window_days: number;
  n_pipelines: number;
  n_updates: number;
  workspaces: number;
  metrics: { name: string; value: number; unit: string; note: string }[];
  method: string[];
  benchmarks: {
    family: string; pattern: string; n_pipelines: number; n_updates: number;
    upd_p50_s: number; upd_p90_s: number; success_rate: number; dbu_per_update: number; gateway_dbu_hour: number | null;
  }[];
}

// --- usage analytics (admins) -------------------------------------------------------------------------------------
export interface UsageUser {
  user_email: string;
  sessions?: number;
  api_calls?: number;
  obo_calls?: number;
  obo_queries?: number;
  avg_ms?: number | string | null;
  last_seen?: string | null;
  actions: Record<string, number>;
  requests?: number;
  live?: number;
  forecast_month_usd?: number;
  cost_mtd_usd?: number;
  wh_queries?: number;
  wh_duration_ms?: number;
  wh_read_bytes?: number;
}

export interface UsageResponse extends Sourced {
  days: number;
  users: UsageUser[];
  daily: { day: string; calls: number; users: number }[];
  totals: { users?: number; api_calls?: number; sessions?: number };
  otel: { enabled: boolean };
}
