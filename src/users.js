// User upsert + lookup helpers. Users are JIT-provisioned on first
// successful external login (see /auth/login). The synthetic 'system'
// user (provider='system') owns all pre-Sprint-5 legacy resources.

import { db } from './db.js';

export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isAdminEmail(email) {
  return adminEmails().includes(String(email || '').toLowerCase());
}

export function findUserByProviderSub(provider, sub) {
  return db.prepare(
    `SELECT * FROM users WHERE provider = ? AND provider_sub = ?`
  ).get(provider, sub);
}

export function findUserById(id) {
  if (!id) return null;
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

// Returns the user row, creating it if needed. Role is determined by the
// ADMIN_EMAILS env var on first creation only. Existing rows keep their
// stored role unless an admin updates it via /admin/users (future).
export function upsertUserFromIdentity(identity) {
  const { provider, provider_sub, email, name } = identity;
  if (!provider || !provider_sub || !email) {
    throw new Error('upsertUserFromIdentity: provider, provider_sub, email are required');
  }

  const existing = findUserByProviderSub(provider, provider_sub);
  const now = "datetime('now')";

  if (existing) {
    // Refresh last_login_at + (optionally) the email/name if the IdP rotated them.
    db.prepare(`
      UPDATE users
      SET last_login_at = datetime('now'),
          email = ?,
          name  = COALESCE(?, name)
      WHERE id = ?
    `).run(email, name || null, existing.id);
    return findUserById(existing.id);
  }

  const id = crypto.randomUUID();
  const role = isAdminEmail(email) ? 'admin' : 'user';
  db.prepare(`
    INSERT INTO users (id, email, name, provider, provider_sub, role, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, email, name || null, provider, provider_sub, role);

  console.log(`[users] provisioned ${role} ${email} via ${provider}`);
  return findUserById(id);
}
