import { Hono } from 'hono';
import { db } from '../db.js';
import { audit } from '../audit.js';
import {
  generateToken,
  hashToken,
  requireScope,
  BOOTSTRAP_NAME
} from '../auth.js';

export const adminRouter = new Hono();

// ── POST /admin/tokens ────────────────────────────────────────────────────────
// Create a new token. Returns the plaintext exactly once.
// Body: { name: "...", scope: "read"|"write"|"admin" }

adminRouter.post('/tokens', async (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  let body;
  try { body = await c.req.json(); }
  catch (e) {
    console.error('POST /admin/tokens body parse failed:', e.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = (body?.name || '').trim();
  const scope = body?.scope || 'read';
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!['read', 'write', 'admin'].includes(scope)) {
    return c.json({ error: 'scope must be read, write, or admin' }, 400);
  }
  if (name === BOOTSTRAP_NAME) {
    return c.json({ error: `name '${BOOTSTRAP_NAME}' is reserved` }, 400);
  }

  const raw = generateToken();
  const id  = crypto.randomUUID();

  try {
    db.prepare(
      `INSERT INTO tokens (id, name, hash, scope) VALUES (?, ?, ?, ?)`
    ).run(id, name, hashToken(raw), scope);
  } catch (e) {
    console.error('POST /admin/tokens insert failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  audit(c, {
    action: 'token.create',
    target_type: 'token', target_id: id,
    after: { name, scope }
  });

  return c.json({
    id, name, scope,
    token: raw,
    warning: 'This is the only time the token will be shown. Store it securely.'
  }, 201);
});

// ── GET /admin/tokens ─────────────────────────────────────────────────────────

adminRouter.get('/tokens', (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  try {
    const rows = db.prepare(`
      SELECT id, name, scope, created_at, last_used_at, revoked_at
      FROM tokens ORDER BY created_at DESC
    `).all();
    return c.json({ tokens: rows });
  } catch (e) {
    console.error('GET /admin/tokens failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// ── DELETE /admin/tokens/:id ──────────────────────────────────────────────────
// Soft-revoke. The bootstrap token can be revoked but will be re-armed
// on the next server restart (auth.bootstrapEnvToken).

adminRouter.delete('/tokens/:id', (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  const id = c.req.param('id');
  const existing = db.prepare(
    `SELECT id, name, scope, revoked_at FROM tokens WHERE id = ?`
  ).get(id);
  if (!existing) return c.json({ error: 'Token not found' }, 404);

  // Don't let admins lock themselves out by revoking their own token.
  const actor = c.get('token');
  if (actor && actor.id === id) {
    return c.json({ error: 'Refusing to revoke the token you are using' }, 400);
  }

  try {
    db.prepare(
      `UPDATE tokens SET revoked_at = datetime('now') WHERE id = ?`
    ).run(id);
  } catch (e) {
    console.error('DELETE /admin/tokens/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  audit(c, {
    action: 'token.revoke',
    target_type: 'token', target_id: id,
    before: { name: existing.name, scope: existing.scope }
  });

  return c.json({ ok: true });
});

// ── GET /admin/audit ──────────────────────────────────────────────────────────
// Filters: action, target_type, target_id, limit (default 100, max 500).

adminRouter.get('/audit', (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);
  const where = [];
  const params = [];

  for (const col of ['action', 'target_type', 'target_id']) {
    const v = c.req.query(col);
    if (v) { where.push(`${col} = ?`); params.push(v); }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const rows = db.prepare(`
      SELECT id, actor_token_id, actor_name, action,
             target_type, target_id, before_state, after_state, ip, created_at
      FROM audit_log
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, limit);

    return c.json({
      total: rows.length,
      entries: rows.map(r => ({
        ...r,
        before: r.before_state ? safeParse(r.before_state) : null,
        after:  r.after_state  ? safeParse(r.after_state)  : null,
        before_state: undefined,
        after_state: undefined
      }))
    });
  } catch (e) {
    console.error('GET /admin/audit failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

function safeParse(json) {
  try { return JSON.parse(json); }
  catch (e) {
    console.error('audit safeParse failed:', e.message);
    return null;
  }
}
