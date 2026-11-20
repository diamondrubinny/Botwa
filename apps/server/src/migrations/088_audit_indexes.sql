-- The audit log only had a date index. Lookups by conversation (prompt-injection attempts per conversation, hazards by building)
-- and by action over a period (the safety report) scanned the whole log, which grows for two years under the retention policy.
CREATE INDEX IF NOT EXISTS audit_target_idx ON audit_log (target, action) WHERE target IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_action_created_idx ON audit_log (action, created_at DESC);
