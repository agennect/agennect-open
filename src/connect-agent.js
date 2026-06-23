// Built-in onboarding agent. Speaks A2A. Lives in-process: the invoke
// router detects `agents.is_builtin = 1` and dispatches POSTs to handle()
// here instead of fetching an endpoint_url.
//
// Two engines:
//   1. LLM extractor (when LLM_PROVIDER has chat credentials) — pulls
//      structured fields out of free-form input, returns the next prompt.
//   2. Rule-based state machine (fallback, always available) — walks the
//      caller through one field at a time, validates each.
//
// Conversation state is keyed by session_id (the A2A task id by default,
// or context.session_id if the caller threads their own).

import { db } from './db.js';
import { logger } from './logger.js';
import { structuredChat } from './chat.js';
import { SYSTEM_USER_ID } from './users.js';
import { audit } from './audit.js';
import { embed } from './embeddings.js';
import { generateAgentCard } from './a2a.js';

export const CONNECT_AGENT_ID = 'agennect-connect';

// ── Bootstrap ────────────────────────────────────────────────────────────
// Idempotent insert of the connect agent row on every server start.
// Owned by the system user; flagged is_builtin so invoke dispatches here.
export function bootstrapConnectAgent() {
  try {
    const exists = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(CONNECT_AGENT_ID);
    if (!exists) {
      db.prepare(`
        INSERT INTO agents (
          id, name, description, provider, version, protocols,
          endpoint_url, auth_type, status, hosting, tags,
          owner_user_id, is_builtin
        ) VALUES (
          ?, 'Agennect Connect',
          'Built-in onboarding agent. Walks developers through registering their own agent or MCP server via A2A conversation. Talks A2A, validates input, creates the resource on the caller''s behalf.',
          'Agennect (built-in)', '1.0.0',
          '["A2A"]',
          NULL, 'none', 'active', 'hosted', '["meta","onboarding"]',
          ?, 1
        )
      `).run(CONNECT_AGENT_ID, SYSTEM_USER_ID);

      const caps = [
        'Onboarding', 'A2A', 'Agent Registration', 'MCP Registration',
        'Validation', 'Conversational'
      ];
      const insertCap = db.prepare(
        `INSERT OR IGNORE INTO capabilities (agent_id, capability) VALUES (?, ?)`
      );
      for (const c of caps) insertCap.run(CONNECT_AGENT_ID, c);

      logger.info('connect agent bootstrapped', { id: CONNECT_AGENT_ID });
    } else {
      // Make sure the flag stays correct even if someone tampered with the row.
      db.prepare(`UPDATE agents SET is_builtin = 1, status = 'active' WHERE id = ?`)
        .run(CONNECT_AGENT_ID);
    }
  } catch (e) {
    logger.error('bootstrapConnectAgent failed', { err: e.message });
  }
}

// ── A2A entry point ──────────────────────────────────────────────────────
// Called by invoke.js when a request hits POST /agents/<built-in>/tasks.
// Returns { body, status } — invoke.js wraps with _agennect metadata.
export async function handle({ c, agent, task }) {
  const sessionId = task?.context?.session_id || task?.id || crypto.randomUUID();
  const userMessage = extractUserText(task);

  const session = loadOrCreateSession(sessionId, c.get('user')?.id || null);
  appendCollected(session, '__last_user_message', userMessage);

  // Try LLM extraction first; fall back to state machine.
  let step = null;
  if (PROVIDER_HAS_LLM()) {
    step = await runLLM(session, userMessage).catch(e => {
      logger.error('connect LLM step failed', { err: e.message });
      return null;
    });
  }
  if (!step) step = runStateMachine(session, userMessage);

  // Side-effect: if step says to submit, do it now.
  if (step.action === 'submit') {
    try {
      const created = await performSubmission(c, session);
      step.message = step.message
        || `Done. Your agent "${created.name}" is registered as \`${created.id}\`. Agent card: ${created.agent_card_url}`;
      session.state = 'done';
      session.intent = session.intent || 'register_agent';
    } catch (e) {
      step.message = `I tried to create the agent but it failed: ${e.message}. Want to fix the inputs and try again?`;
      session.state = 'review';   // bounce back to review so user can retry
    }
  }

  saveSession(session);

  return {
    status: 200,
    body: {
      id: task?.id || crypto.randomUUID(),
      status: { state: session.state === 'done' ? 'completed' : 'input-required' },
      result: { parts: [{ type: 'text', text: step.message }] },
      metadata: {
        session_id: sessionId,
        connect_state: session.state,
        collected: cleanCollected(session)
      }
    }
  };
}

// ── Card hook (used by generateAgentCard for the well-known JSON) ────────
// Lets the existing card generator describe this agent's skills correctly
// without needing special cases everywhere.
export const CONNECT_SKILLS = [
  { id: 'onboard_agent', name: 'Onboard agent',
    description: 'Guide a developer through registering a new agent in the registry.',
    inputModes: ['text/plain'], outputModes: ['application/json'] },
  { id: 'onboard_mcp', name: 'Onboard MCP server',
    description: 'Guide a developer through registering an MCP server.',
    inputModes: ['text/plain'], outputModes: ['application/json'] }
];

// ── Internals ────────────────────────────────────────────────────────────

function PROVIDER_HAS_LLM() {
  const p = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  if (p === 'mock') return false;
  if (p === 'anthropic') return !!(process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-...'));
  if (p === 'openai')    return !!(process.env.OPENAI_API_KEY    && !process.env.OPENAI_API_KEY.startsWith('sk-...'));
  if (p === 'ollama')    return true;  // assume reachable; chat.js will retry/skip on error
  return false;
}

function extractUserText(task) {
  const parts = task?.message?.parts || [];
  const textPart = parts.find(p => p.type === 'text' && typeof p.text === 'string');
  return (textPart?.text || '').trim();
}

function loadOrCreateSession(sessionId, userId) {
  const existing = db.prepare(
    `SELECT * FROM connect_sessions WHERE session_id = ?`
  ).get(sessionId);
  if (existing) {
    try { existing.collected = JSON.parse(existing.collected || '{}'); }
    catch (e) { existing.collected = {}; }
    return existing;
  }
  return {
    session_id: sessionId,
    user_id: userId,
    state: 'start',
    intent: null,
    collected: {}
  };
}

function saveSession(s) {
  db.prepare(`
    INSERT OR REPLACE INTO connect_sessions
      (session_id, user_id, state, intent, collected, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(
    s.session_id, s.user_id || null, s.state, s.intent || null,
    JSON.stringify(s.collected || {})
  );
}

function appendCollected(s, k, v) {
  s.collected = { ...(s.collected || {}), [k]: v };
}

function cleanCollected(s) {
  const c = { ...(s.collected || {}) };
  delete c.__last_user_message;
  return c;
}

// ── State machine engine ─────────────────────────────────────────────────
// Linear field-by-field walk for agent registration. Works without any
// external dependency; deterministic and easy to test.

const AGENT_FIELDS = [
  { key: 'name',         prompt: "What's the agent's name?",
    validate: v => v && v.length >= 1 ? null : 'Name must not be empty.' },
  { key: 'description',  prompt: "Give a short description (at least 20 characters) — what does the agent do, what makes it useful?",
    validate: v => v && v.length >= 20 ? null : 'Description must be at least 20 characters.' },
  { key: 'provider',     prompt: "Who provides this agent? (your org name)",
    validate: v => v && v.length >= 1 ? null : 'Provider must not be empty.' },
  { key: 'endpoint_url', prompt: "What's the agent's endpoint URL? (or say 'none' if you don't have one yet)",
    validate: v => v === 'none' || /^https?:\/\//.test(v || '') ? null : 'Endpoint must start with http(s):// or be \"none\".' },
  { key: 'capabilities', prompt: "List capabilities (comma-separated), e.g. \"EDA, SQL, BigQuery\". Or say 'none'.",
    validate: () => null }
];

function runStateMachine(session, msg) {
  // Step 0: pick intent
  if (session.state === 'start') {
    const m = (msg || '').toLowerCase();
    if (!msg) {
      return { action: 'ask', message:
        "Hi — I'm Connect, the registry's built-in onboarding agent. " +
        "Want me to help you register an **agent** or an **MCP server**? " +
        "(reply: agent, mcp)" };
    }
    if (m.includes('mcp')) {
      session.intent = 'register_mcp';
      session.state = 'mcp_not_implemented';
      return { action: 'ask', message:
        "MCP server onboarding isn't wired up in this build yet — only agent registration is. " +
        "Reply 'agent' to switch tracks, or come back after MCP onboarding ships." };
    }
    if (m.includes('agent')) {
      session.intent = 'register_agent';
      session.state = 'agent:' + AGENT_FIELDS[0].key;
      return { action: 'ask', message: AGENT_FIELDS[0].prompt };
    }
    return { action: 'ask', message:
      "Sorry, I didn't catch that. Reply 'agent' to register an agent, or 'mcp' for an MCP server." };
  }

  // Collecting agent fields one at a time
  if (session.state && session.state.startsWith('agent:')) {
    const currentKey = session.state.slice('agent:'.length);
    const idx = AGENT_FIELDS.findIndex(f => f.key === currentKey);
    if (idx < 0) {
      session.state = 'review';
      return runStateMachine(session, msg);
    }
    const field = AGENT_FIELDS[idx];
    const value = (msg || '').trim();
    const err = field.validate(value);
    if (err) {
      return { action: 'ask', message: `${err}\n\n${field.prompt}` };
    }
    if (field.key === 'capabilities') {
      const caps = value === 'none' ? [] : value.split(',').map(s => s.trim()).filter(Boolean);
      appendCollected(session, 'capabilities', caps);
    } else if (field.key === 'endpoint_url' && value === 'none') {
      appendCollected(session, 'endpoint_url', null);
    } else {
      appendCollected(session, field.key, value);
    }

    if (idx === AGENT_FIELDS.length - 1) {
      session.state = 'review';
      return { action: 'confirm', message: reviewMessage(session) };
    } else {
      session.state = 'agent:' + AGENT_FIELDS[idx + 1].key;
      return { action: 'ask', message: AGENT_FIELDS[idx + 1].prompt };
    }
  }

  // Review / confirm
  if (session.state === 'review') {
    const m = (msg || '').toLowerCase();
    if (/^(y(es)?|sure|ok(ay)?|do it|go|create|submit)/.test(m)) {
      return { action: 'submit', message: null };
    }
    if (/^(n(o)?|cancel|stop|abort)/.test(m)) {
      session.state = 'done';
      return { action: 'ask', message: 'Cancelled. Nothing was created.' };
    }
    return { action: 'confirm', message:
      "I didn't catch a yes / no. Reply 'yes' to create the agent, or 'no' to cancel.\n\n" +
      reviewMessage(session) };
  }

  if (session.state === 'done') {
    return { action: 'ask', message:
      "We're done. Start a new session (pass a new session_id) to register another." };
  }

  // Fallback
  session.state = 'start';
  return runStateMachine(session, msg);
}

function reviewMessage(s) {
  const c = s.collected || {};
  return [
    "Here's what I have:",
    `- name:         ${c.name}`,
    `- description:  ${c.description}`,
    `- provider:     ${c.provider}`,
    `- endpoint_url: ${c.endpoint_url ?? '(none)'}`,
    `- capabilities: ${(c.capabilities || []).join(', ') || '(none)'}`,
    "",
    "Create it? (yes / no)"
  ].join('\n');
}

// ── LLM engine ───────────────────────────────────────────────────────────
// One shot per turn. Asks the model to do four things at once:
//   - update the field collection with anything new in the user's message
//   - decide what to ask next (or 'ready' if we have everything)
//   - return the message we should send the caller
//
// Result is merged into session.collected. The state machine still drives
// "ready → submit" so the LLM never has to call our API itself.

const LLM_TOOL = {
  name: 'connect_step',
  description:
    'Take one turn of the agent-onboarding conversation. Read the user message, ' +
    'update the collected fields with anything explicit, decide which field to ask ' +
    'about next (or that we are ready to submit), and return the message to display.',
  schema: {
    type: 'object',
    required: ['collected', 'next_state', 'message'],
    properties: {
      collected: {
        type: 'object',
        description: "Updated cumulative fields. Keep any prior values; merge in new ones from the user's latest message.",
        properties: {
          name:         { type: 'string' },
          description:  { type: 'string' },
          provider:     { type: 'string' },
          endpoint_url: { type: ['string', 'null'] },
          capabilities: { type: 'array', items: { type: 'string' } }
        }
      },
      next_state: {
        type: 'string',
        enum: ['ask', 'review', 'submit', 'done'],
        description: "'ask' if you still need a field; 'review' once everything is collected (ask user to confirm); 'submit' when user has explicitly confirmed; 'done' when cancelled."
      },
      message: {
        type: 'string',
        description: 'The message to display to the user this turn. Must be short and natural.'
      }
    }
  }
};

const LLM_SYSTEM = [
  "You are Connect, the built-in onboarding agent for the agennect-open registry.",
  "Your job: walk a developer through registering a single agent. One required field at a time, then review, then submit when they confirm.",
  "Required fields, in this exact preference order if you need to ask: name, description (>=20 chars), provider, endpoint_url (or null), capabilities (array of short strings).",
  "Be terse and friendly. Never invent values the user didn't provide. If the user gave info already, do not re-ask. If everything is collected, transition to 'review' and show a summary. If the user explicitly confirms (yes / ok / submit), transition to 'submit'.",
  "Always return all currently-known fields in `collected`, even ones already gathered in prior turns."
].join('\n');

async function runLLM(session, userMessage) {
  const known = cleanCollected(session);
  const history = [{
    role: 'user',
    content:
      `Previously collected so far (as JSON):\n${JSON.stringify(known)}\n\n` +
      `Current state: ${session.state}\n\n` +
      `User's latest message: ${userMessage || '(no message — opening turn)'}\n\n` +
      "Take one onboarding step now. Use the `connect_step` tool."
  }];

  const out = await structuredChat({
    system: LLM_SYSTEM,
    messages: history,
    tool: LLM_TOOL,
    maxTokens: 600
  });
  if (!out) return null;  // signal fallback to state machine

  // Merge collected fields back into the session (LLM may have filled some).
  session.collected = { ...session.collected, ...(out.collected || {}) };
  // Map LLM state to our internal vocabulary
  if (out.next_state === 'submit') {
    session.state = 'review';   // performSubmission needs review state context
    return { action: 'submit', message: out.message };
  }
  if (out.next_state === 'review') {
    session.state = 'review';
    return { action: 'confirm', message: out.message };
  }
  if (out.next_state === 'done') {
    session.state = 'done';
    return { action: 'ask', message: out.message };
  }
  // Default: still asking
  // Pick a state name based on which field is still missing, so a later
  // fallback turn knows where to resume.
  const nextMissing = AGENT_FIELDS.find(f => !(session.collected || {})[f.key]);
  session.state = 'agent:' + (nextMissing?.key || AGENT_FIELDS[0].key);
  session.intent = session.intent || 'register_agent';
  return { action: 'ask', message: out.message };
}

// ── Submission ───────────────────────────────────────────────────────────
async function performSubmission(c, session) {
  const collected = session.collected || {};
  // Final validation through the same gates the route uses.
  if (!collected.name) throw new Error('name is required');
  if (!collected.description || collected.description.length < 20) {
    throw new Error('description must be at least 20 characters');
  }
  if (!collected.provider) throw new Error('provider is required');

  const id = slugify(collected.name) + '-' + randomHex(2);
  const protocols = JSON.stringify(['A2A']);
  const tags = JSON.stringify([]);
  const ownerUserId = c.get('user')?.id || SYSTEM_USER_ID;

  db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, version, protocols,
       endpoint_url, auth_type, hosting, tags, owner_user_id)
    VALUES (?, ?, ?, ?, '1.0.0', ?, ?, 'none', 'referenced', ?, ?)
  `).run(
    id,
    collected.name,
    collected.description,
    collected.provider,
    protocols,
    collected.endpoint_url || null,
    tags,
    ownerUserId
  );

  const insertCap = db.prepare(
    `INSERT OR IGNORE INTO capabilities (agent_id, capability) VALUES (?, ?)`
  );
  for (const cap of (collected.capabilities || [])) insertCap.run(id, cap);

  // Embedding is best-effort (mock mode + missing keys both tolerated)
  try {
    const text = [
      collected.name, collected.description,
      (collected.capabilities || []).join(' ')
    ].filter(Boolean).join(' ');
    const vector = await embed(text);
    const buf = Buffer.from(new Float32Array(vector).buffer);
    const info = db.prepare(
      `INSERT INTO agent_embedding_map (agent_id) VALUES (?)`
    ).run(id);
    db.prepare(
      `INSERT OR REPLACE INTO agent_embeddings (rowid, embedding) VALUES (?, ?)`
    ).run(info.lastInsertRowid, buf);
  } catch (e) {
    logger.warn('connect submission embedding failed (non-fatal)', { id, err: e.message });
  }

  const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
  const hydrated = {
    ...row,
    protocols: ['A2A'],
    capabilities: collected.capabilities || []
  };
  const registryUrl = process.env.REGISTRY_URL || `http://localhost:${process.env.PORT || 3000}`;
  const card = generateAgentCard(hydrated, registryUrl);
  db.prepare(`UPDATE agents SET agent_card = ? WHERE id = ?`)
    .run(JSON.stringify(card), id);

  audit(c, {
    action: 'agent.create',
    target_type: 'agent', target_id: id,
    after: { name: row.name, provider: row.provider, via: 'connect-agent' }
  });

  return {
    id,
    name: row.name,
    agent_card_url: `${registryUrl}/agents/${id}/.well-known/agent.json`
  };
}

function slugify(name) {
  return String(name)
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

function randomHex(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
