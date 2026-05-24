-- Sprint 2: invocation modes + richer invocation rows
-- All ALTER statements may be re-run; db.js swallows "duplicate column" errors.

ALTER TABLE agents ADD COLUMN proxy_enabled INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN proxy_timeout_ms INTEGER DEFAULT 30000;

ALTER TABLE invocations ADD COLUMN response_size INTEGER;
ALTER TABLE invocations ADD COLUMN mode TEXT DEFAULT 'sdk'
  CHECK (mode IN ('sdk','proxy'));
ALTER TABLE invocations ADD COLUMN caller_agent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_inv_agent_time
  ON invocations(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inv_created
  ON invocations(created_at);
