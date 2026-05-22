import { Hono } from 'hono';
import { db } from '../db.js';
import { embed } from '../embeddings.js';
import { generateAgentCard } from '../a2a.js';

export const agentsRouter = new Hono();

function requireAdmin(c) {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

function randomHex(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getAgentCapabilities(agentId) {
  const rows = db.prepare(
    `SELECT capability FROM capabilities WHERE agent_id = ?`
  ).all(agentId);
  return rows.map(r => r.capability);
}

function hydrateAgent(row) {
  if (!row) return null;
  return {
    ...row,
    protocols: safeParse(row.protocols, ['A2A']),
    tags: safeParse(row.tags, []),
    capabilities: getAgentCapabilities(row.id)
  };
}

function safeParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    console.error('safeParse failed:', e.message);
    return fallback;
  }
}

function embeddingText(name, description, capabilities) {
  return [name, description, (capabilities || []).join(' ')]
    .filter(Boolean)
    .join(' ');
}

async function storeEmbedding(agentId, text) {
  try {
    const vector = await embed(text);
    const buf = Buffer.from(new Float32Array(vector).buffer);

    let row = db.prepare(
      `SELECT rowid FROM agent_embedding_map WHERE agent_id = ?`
    ).get(agentId);

    if (!row) {
      const info = db.prepare(
        `INSERT INTO agent_embedding_map (agent_id) VALUES (?)`
      ).run(agentId);
      row = { rowid: info.lastInsertRowid };
    }

    db.prepare(
      `INSERT OR REPLACE INTO agent_embeddings (rowid, embedding)
       VALUES (?, ?)`
    ).run(row.rowid, buf);
    return true;
  } catch (e) {
    console.error(`storeEmbedding(${agentId}) failed:`, e.message);
    return false;
  }
}

// GET /agents — list with filters
agentsRouter.get('/', (c) => {
  try {
    const { status, protocol, hosting } = c.req.query();
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (hosting) { where.push('hosting = ?'); params.push(hosting); }
    if (protocol) { where.push("protocols LIKE ?"); params.push(`%"${protocol}"%`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(
      `SELECT COUNT(*) as cnt FROM agents ${whereSql}`
    ).get(...params).cnt;

    const rows = db.prepare(
      `SELECT * FROM agents ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    return c.json({
      agents: rows.map(hydrateAgent),
      total,
      page,
      limit
    });
  } catch (e) {
    console.error('GET /agents failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// GET /agents/search?q=
agentsRouter.get('/search', async (c) => {
  const q = c.req.query('q');
  if (!q) {
    return c.json({ error: 'Query parameter q is required' }, 400);
  }

  try {
    const vector = await embed(q);
    const buf = Buffer.from(new Float32Array(vector).buffer);

    const limit = Math.min(50, parseInt(c.req.query('limit') || '10'));

    const rows = db.prepare(
      `SELECT ae.rowid AS rowid, distance
       FROM agent_embeddings ae
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    ).all(buf, limit);

    const results = [];
    for (const row of rows) {
      const map = db.prepare(
        `SELECT agent_id FROM agent_embedding_map WHERE rowid = ?`
      ).get(row.rowid);
      if (!map) continue;
      const agent = db.prepare(
        `SELECT * FROM agents WHERE id = ?`
      ).get(map.agent_id);
      if (!agent) continue;
      results.push({
        agent: hydrateAgent(agent),
        score: 1 / (1 + row.distance),
        distance: row.distance
      });
    }

    return c.json({ results, query: q });
  } catch (e) {
    console.error('GET /agents/search failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// GET /agents/:id/.well-known/agent.json
agentsRouter.get('/:id/.well-known/agent.json', (c) => {
  try {
    const id = c.req.param('id');
    const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
    if (!row) return c.json({ error: 'Agent not found' }, 404);

    const agent = hydrateAgent(row);
    const registryUrl = process.env.REGISTRY_URL || `http://localhost:${process.env.PORT || 3000}`;
    const card = generateAgentCard(agent, registryUrl);

    c.header('Content-Type', 'application/json');
    return c.body(JSON.stringify(card, null, 2));
  } catch (e) {
    console.error('GET agent card failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// GET /agents/:id/health
agentsRouter.get('/:id/health', (c) => {
  try {
    const id = c.req.param('id');
    const exists = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(id);
    if (!exists) return c.json({ error: 'Agent not found' }, 404);

    const checks = db.prepare(
      `SELECT id, status, latency_ms, error_msg, checked_at
       FROM health_checks
       WHERE agent_id = ?
         AND checked_at > datetime('now', '-24 hours')
       ORDER BY checked_at DESC`
    ).all(id);

    const total = checks.length;
    const upCount = checks.filter(c => c.status === 'up').length;
    const uptime_pct = total > 0 ? Math.round((upCount / total) * 10000) / 100 : null;

    return c.json({
      agent_id: id,
      uptime_pct,
      total_checks: total,
      last_seen: checks[0]?.checked_at || null,
      checks
    });
  } catch (e) {
    console.error('GET agent health failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// GET /agents/:id
agentsRouter.get('/:id', (c) => {
  try {
    const id = c.req.param('id');
    const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
    if (!row) return c.json({ error: 'Agent not found' }, 404);
    return c.json(hydrateAgent(row));
  } catch (e) {
    console.error('GET /agents/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// POST /agents — admin
agentsRouter.post('/', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    console.error('POST /agents body parse failed:', e.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const errors = validateAgentBody(body, { required: true });
  if (errors.length) return c.json({ error: errors.join('; ') }, 400);

  const id = `${slugify(body.name)}-${randomHex(2)}`;
  const protocols = JSON.stringify(body.protocols || ['A2A']);
  const tags = JSON.stringify(body.tags || []);

  try {
    db.prepare(
      `INSERT INTO agents
       (id, name, description, provider, version, protocols,
        endpoint_url, auth_type, auth_header, hosting, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      body.name,
      body.description,
      body.provider,
      body.version || '1.0.0',
      protocols,
      body.endpoint_url || null,
      body.auth_type || 'none',
      body.auth_header || null,
      body.hosting || 'referenced',
      tags
    );

    const caps = Array.isArray(body.capabilities) ? body.capabilities : [];
    const insertCap = db.prepare(
      `INSERT OR IGNORE INTO capabilities (agent_id, capability) VALUES (?, ?)`
    );
    for (const cap of caps) {
      insertCap.run(id, cap);
    }

    await storeEmbedding(id, embeddingText(body.name, body.description, caps));

    const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
    const agent = hydrateAgent(row);
    const registryUrl = process.env.REGISTRY_URL || `http://localhost:${process.env.PORT || 3000}`;
    const card = generateAgentCard(agent, registryUrl);

    db.prepare(`UPDATE agents SET agent_card = ? WHERE id = ?`)
      .run(JSON.stringify(card), id);

    return c.json({
      id,
      status: 'created',
      agent_card_url: `${registryUrl}/agents/${id}/.well-known/agent.json`
    }, 201);
  } catch (e) {
    console.error('POST /agents failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// PUT /agents/:id — admin
agentsRouter.put('/:id', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const id = c.req.param('id');
  const existing = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
  if (!existing) return c.json({ error: 'Agent not found' }, 404);

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    console.error('PUT /agents body parse failed:', e.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const errors = validateAgentBody(body, { required: false });
  if (errors.length) return c.json({ error: errors.join('; ') }, 400);

  try {
    const updates = [];
    const params = [];

    const setField = (col, val) => { updates.push(`${col} = ?`); params.push(val); };

    if (body.name !== undefined) setField('name', body.name);
    if (body.description !== undefined) setField('description', body.description);
    if (body.provider !== undefined) setField('provider', body.provider);
    if (body.version !== undefined) setField('version', body.version);
    if (body.protocols !== undefined) setField('protocols', JSON.stringify(body.protocols));
    if (body.endpoint_url !== undefined) setField('endpoint_url', body.endpoint_url);
    if (body.auth_type !== undefined) setField('auth_type', body.auth_type);
    if (body.auth_header !== undefined) setField('auth_header', body.auth_header);
    if (body.hosting !== undefined) setField('hosting', body.hosting);
    if (body.status !== undefined) setField('status', body.status);
    if (body.tags !== undefined) setField('tags', JSON.stringify(body.tags));
    updates.push("updated_at = datetime('now')");

    if (params.length > 0) {
      db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }

    if (Array.isArray(body.capabilities)) {
      db.prepare(`DELETE FROM capabilities WHERE agent_id = ?`).run(id);
      const insertCap = db.prepare(
        `INSERT OR IGNORE INTO capabilities (agent_id, capability) VALUES (?, ?)`
      );
      for (const cap of body.capabilities) insertCap.run(id, cap);
    }

    const needsReembed =
      body.name !== undefined ||
      body.description !== undefined ||
      body.capabilities !== undefined;

    if (needsReembed) {
      const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
      const caps = getAgentCapabilities(id);
      await storeEmbedding(id, embeddingText(row.name, row.description, caps));
    }

    const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
    return c.json(hydrateAgent(row));
  } catch (e) {
    console.error('PUT /agents/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// DELETE /agents/:id — admin (soft delete)
agentsRouter.delete('/:id', (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const id = c.req.param('id');
  try {
    const existing = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(id);
    if (!existing) return c.json({ error: 'Agent not found' }, 404);

    db.prepare(
      `UPDATE agents SET status = 'inactive', updated_at = datetime('now')
       WHERE id = ?`
    ).run(id);
    return c.json({ ok: true });
  } catch (e) {
    console.error('DELETE /agents/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

function validateAgentBody(body, { required }) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    errors.push('Body must be an object');
    return errors;
  }
  if (required) {
    if (!body.name) errors.push('name is required');
    if (!body.description) errors.push('description is required');
    if (!body.provider) errors.push('provider is required');
  }
  if (body.description && body.description.length < 20) {
    errors.push('description must be at least 20 characters');
  }
  if (body.auth_type && !['none', 'apikey', 'oauth'].includes(body.auth_type)) {
    errors.push('auth_type must be one of: none, apikey, oauth');
  }
  if (body.hosting && !['referenced', 'hosted'].includes(body.hosting)) {
    errors.push('hosting must be referenced or hosted');
  }
  if (body.status && !['active', 'inactive', 'degraded'].includes(body.status)) {
    errors.push('status must be active, inactive, or degraded');
  }
  return errors;
}
