-- Per-user warehouse usage of the app's on-behalf-of queries (guardian, from system.query.history; the app's OBO
-- statements carry the marker comment /* dis-obo */ so they can be told apart from the user's other work).
CREATE TABLE IF NOT EXISTS {schema}.usage_rollup (
  user_email  text NOT NULL,
  day         date NOT NULL,
  queries     bigint NOT NULL DEFAULT 0,
  duration_ms double precision NOT NULL DEFAULT 0,
  read_bytes  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_email, day)
);
