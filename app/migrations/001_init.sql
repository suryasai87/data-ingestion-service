-- Data Ingestion Service: transactional store (Lakebase Postgres). Additive and idempotent; applied in order by
-- core/migrate.py (setup job as the schema owner, or locally). {schema} is replaced with LAKEBASE_SCHEMA.
CREATE SCHEMA IF NOT EXISTS {schema};

CREATE TABLE IF NOT EXISTS {schema}.schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS {schema}.request_seq START 1001;

-- One row per ingestion request; the governed configuration itself is versioned in request_version.
CREATE TABLE IF NOT EXISTS {schema}.request (
  id             text PRIMARY KEY,
  title          text NOT NULL,
  status         text NOT NULL CHECK (status IN ('draft','pending_approval','approved','rejected','deploying','live','failed','cancelled')),
  channel        text NOT NULL DEFAULT 'app' CHECK (channel IN ('app','chat')),
  requester      text NOT NULL,
  owner          text,
  classification text,
  environment    text,
  connector      text,
  pattern        text,
  n_objects      int  NOT NULL DEFAULT 0,
  version        int  NOT NULL DEFAULT 1,
  pipeline_id    text,
  gateway_id     text,
  job_id         text,
  forecast       jsonb,
  sla_minutes    int,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_status_idx ON {schema}.request (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS request_requester_idx ON {schema}.request (requester, updated_at DESC);

-- "Configuration drives every pipeline": every edit is a new immutable version with a content hash.
CREATE TABLE IF NOT EXISTS {schema}.request_version (
  request_id  text NOT NULL REFERENCES {schema}.request(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  config      jsonb NOT NULL,
  config_hash text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, version)
);

CREATE TABLE IF NOT EXISTS {schema}.check_result (
  request_id text NOT NULL,
  version    int  NOT NULL,
  key        text NOT NULL,
  label      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('pass','warn','fail')),
  detail     text NOT NULL DEFAULT '',
  ord        int  NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, version, key)
);

CREATE TABLE IF NOT EXISTS {schema}.approval (
  id         bigserial PRIMARY KEY,
  request_id text NOT NULL,
  version    int  NOT NULL,
  decision   text NOT NULL CHECK (decision IN ('approve','reject')),
  actor      text NOT NULL,
  reason     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {schema}.deployment_step (
  request_id text NOT NULL,
  version    int  NOT NULL,
  step       text NOT NULL,
  ord        int  NOT NULL,
  status     text NOT NULL CHECK (status IN ('pending','running','done','failed','skipped')),
  detail     text NOT NULL DEFAULT '',
  at         timestamptz,
  PRIMARY KEY (request_id, version, step)
);

-- Append-only audit trail: who did what, when, to which entity.
CREATE TABLE IF NOT EXISTS {schema}.audit (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text NOT NULL,
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON {schema}.audit (entity, entity_id, at);

-- Admins granted in the app (bootstrap admins come from PLATFORM_ADMINS, i.e. the deployer).
CREATE TABLE IF NOT EXISTS {schema}.app_admin (
  email         text PRIMARY KEY,
  granted_by    text NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  reason        text NOT NULL,
  revoked_by    text,
  revoked_at    timestamptz,
  revoke_reason text
);

-- Data owners who may approve requests; scope = 'domain:<name>' or 'domain:*'.
CREATE TABLE IF NOT EXISTS {schema}.approver (
  email         text NOT NULL,
  scope         text NOT NULL,
  granted_by    text NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  reason        text NOT NULL,
  revoked_by    text,
  revoked_at    timestamptz,
  PRIMARY KEY (email, scope)
);

-- Guardrails (allowed destinations, minimum refresh, cost caps, ...): business-authored, edited by admins in the app.
CREATE TABLE IF NOT EXISTS {schema}.policy (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {schema}.connector_override (
  id         text PRIMARY KEY,
  enabled    boolean NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Forecast model trained by the history job from system tables (one active version).
CREATE TABLE IF NOT EXISTS {schema}.forecast_model (
  version    text PRIMARY KEY,
  trained_at timestamptz NOT NULL,
  params     jsonb NOT NULL,
  metrics    jsonb NOT NULL,
  active     boolean NOT NULL DEFAULT false
);

-- Latest observed health per deployed pipeline (written by the guardian job and the app).
CREATE TABLE IF NOT EXISTS {schema}.pipeline_snapshot (
  request_id        text PRIMARY KEY,
  pipeline_id       text NOT NULL,
  state             text,
  health            text,
  last_update_at    timestamptz,
  last_update_state text,
  freshness_min     double precision,
  rows_last_update  bigint,
  cost_mtd_usd      double precision,
  recon             jsonb,
  incidents_open    int NOT NULL DEFAULT 0,
  observed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {schema}.incident (
  id          bigserial PRIMARY KEY,
  request_id  text NOT NULL,
  pipeline_id text,
  kind        text NOT NULL CHECK (kind IN ('transient','actionable')),
  status      text NOT NULL CHECK (status IN ('auto_healed','open','resolved')),
  title       text NOT NULL,
  detail      text NOT NULL DEFAULT '',
  ticket_ref  text,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS incident_request_idx ON {schema}.incident (request_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS {schema}.reconciliation (
  id          bigserial PRIMARY KEY,
  request_id  text NOT NULL,
  table_name  text NOT NULL,
  source_rows bigint,
  target_rows bigint,
  status      text NOT NULL CHECK (status IN ('match','drift','pending')),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recon_request_idx ON {schema}.reconciliation (request_id, at DESC);

CREATE TABLE IF NOT EXISTS {schema}.chat_session (
  id         text PRIMARY KEY,
  owner      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  turns      jsonb NOT NULL DEFAULT '[]'::jsonb,
  draft      jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text
);
