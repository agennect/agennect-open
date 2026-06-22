// Token-based auth.
//
// Tokens have one of three scopes:
//   read   — GET endpoints only (most are public anyway)
//   write  — read + POST/PUT/DELETE on /agents and /mcp
//   admin  — write + token management + audit log read
//
// On startup we ensure the value of process.env.ADMIN_TOKEN is registered
// as an admin-scope token (name 'env-bootstrap'). That preserves the
// existing dashboard workflow: paste the env value, get admin access.

import { createHash, randomBytes } from 'crypto';
import { db } from './db.js';

export const BOOTSTRAP_NAME = 'env-bootstrap';
const TOKEN_PREFIX = 'agk_'; // agennect key

export function hashToken(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function generateToken() {
  // 32 random bytes → 256 bits of entropy → 43 base64url chars
  const raw = randomBytes(32).toString('base64url');
  return TOKEN_PREFIX + raw;
}

export function bootstrapEnvToken() {
  const envValue = (process.env.ADMIN_TOKEN || 'change-me-before-deploy').trim();
  if (!envValue) return;

  const hash = hashToken(envValue);
  const existing = db.prepare(
    `SELECT id, hash, scope, revoked_at FROM tokens WHERE name = ?`
  ).get(BOOTSTRAP_NAME);

  if (!existing) {
    db.prepare(
      `INSERT INTO tokens (id, name, hash, scope) VALUES (?, ?, ?, 'admin')`
    ).run(crypto.randomUUID(), BOOTSTRAP_NAME, hash);
    console.log(`✓ Bootstrap admin token registered (from ADMIN_TOKEN env, name=${BOOTSTRAP_NAME})`);
    return;
  }

  // Env value changed since last boot? Update the hash so the new value works.
  if (existing.hash !== hash) {
    db.prepare(
      `UPDATE tokens SET hash = ?, revoked_at = NULL WHERE name = ?`
    ).run(hash, BOOTSTRAP_NAME);
    console.log(`✓ Bootstrap admin token hash updated to match current ADMIN_TOKEN env`);
  } else if (existing.revoked_at) {
    db.prepare(
      `UPDATE tokens SET revoked_at = NULL WHERE name = ?`
    ).run(BOOTSTRAP_NAME);
    console.log(`✓ Bootstrap admin token un-revoked (matches current ADMIN_TOKEN env)`);
  }
}

// Returns the matching token row or null. Updates last_used_at on hit.
export function verifyToken(rawToken) {
  if (!rawToken) return null;
  const hash = hashToken(rawToken.trim());
  const row = db.prepare(
    `SELECT id, name, scope, revoked_at FROM tokens WHERE hash = ?`
  ).get(hash);
  if (!row || row.revoked_at) return null;

  // Best-effort last-used stamp; doesn't matter if it fails under load.
  try {
    db.prepare(`UPDATE tokens SET last_used_at = datetime('now') WHERE id = ?`)
      .run(row.id);
  } catch (e) {
    console.error('verifyToken last_used update failed:', e.message);
  }
  return row;
}

// Returns true if `actual` scope satisfies `required` scope.
// admin > write > read.
const SCOPE_RANK = { read: 1, write: 2, admin: 3 };
export function scopeSatisfies(actual, required) {
  return (SCOPE_RANK[actual] || 0) >= (SCOPE_RANK[required] || 0);
}

// Hono helper: returns a JSON response if the request lacks the required
// scope; returns null if access is granted. Caller pattern:
//
//   const denied = requireScope(c, 'write');
//   if (denied) return denied;
export function requireScope(c, required) {
  const token = c.get('token');
  if (!token) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  if (!scopeSatisfies(token.scope, required)) {
    return c.json({
      error: `Forbidden — this action requires scope '${required}', token has '${token.scope}'`
    }, 403);
  }
  return null;
}
