-- Sprint 3: multi-token auth with scopes + audit log
-- Tokens are stored as sha256 hash; the plaintext is shown to the
-- creator exactly once on POST /admin/tokens.

CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL DEFAULT 'read'
               CHECK (scope IN ('read', 'write', 'admin')),
  created_at   TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(hash);

CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT PRIMARY KEY,
  actor_token_id  TEXT,
  actor_name      TEXT,
  action          TEXT NOT NULL,        -- e.g. agent.create, mcp.delete, token.revoke
  target_type     TEXT,                 -- agent | mcp | token
  target_id       TEXT,
  before_state    TEXT,                 -- JSON or NULL
  after_state     TEXT,                 -- JSON or NULL
  ip              TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target  ON audit_log(target_type, target_id);
