import { db } from './db.js';

const INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '300000');

export function startHealthChecks() {
  console.log(`✓ Health checks every ${INTERVAL / 1000}s`);
  checkAll().catch(e => console.error('Initial health check error:', e.message));
  // Return handle so graceful shutdown can clearInterval().
  return setInterval(() => {
    checkAll().catch(e => console.error('Health check tick error:', e.message));
  }, INTERVAL);
}

async function checkAll() {
  const agents = db.prepare(
    `SELECT id, endpoint_url FROM agents
     WHERE status != 'inactive'
       AND endpoint_url IS NOT NULL
       AND COALESCE(is_builtin, 0) = 0`
  ).all();

  for (const agent of agents) {
    await checkOne(agent).catch(e =>
      console.error(`Health check error for ${agent.id}:`, e.message)
    );
  }
}

async function checkOne(agent) {
  const id = crypto.randomUUID();
  let status = 'down';
  let latency = null;
  let errorMsg = null;

  const start = Date.now();
  try {
    const res = await fetch(agent.endpoint_url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000)
    });
    latency = Date.now() - start;

    if (res.ok) {
      status = latency > 5000 ? 'degraded' : 'up';
    } else if (res.status < 500) {
      status = 'up';
    } else {
      status = 'down';
      errorMsg = `HTTP ${res.status}`;
    }
  } catch (e) {
    latency = Date.now() - start;
    status = 'down';
    errorMsg = e.message;
    console.error(`checkOne(${agent.id}) failed:`, e.message);
  }

  try {
    db.prepare(
      `INSERT INTO health_checks (id, agent_id, status, latency_ms, error_msg)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, agent.id, status, latency, errorMsg);

    const prev = db.prepare(
      `SELECT status FROM agents WHERE id = ?`
    ).get(agent.id);

    const newStatus =
      status === 'up' ? 'active' :
      status === 'degraded' ? 'degraded' :
      'inactive';

    if (prev && prev.status !== 'inactive' && prev.status !== newStatus) {
      db.prepare(
        `UPDATE agents SET status = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(newStatus, agent.id);
      console.log(`Agent ${agent.id}: ${prev.status} → ${newStatus}`);
    }
  } catch (e) {
    console.error(`checkOne(${agent.id}) db write failed:`, e.message);
  }
}
