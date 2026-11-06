-- Partial snapshot writes (e.g. reconciliation only) must not fail: Postgres checks NOT NULL on the proposed insert
-- row before ON CONFLICT resolves, so a missing incidents_open broke the upsert (found by the live test).
ALTER TABLE {schema}.pipeline_snapshot ALTER COLUMN incidents_open DROP NOT NULL;
