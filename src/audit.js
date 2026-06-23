import { db } from './db.js';
import { dispatchEvent } from './webhooks.js';

// Append-only journal. Never throws — auditing must not block requests.
// Also fans out the event to any matching webhook subscribers.
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

  // Fire-and-forget webhook dispatch. dispatchEvent never throws.
  try {
    dispatchEvent(action, {
      actor: actor_name,
      target_type,
      target_id,
      before,
      after
    });
  } catch (e) {
    console.error('dispatchEvent (from audit) failed:', e.message);
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
