-- A durable "paused by the service" flag per pipeline (cost control). The schedule job is paused and the pipeline
-- stopped while it is set; Unpause clears it, turns the schedule back on and starts an update.
ALTER TABLE {schema}.pipeline_snapshot ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE {schema}.pipeline_snapshot ADD COLUMN IF NOT EXISTS paused_by text;
UPDATE {schema}.pipeline_snapshot SET paused_at = observed_at, paused_by = 'service'
 WHERE state = 'PAUSED' AND paused_at IS NULL;
