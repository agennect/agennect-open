-- Sprint 8: built-in agent flag + connect-agent conversation state
--
-- is_builtin = 1 marks rows that the invoke router should dispatch to
-- an in-process handler instead of fetching endpoint_url. They also
-- skip the health-check loop.

ALTER TABLE agents ADD COLUMN is_builtin INTEGER DEFAULT 0;

-- Per-conversation state for the onboarding Connect Agent.
-- session_id is the A2A task id (or a value the client sends in
-- context.session_id). state is the FSM state name; collected is a JSON
-- blob of the fields the user has provided so far.
CREATE TABLE IF NOT EXISTS connect_sessions (
  session_id  TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  state       TEXT NOT NULL DEFAULT 'start',
  intent      TEXT,                -- 'register_agent' | 'register_mcp' (set after start)
  collected   TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT DEFAULT (datetime('now')),
  expires_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_connect_sessions_user ON connect_sessions(user_id);
