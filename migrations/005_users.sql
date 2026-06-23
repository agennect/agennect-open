-- Sprint 5: users + per-resource ownership
--
-- External SSO model: users authenticate via an external provider
-- (Firebase, Auth0, Keycloak, ...). We store the provider name + the
-- provider's subject identifier and JIT-create the row on first login.
-- Local password fields are intentionally absent — passwords live in
-- the IdP.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  provider      TEXT NOT NULL,        -- 'firebase' | 'auth0' | 'system' | ...
  provider_sub  TEXT NOT NULL,        -- the IdP's stable subject id
  role          TEXT NOT NULL DEFAULT 'user'
                CHECK (role IN ('user', 'admin')),
  created_at    TEXT DEFAULT (datetime('now')),
  last_login_at TEXT,
  disabled_at   TEXT,
  UNIQUE (provider, provider_sub)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Synthetic 'system' user. Owns every agent and MCP server that
-- existed before Sprint 5 so the ownership rule has something to
-- evaluate. Only admins can mutate system-owned resources.
INSERT OR IGNORE INTO users (id, email, name, provider, provider_sub, role)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'system@agennect.local',
  'System (legacy data)',
  'system',
  'system',
  'admin'
);

-- Tokens get a user_id link. Existing API tokens (like env-bootstrap)
-- stay user-less and behave as before; new session tokens minted via
-- /auth/login carry their owner.
ALTER TABLE tokens ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

-- Resource ownership.
ALTER TABLE agents      ADD COLUMN owner_user_id TEXT REFERENCES users(id);
ALTER TABLE mcp_servers ADD COLUMN owner_user_id TEXT REFERENCES users(id);

UPDATE agents      SET owner_user_id = '00000000-0000-0000-0000-000000000001' WHERE owner_user_id IS NULL;
UPDATE mcp_servers SET owner_user_id = '00000000-0000-0000-0000-000000000001' WHERE owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_owner    ON mcp_servers(owner_user_id);
