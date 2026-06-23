-- Sprint 4: outbound webhooks
-- Each row subscribes a URL to one or more event names.
-- secret_hash stores sha256(secret); the plaintext is shown exactly once
-- on creation and used by the receiver to verify the HMAC signature.

CREATE TABLE IF NOT EXISTS webhooks (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  events            TEXT NOT NULL DEFAULT '["*"]',
  secret_hash       TEXT NOT NULL,
  created_at        TEXT DEFAULT (datetime('now')),
  last_delivery_at  TEXT,
  last_status       INTEGER,
  last_error        TEXT,
  delivery_count    INTEGER DEFAULT 0,
  failure_count     INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_webhooks_created ON webhooks(created_at);
