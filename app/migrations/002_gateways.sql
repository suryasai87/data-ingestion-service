-- Shared ingestion gateways: one always-on gateway per (connection, source database), reused by CDC requests.
CREATE TABLE IF NOT EXISTS {schema}.gateway (
  connection_name  text NOT NULL,
  source_database  text NOT NULL DEFAULT '',
  pipeline_id      text NOT NULL,
  slot_name        text,
  publication_name text,
  created_by_request text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  stopped_at       timestamptz,
  PRIMARY KEY (connection_name, source_database)
);
