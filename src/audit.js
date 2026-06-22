import { db } from './db.js';

// Append-only journal. Never throws — auditing must not block requests.
export function logAudit({
  actor_token_id = null,
  actor_name = null,
  action,
  target_type = null,
  target_id = null,
  before = null,
  after = null,
  ip = null
}) {
  try {
    db.prepare(`
      INSERT INTO audit_log
        (id, actor_token_id, actor_name, action,
         target_type, target_id, before_state, after_state, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      actor_token_id,
      actor_name,
      action,
      target_type,
      target_id,
      before ? JSON.stringify(before) : null,
      after  ? JSON.stringify(after)  : null,
      ip
    );
  } catch (e) {
    console.error('logAudit failed:', e.message);
  }
}

// Convenience for Hono routes — extracts actor + ip from the context.
export function audit(c, args) {
  const token = c.get('token');
  logAudit({
    actor_token_id: token?.id || null,
    actor_name:     token?.name || null,
    ip:             c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP') || null,
    ...args
  });
}
