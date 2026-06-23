// External-SSO login: exchange a provider ID token for a registry session.
//
// Flow (Firebase example):
//   1. Browser/SDK signs the user in via Firebase, gets a Firebase ID token.
//   2. POST /auth/login { id_token } to this registry.
//   3. We verify the ID token through the configured provider,
//      JIT-upsert the user, then mint a session token tied to that user
//      and return it. The session token is what subsequent requests use
//      in their `Authorization: Bearer ...` header.

import { Hono } from 'hono';
import { db } from '../db.js';
import { audit } from '../audit.js';
import {
  generateToken,
  hashToken,
  requireScope
} from '../auth.js';
import { verifyExternalIdToken, currentProviderName } from '../auth-providers/index.js';
import { upsertUserFromIdentity, findUserById } from '../users.js';

export const authRouter = new Hono();

// ── GET /auth/config ──────────────────────────────────────────────────────────
// Returns the public client config the dashboard needs to drive the
// chosen provider's sign-in. All values returned here are safe to expose
// to the browser (they're public IDs, not secrets).
authRouter.get('/config', (c) => {
  const provider = currentProviderName();
  const out = { provider, enabled: false };

  if (provider === 'firebase') {
    const apiKey      = process.env.FIREBASE_API_KEY || '';
    const projectId   = process.env.FIREBASE_PROJECT_ID || '';
    const authDomain  = process.env.FIREBASE_AUTH_DOMAIN || (projectId ? `${projectId}.firebaseapp.com` : '');
    out.enabled = Boolean(apiKey && projectId);
    out.firebase = { apiKey, projectId, authDomain };
  }

  return c.json(out);
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
authRouter.post('/login', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch (e) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const idToken = body?.id_token;
  if (!idToken || typeof idToken !== 'string') {
    return c.json({ error: 'id_token is required' }, 400);
  }

  let identity;
  try {
    identity = await verifyExternalIdToken(idToken);
  } catch (e) {
    console.error(`[auth/login] verify (${currentProviderName()}) failed:`, e.message);
    return c.json({ error: `Identity verification failed: ${e.message}` }, 401);
  }

  let user;
  try {
    user = upsertUserFromIdentity(identity);
  } catch (e) {
    console.error('[auth/login] upsert failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  if (user.disabled_at) {
    return c.json({ error: 'User is disabled' }, 403);
  }

  // Mint a session token. We reuse the tokens table — scope mirrors role.
  const scope = user.role === 'admin' ? 'admin' : 'write';
  const tokenName = `session: ${user.email}`;
  const raw = generateToken();
  const id = crypto.randomUUID();

  try {
    db.prepare(`
      INSERT INTO tokens (id, name, hash, scope, user_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, tokenName, hashToken(raw), scope, user.id);
  } catch (e) {
    console.error('[auth/login] token insert failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  audit(c, {
    actor_token_id: id,
    actor_name: user.email,
    action: 'user.login',
    target_type: 'user', target_id: user.id,
    after: { provider: identity.provider, scope }
  });

  return c.json({
    token: raw,
    token_id: id,
    user: publicUser(user),
    scope,
    expires_at: null,
    note: 'Send this token in Authorization: Bearer ... for subsequent requests. POST /auth/logout to revoke.'
  });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
authRouter.get('/me', (c) => {
  const token = c.get('token');
  const user  = c.get('user') || null;
  if (!token) return c.json({ error: 'Not authenticated' }, 401);
  return c.json({
    token: { id: token.id, name: token.name, scope: token.scope },
    user:  user ? publicUser(user) : null,
    auth_provider: currentProviderName()
  });
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
authRouter.post('/logout', (c) => {
  const token = c.get('token');
  if (!token) return c.json({ ok: true });
  try {
    db.prepare(
      `UPDATE tokens SET revoked_at = datetime('now') WHERE id = ?`
    ).run(token.id);
  } catch (e) {
    console.error('[auth/logout] revoke failed:', e.message);
  }
  audit(c, {
    action: 'user.logout',
    target_type: 'token', target_id: token.id
  });
  return c.json({ ok: true });
});

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    provider: u.provider,
    created_at: u.created_at,
    last_login_at: u.last_login_at
  };
}
