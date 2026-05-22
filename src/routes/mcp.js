import { Hono } from 'hono';
import { db } from '../db.js';

export const mcpRouter = new Hono();

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

function hydrateServer(row) {
  if (!row) return null;
  let tools = [];
  try {
    tools = JSON.parse(row.tools || '[]');
  } catch (e) {
    console.error('mcp tools parse failed:', e.message);
  }
  return { ...row, tools };
}

// GET /mcp — list active servers
mcpRouter.get('/', (c) => {
  try {
    const { category, transport, status } = c.req.query();
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    if (status === 'all') {
      // no status filter
    } else if (status) {
      where.push('status = ?');
      params.push(status);
    } else {
      where.push("status = 'active'");
    }
    if (category) { where.push('category = ?'); params.push(category); }
    if (transport) { where.push('transport = ?'); params.push(transport); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(
      `SELECT COUNT(*) as cnt FROM mcp_servers ${whereSql}`
    ).get(...params).cnt;

    const rows = db.prepare(
      `SELECT * FROM mcp_servers ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    return c.json({
      servers: rows.map(hydrateServer),
      total,
      page,
      limit
    });
  } catch (e) {
    console.error('GET /mcp failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// GET /mcp/:id
mcpRouter.get('/:id', (c) => {
  try {
    const id = c.req.param('id');
    const row = db.prepare(`SELECT * FROM mcp_servers WHERE id = ?`).get(id);
    if (!row) return c.json({ error: 'MCP server not found' }, 404);
    return c.json(hydrateServer(row));
  } catch (e) {
    console.error('GET /mcp/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// POST /mcp — admin
mcpRouter.post('/', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    console.error('POST /mcp body parse failed:', e.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const errors = [];
  if (!body.name) errors.push('name is required');
  if (!body.description) errors.push('description is required');
  if (!body.transport) errors.push('transport is required');
  if (body.transport && !['stdio', 'http', 'sse'].includes(body.transport)) {
    errors.push('transport must be one of: stdio, http, sse');
  }
  if (errors.length) return c.json({ error: errors.join('; ') }, 400);

  const id = `${slugify(body.name)}-${randomHex(2)}`;
  const tools = JSON.stringify(Array.isArray(body.tools) ? body.tools : []);

  try {
    db.prepare(
      `INSERT INTO mcp_servers
       (id, name, description, transport, config_url, package_url,
        tools, category, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      body.name,
      body.description,
      body.transport,
      body.config_url || null,
      body.package_url || null,
      tools,
      body.category || null,
      body.author || null
    );
    return c.json({ id, name: body.name }, 201);
  } catch (e) {
    console.error('POST /mcp failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// PUT /mcp/:id — admin (update; only provided fields)
mcpRouter.put('/:id', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const id = c.req.param('id');
  const existing = db.prepare(`SELECT id FROM mcp_servers WHERE id = ?`).get(id);
  if (!existing) return c.json({ error: 'MCP server not found' }, 404);

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    console.error('PUT /mcp body parse failed:', e.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const errors = [];
  if (body.transport && !['stdio', 'http', 'sse'].includes(body.transport)) {
    errors.push('transport must be one of: stdio, http, sse');
  }
  if (body.status && !['active', 'inactive'].includes(body.status)) {
    errors.push('status must be active or inactive');
  }
  if (errors.length) return c.json({ error: errors.join('; ') }, 400);

  try {
    const updates = [];
    const params = [];
    const set = (col, val) => { updates.push(`${col} = ?`); params.push(val); };

    if (body.name !== undefined)        set('name', body.name);
    if (body.description !== undefined) set('description', body.description);
    if (body.transport !== undefined)   set('transport', body.transport);
    if (body.config_url !== undefined)  set('config_url', body.config_url);
    if (body.package_url !== undefined) set('package_url', body.package_url);
    if (body.tools !== undefined)       set('tools', JSON.stringify(body.tools));
    if (body.category !== undefined)    set('category', body.category);
    if (body.author !== undefined)      set('author', body.author);
    if (body.status !== undefined)      set('status', body.status);

    if (updates.length) {
      db.prepare(`UPDATE mcp_servers SET ${updates.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }

    const row = db.prepare(`SELECT * FROM mcp_servers WHERE id = ?`).get(id);
    return c.json(hydrateServer(row));
  } catch (e) {
    console.error('PUT /mcp/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// DELETE /mcp/:id — admin (soft delete)
mcpRouter.delete('/:id', (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  try {
    const id = c.req.param('id');
    const existing = db.prepare(`SELECT id FROM mcp_servers WHERE id = ?`).get(id);
    if (!existing) return c.json({ error: 'MCP server not found' }, 404);

    db.prepare(
      `UPDATE mcp_servers SET status = 'inactive' WHERE id = ?`
    ).run(id);
    return c.json({ ok: true });
  } catch (e) {
    console.error('DELETE /mcp/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});
