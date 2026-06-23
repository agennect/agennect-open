import { Hono } from 'hono';
import { db } from '../db.js';
import { audit } from '../audit.js';
import {
  generateToken,
  hashToken,
  requireScope,
  BOOTSTRAP_NAME
} from '../auth.js';
import { generateWebhookSecret, hashSecret, dispatchEvent } from '../webhooks.js';

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

// ── /admin/users ──────────────────────────────────────────────────────────────

adminRouter.get('/users', (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  try {
    const rows = db.prepare(`
      SELECT
        u.id, u.email, u.name, u.role, u.provider, u.provider_sub,
        u.created_at, u.last_login_at, u.disabled_at,
        (SELECT COUNT(*) FROM agents      a WHERE a.owner_user_id = u.id) AS agents_owned,
        (SELECT COUNT(*) FROM mcp_servers m WHERE m.owner_user_id = u.id) AS mcp_owned
      FROM users u
      ORDER BY u.created_at DESC
    `).all();
    return c.json({ users: rows });
  } catch (e) {
    console.error('GET /admin/users failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

adminRouter.put('/users/:id', async (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  const id = c.req.param('id');
  const existing = db.prepare(
    `SELECT id, email, role, disabled_at, provider FROM users WHERE id = ?`
  ).get(id);
  if (!existing) return c.json({ error: 'User not found' }, 404);
  if (existing.provider === 'system') {
    return c.json({ error: 'The system user cannot be modified' }, 400);
  }

  let body;
  try { body = await c.req.json(); }
  catch (e) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Refuse to lock the caller out of admin access.
  const actor = c.get('user');
  if (actor && actor.id === id && body.role === 'user') {
    return c.json({ error: 'Refusing to demote the user you are signed in as' }, 400);
  }
  if (actor && actor.id === id && body.disabled === true) {
    return c.json({ error: 'Refusing to disable the user you are signed in as' }, 400);
  }

  const updates = [];
  const params = [];
  let roleChanged = false;
  let disabledChanged = false;

  if (body.role !== undefined) {
    if (!['user', 'admin'].includes(body.role)) {
      return c.json({ error: "role must be 'user' or 'admin'" }, 400);
    }
    if (body.role !== existing.role) {
      updates.push('role = ?'); params.push(body.role);
      roleChanged = true;
    }
  }

  if (body.disabled !== undefined) {
    const wantDisabled = Boolean(body.disabled);
    const isDisabled = !!existing.disabled_at;
    if (wantDisabled !== isDisabled) {
      updates.push('disabled_at = ?');
      params.push(wantDisabled ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null);
      disabledChanged = true;
    }
  }

  try {
    if (updates.length) {
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }

    // On role change or disable, revoke all the user's session tokens so
    // the new state takes effect immediately on their next request.
    if (roleChanged || disabledChanged) {
      db.prepare(
        `UPDATE tokens SET revoked_at = datetime('now')
         WHERE user_id = ? AND revoked_at IS NULL`
      ).run(id);
    }
  } catch (e) {
    console.error('PUT /admin/users/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  const after = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);

  audit(c, {
    action: 'user.update',
    target_type: 'user', target_id: id,
    before: { role: existing.role, disabled_at: existing.disabled_at },
    after:  { role: after.role,    disabled_at: after.disabled_at }
  });

  return c.json({
    id: after.id, email: after.email, role: after.role,
    disabled_at: after.disabled_at,
    sessions_revoked: roleChanged || disabledChanged
  });
});

// ── /admin/webhooks ───────────────────────────────────────────────────────────

const KNOWN_EVENTS = [
  '*',
  'agent.create', 'agent.update', 'agent.delete',
  'mcp.create',   'mcp.update',   'mcp.delete',
  'token.create', 'token.revoke',
  'webhook.create', 'webhook.delete', 'webhook.pause', 'webhook.resume', 'webhook.test',
  'user.update',  'user.login',     'user.logout'
];

adminRouter.post('/webhooks', async (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  let body;
  try { body = await c.req.json(); }
  catch (e) {
    console.error('POST /admin/webhooks body parse failed:', e.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = (body?.name || '').trim();
  const url  = (body?.url  || '').trim();
  const events = Array.isArray(body?.events) && body.events.length
    ? body.events
    : ['*'];

  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!url || !/^https?:\/\//.test(url)) {
    return c.json({ error: 'url is required and must start with http(s)://' }, 400);
  }
  for (const e of events) {
    if (!KNOWN_EVENTS.includes(e) && !KNOWN_EVENTS.some(k => k.endsWith('.*') && e === k)) {
      return c.json({
        error: `unknown event '${e}'. Known: ${KNOWN_EVENTS.join(', ')}`
      }, 400);
    }
  }

  const id = crypto.randomUUID();
  const secret = generateWebhookSecret();

  try {
    db.prepare(`
      INSERT INTO webhooks (id, name, url, events, secret_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, url, JSON.stringify(events), hashSecret(secret));
  } catch (e) {
    console.error('POST /admin/webhooks insert failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  audit(c, {
    action: 'webhook.create',
    target_type: 'webhook', target_id: id,
    after: { name, url, events }
  });

  return c.json({
    id, name, url, events,
    secret,
    signing_note: 'Use sha256(secret) as the HMAC key when verifying X-Agennect-Signature. Stored only as a hash; shown once.',
    warning: 'This is the only time the secret will be shown.'
  }, 201);
});

adminRouter.get('/webhooks', (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  try {
    const rows = db.prepare(`
      SELECT id, name, url, events, created_at,
             last_delivery_at, last_status, last_error,
             delivery_count, failure_count, paused_at
      FROM webhooks ORDER BY created_at DESC
    `).all();
    return c.json({
      webhooks: rows.map(r => ({ ...r, events: safeParse(r.events) || [] }))
    });
  } catch (e) {
    console.error('GET /admin/webhooks failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

adminRouter.put('/webhooks/:id', async (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  const id = c.req.param('id');
  const existing = db.prepare(
    `SELECT id, name, paused_at FROM webhooks WHERE id = ?`
  ).get(id);
  if (!existing) return c.json({ error: 'Webhook not found' }, 404);

  let body;
  try { body = await c.req.json(); }
  catch (e) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.paused === undefined) {
    return c.json({ error: "Only 'paused' is updatable today" }, 400);
  }

  const wantPaused = Boolean(body.paused);
  const isPaused = !!existing.paused_at;
  if (wantPaused === isPaused) {
    return c.json({ id, paused: wantPaused, changed: false });
  }

  try {
    db.prepare(`UPDATE webhooks SET paused_at = ? WHERE id = ?`)
      .run(wantPaused ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null, id);
  } catch (e) {
    console.error('PUT /admin/webhooks/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  audit(c, {
    action: wantPaused ? 'webhook.pause' : 'webhook.resume',
    target_type: 'webhook', target_id: id,
    before: { paused: isPaused },
    after:  { paused: wantPaused }
  });

  return c.json({ id, paused: wantPaused, changed: true });
});

// Fire a synthetic event so operators can verify a receiver is wired up.
// Goes through the normal dispatchEvent path; respects pause.
adminRouter.post('/webhooks/:id/test', (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  const id = c.req.param('id');
  const w = db.prepare(`SELECT id, name, url, paused_at FROM webhooks WHERE id = ?`).get(id);
  if (!w) return c.json({ error: 'Webhook not found' }, 404);
  if (w.paused_at) {
    return c.json({ error: 'Webhook is paused; resume it before testing' }, 400);
  }

  try {
    dispatchEvent('webhook.test', {
      webhook_id: id,
      webhook_name: w.name,
      note: 'Synthetic test delivery from POST /admin/webhooks/:id/test'
    });
  } catch (e) {
    console.error('webhook test dispatch failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  audit(c, {
    action: 'webhook.test',
    target_type: 'webhook', target_id: id
  });

  return c.json({
    ok: true,
    note: 'Fire-and-forget dispatched. Check the receiver and the webhook row\'s last_status / last_error after a moment.'
  });
});

adminRouter.delete('/webhooks/:id', (c) => {
  const denied = requireScope(c, 'admin');
  if (denied) return denied;

  const id = c.req.param('id');
  const existing = db.prepare(`SELECT name, url FROM webhooks WHERE id = ?`).get(id);
  if (!existing) return c.json({ error: 'Webhook not found' }, 404);

  try {
    db.prepare(`DELETE FROM webhooks WHERE id = ?`).run(id);
  } catch (e) {
    console.error('DELETE /admin/webhooks/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  audit(c, {
    action: 'webhook.delete',
    target_type: 'webhook', target_id: id,
    before: { name: existing.name, url: existing.url }
  });

  return c.json({ ok: true });
});
