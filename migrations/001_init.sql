CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  provider      TEXT NOT NULL,
  version       TEXT DEFAULT '1.0.0',
  protocols     TEXT NOT NULL DEFAULT '["A2A"]',
  endpoint_url  TEXT,
  auth_type     TEXT DEFAULT 'none'
                CHECK (auth_type IN ('none','apikey','oauth')),
  auth_header   TEXT,
  status        TEXT DEFAULT 'active'
                CHECK (status IN ('active','inactive','degraded')),
  hosting       TEXT DEFAULT 'referenced'
                CHECK (hosting IN ('referenced','hosted')),
  agent_card    TEXT,
  tags          TEXT DEFAULT '[]',
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capabilities (
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL,
  PRIMARY KEY (agent_id, capability)
);

CREATE TABLE IF NOT EXISTS agent_embedding_map (
  rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id  TEXT UNIQUE NOT NULL REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  transport   TEXT NOT NULL
              CHECK (transport IN ('stdio','http','sse')),
  config_url  TEXT,
  package_url TEXT,
  tools       TEXT DEFAULT '[]',
  category    TEXT,
  author      TEXT,
  status      TEXT DEFAULT 'active',
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invocations (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
  caller      TEXT,
  status      TEXT CHECK (status IN ('success','error','timeout')),
  latency_ms  INTEGER,
  error_msg   TEXT,
  payload_size INTEGER,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS health_checks (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT REFERENCES agents(id) ON DELETE CASCADE,
  status      TEXT CHECK (status IN ('up','down','degraded')),
  latency_ms  INTEGER,
  error_msg   TEXT,
  checked_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invocations_agent
  ON invocations(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invocations_created
  ON invocations(created_at);
CREATE INDEX IF NOT EXISTS idx_health_agent
  ON health_checks(agent_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_agents_status
  ON agents(status);
