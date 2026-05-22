import { Hono } from 'hono';
import { db } from '../db.js';

export const metricsRouter = new Hono();

// GET /metrics — global registry KPIs
metricsRouter.get('/', (c) => {
  try {
    const counts = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='degraded' THEN 1 ELSE 0 END) AS degraded,
         SUM(CASE WHEN status='inactive' THEN 1 ELSE 0 END) AS inactive
       FROM agents`
    ).get();

    const mcpCount = db.prepare(
      `SELECT COUNT(*) AS cnt FROM mcp_servers WHERE status='active'`
    ).get().cnt;

    const inv24 = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
         AVG(latency_ms) AS avg_latency
       FROM invocations
       WHERE created_at > datetime('now', '-24 hours')`
    ).get();

    const inv7d = db.prepare(
      `SELECT COUNT(*) AS cnt FROM invocations
       WHERE created_at > datetime('now', '-7 days')`
    ).get().cnt;

    const inv30d = db.prepare(
      `SELECT COUNT(*) AS cnt FROM invocations
       WHERE created_at > datetime('now', '-30 days')`
    ).get().cnt;

    const topAgents = db.prepare(
      `SELECT i.agent_id AS id, a.name, COUNT(*) AS invocations_24h
       FROM invocations i
       LEFT JOIN agents a ON a.id = i.agent_id
       WHERE i.created_at > datetime('now', '-24 hours')
       GROUP BY i.agent_id
       ORDER BY invocations_24h DESC
       LIMIT 5`
    ).all();

    const latestHealth = db.prepare(
      `SELECT
         SUM(CASE WHEN status='up' THEN 1 ELSE 0 END) AS up,
         SUM(CASE WHEN status='down' THEN 1 ELSE 0 END) AS down,
         MAX(checked_at) AS checked_at
       FROM health_checks
       WHERE checked_at > datetime('now', '-1 hour')`
    ).get();

    const total24 = inv24.total || 0;
    const successRate = total24 > 0 ? (inv24.successes || 0) / total24 : null;

    return c.json({
      registry: {
        name: process.env.REGISTRY_NAME || 'Agent Registry',
        version: '0.1.0',
        agents_total: counts.total || 0,
        agents_active: counts.active || 0,
        agents_degraded: counts.degraded || 0,
        agents_inactive: counts.inactive || 0,
        mcp_servers: mcpCount
      },
      invocations: {
        last_24h: total24,
        last_7d: inv7d,
        last_30d: inv30d,
        success_rate_24h: successRate,
        avg_latency_ms_24h: inv24.avg_latency
          ? Math.round(inv24.avg_latency)
          : null
      },
      top_agents: topAgents,
      health: {
        checked_at: latestHealth?.checked_at || null,
        agents_up: latestHealth?.up || 0,
        agents_down: latestHealth?.down || 0
      }
    });
  } catch (e) {
    console.error('GET /metrics failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// GET /metrics/agents/:id — per-agent metrics
metricsRouter.get('/agents/:id', (c) => {
  try {
    const id = c.req.param('id');
    const agent = db.prepare(`SELECT id, name FROM agents WHERE id = ?`).get(id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    const inv24 = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
         AVG(latency_ms) AS avg_latency
       FROM invocations
       WHERE agent_id = ?
         AND created_at > datetime('now', '-24 hours')`
    ).get(id);

    const inv7d = db.prepare(
      `SELECT COUNT(*) AS cnt FROM invocations
       WHERE agent_id = ?
         AND created_at > datetime('now', '-7 days')`
    ).get(id).cnt;

    const latencies = db.prepare(
      `SELECT latency_ms FROM invocations
       WHERE agent_id = ?
         AND status = 'success'
         AND latency_ms IS NOT NULL
         AND created_at > datetime('now', '-24 hours')
       ORDER BY latency_ms`
    ).all(id).map(r => r.latency_ms);

    const p95 = percentile(latencies, 0.95);

    const checks24 = db.prepare(
      `SELECT status FROM health_checks
       WHERE agent_id = ?
         AND checked_at > datetime('now', '-24 hours')`
    ).all(id);

    const totalChecks = checks24.length;
    const upChecks = checks24.filter(c => c.status === 'up').length;
    const uptimePct = totalChecks > 0
      ? Math.round((upChecks / totalChecks) * 10000) / 100
      : null;

    const lastCheck = db.prepare(
      `SELECT status, latency_ms, checked_at
       FROM health_checks
       WHERE agent_id = ?
       ORDER BY checked_at DESC LIMIT 1`
    ).get(id);

    const total = inv24.total || 0;
    const successRate = total > 0 ? (inv24.successes || 0) / total : null;

    return c.json({
      id: agent.id,
      name: agent.name,
      invocations: {
        last_24h: total,
        last_7d: inv7d,
        success_rate: successRate,
        avg_latency_ms: inv24.avg_latency ? Math.round(inv24.avg_latency) : null,
        p95_latency_ms: p95
      },
      health: {
        uptime_pct_24h: uptimePct,
        last_check_status: lastCheck?.status || null,
        last_check_latency_ms: lastCheck?.latency_ms || null,
        last_checked_at: lastCheck?.checked_at || null
      }
    });
  } catch (e) {
    console.error('GET /metrics/agents/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}
