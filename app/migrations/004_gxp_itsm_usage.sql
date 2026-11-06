-- GxP (e-signatures, evidence, promotion lineage), ServiceNow links, reader grants, per-user usage (OBO + OTEL).
ALTER TABLE {schema}.request ADD COLUMN IF NOT EXISTS gxp boolean NOT NULL DEFAULT false;
ALTER TABLE {schema}.request ADD COLUMN IF NOT EXISTS parent_id text;          -- promotion: the lower-environment request
ALTER TABLE {schema}.request ADD COLUMN IF NOT EXISTS ticket_number text;      -- ServiceNow request number (REQ...)
ALTER TABLE {schema}.request DROP CONSTRAINT IF EXISTS request_channel_check;
ALTER TABLE {schema}.request ADD CONSTRAINT request_channel_check CHECK (channel IN ('app','chat','servicenow','api'));

-- 21 CFR Part 11: a signature = SSO identity + signing PIN (second component), bound to the config content hash.
CREATE TABLE IF NOT EXISTS {schema}.signing_pin (
  email         text PRIMARY KEY,
  pin_hash      text NOT NULL,          -- scrypt$N$r$p$salt$hash; the PIN itself is never stored or logged
  set_at        timestamptz NOT NULL DEFAULT now(),
  failed        int NOT NULL DEFAULT 0,
  locked_until  timestamptz
);

CREATE TABLE IF NOT EXISTS {schema}.e_signature (
  id            bigserial PRIMARY KEY,
  request_id    text NOT NULL,
  version       int  NOT NULL,
  config_hash   text NOT NULL,
  signer        text NOT NULL,
  printed_name  text NOT NULL,
  meaning       text NOT NULL CHECK (meaning IN ('Approved','Rejected','Released to UAT','Released to Production','Reviewed')),
  reason        text NOT NULL,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  manifest_hash text NOT NULL           -- sha256(signer|meaning|signed_at|request|version|config_hash)
);
CREATE INDEX IF NOT EXISTS esig_request_idx ON {schema}.e_signature (request_id, version);

-- Operational qualification runs + evidence packs (the ZIP also goes to a UC volume)
CREATE TABLE IF NOT EXISTS {schema}.gxp_evidence (
  id          bigserial PRIMARY KEY,
  request_id  text NOT NULL,
  version     int  NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('oq','release')),
  verdict     text NOT NULL CHECK (verdict IN ('PASS','FAIL','PASS_WITH_DEVIATIONS')),
  results     jsonb NOT NULL,
  sha256      text NOT NULL,
  volume_path text,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_request_idx ON {schema}.gxp_evidence (request_id, created_at DESC);

-- ServiceNow records linked to requests / incidents
CREATE TABLE IF NOT EXISTS {schema}.itsm_link (
  id          bigserial PRIMARY KEY,
  request_id  text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('request','incident')),
  incident_id bigint,
  table_name  text NOT NULL,
  sys_id      text NOT NULL,
  number      text,
  url         text,
  state       text,
  synced_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS itsm_request_idx ON {schema}.itsm_link (request_id, kind);

-- Read-only grants given to people on the landed tables (the source stays service-principal only)
CREATE TABLE IF NOT EXISTS {schema}.reader_grant (
  request_id  text NOT NULL,
  principal   text NOT NULL,
  securable   text NOT NULL,            -- catalog | schema | table full name
  privileges  text NOT NULL,
  status      text NOT NULL CHECK (status IN ('granted','pending','failed')),
  detail      text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, principal, securable)
);

-- Per-user usage captured from the forwarded identity (OBO); also exported as OpenTelemetry
CREATE TABLE IF NOT EXISTS {schema}.usage_event (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  user_email  text NOT NULL,
  kind        text NOT NULL,            -- api | login | action
  method      text,
  route       text,
  status      int,
  duration_ms double precision,
  request_id  text,
  trace_id    text,
  obo         boolean NOT NULL DEFAULT false,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS usage_user_idx ON {schema}.usage_event (user_email, at DESC);
CREATE INDEX IF NOT EXISTS usage_at_idx ON {schema}.usage_event (at DESC);

-- Built-in ServiceNow Table API simulator (used only when no instance is configured; clearly labelled)
CREATE TABLE IF NOT EXISTS {schema}.snow_sim_record (
  table_name  text NOT NULL,
  sys_id      text NOT NULL,
  number      text,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, sys_id)
);
CREATE SEQUENCE IF NOT EXISTS {schema}.snow_sim_seq START 10001;
