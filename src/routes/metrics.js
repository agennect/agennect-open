import { Hono } from 'hono';
import { db } from '../db.js';

export const metricsRouter = new Hono();

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

// ── GET /metrics ──────────────────────────────────────────────────────────────
// Global registry KPIs.

metricsRouter.get('/', (c) => {
  try {
    const registryName = process.env.REGISTRY_NAME || 'agennect-open';

    const agentCounts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
        SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive
      FROM agents
    `).get();

    const mcpCount = db.prepare(
      `SELECT COUNT(*) AS n FROM mcp_servers WHERE status = 'active'`
    ).get().n;

    const inv24h = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
        ROUND(AVG(latency_ms)) AS avg_latency
      FROM invocations
      WHERE created_at > datetime('now', '-24 hours')
    `).get();

    const inv7d = db.prepare(`
      SELECT COUNT(*) AS total FROM invocations
      WHERE created_at > datetime('now', '-7 days')
    `).get().total;

    const inv30d = db.prepare(`
      SELECT COUNT(*) AS total FROM invocations
      WHERE created_at > datetime('now', '-30 days')
    `).get().total;

    const latencies24h = db.prepare(`
      SELECT latency_ms FROM invocations
      WHERE created_at > datetime('now', '-24 hours')
        AND status = 'success'
        AND latency_ms IS NOT NULL
      ORDER BY latency_ms
    `).all().map(r => r.latency_ms);

    const p50 = percentile(latencies24h, 0.50);
    const p95 = percentile(latencies24h, 0.95);

    const successRate24hPct = inv24h.total > 0
      ? Math.round((inv24h.successes / inv24h.total) * 1000) / 10
      : null;

    const topAgents = db.prepare(`
      SELECT
        i.agent_id,
        a.name,
        COUNT(*) AS invocations,
        ROUND(AVG(i.latency_ms)) AS avg_latency,
        SUM(CASE WHEN i.status = 'success' THEN 1 ELSE 0 END) AS successes
      FROM invocations i
      LEFT JOIN agents a ON a.id = i.agent_id
      WHERE i.created_at > datetime('now', '-24 hours')
      GROUP BY i.agent_id
      ORDER BY invocations DESC
      LIMIT 5
    `).all();

    const agentsDown = db.prepare(`
      SELECT id, name FROM agents WHERE status IN ('inactive', 'degraded')
    `).all();

    const modeCounts = db.prepare(`
      SELECT mode, COUNT(*) AS n FROM invocations
      WHERE created_at > datetime('now', '-24 hours')
      GROUP BY mode
    `).all();

    return c.json({
      registry: {
        name: registryName,
        version: '0.1.0',
        agents_total:     agentCounts.total    || 0,
        agents_active:    agentCounts.active   || 0,
        agents_degraded:  agentCounts.degraded || 0,
        agents_inactive:  agentCounts.inactive || 0,
        mcp_servers: mcpCount
      },
      invocations: {
        last_24h: inv24h.total || 0,
        last_7d:  inv7d,
        last_30d: inv30d,
        success_rate_24h_pct: successRate24hPct,
        avg_latency_ms_24h:   inv24h.avg_latency || null,
        p50_latency_ms_24h:   p50,
        p95_latency_ms_24h:   p95,
        mode_breakdown: modeCounts.reduce((acc, r) => {
          acc[r.mode || 'unknown'] = r.n;
          return acc;
        }, {})
      },
      top_agents: topAgents.map(a => ({
        id:               a.agent_id,
        name:             a.name,
        invocations_24h:  a.invocations,
        avg_latency_ms:   a.avg_latency,
        success_rate_pct: a.invocations > 0
          ? Math.round((a.successes / a.invocations) * 1000) / 10
          : null
      })),
      health: {
        checked_at: new Date().toISOString(),
        agents_up:   agentCounts.active || 0,
        agents_down: agentsDown.length,
        agents_down_list: agentsDown.map(a => a.name)
      }
    });
  } catch (e) {
    console.error('GET /metrics failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});


// ── GET /metrics/agents/:id ───────────────────────────────────────────────────
// Per-agent metrics with latency percentiles and hourly series.

metricsRouter.get('/agents/:id', (c) => {
  try {
    const agentId = c.req.param('id');

    const agent = db.prepare(
      `SELECT id, name, status FROM agents WHERE id = ?`
    ).get(agentId);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeouts,
        ROUND(AVG(latency_ms)) AS avg_latency
      FROM invocations
      WHERE agent_id = ?
        AND created_at > datetime('now', '-24 hours')
    `).get(agentId);

    const stats7d = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes
      FROM invocations
      WHERE agent_id = ?
        AND created_at > datetime('now', '-7 days')
    `).get(agentId);

    const latencies = db.prepare(`
      SELECT latency_ms FROM invocations
      WHERE agent_id = ?
        AND status = 'success'
        AND created_at > datetime('now', '-24 hours')
        AND latency_ms IS NOT NULL
      ORDER BY latency_ms
    `).all(agentId).map(r => r.latency_ms);

    const hourly = db.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:00:00Z', created_at) AS hour,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
        ROUND(AVG(latency_ms)) AS avg_latency
      FROM invocations
      WHERE agent_id = ?
        AND created_at > datetime('now', '-24 hours')
      GROUP BY hour
      ORDER BY hour ASC
    `).all(agentId);

    const health = db.prepare(`
      SELECT
        COUNT(*) AS total_checks,
        SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up_checks
      FROM health_checks
      WHERE agent_id = ?
        AND checked_at > datetime('now', '-24 hours')
    `).get(agentId);

    const lastCheck = db.prepare(`
      SELECT status, latency_ms, checked_at
      FROM health_checks
      WHERE agent_id = ?
      ORDER BY checked_at DESC LIMIT 1
    `).get(agentId);

    const uptimePct = health && health.total_checks > 0
      ? Math.round((health.up_checks / health.total_checks) * 1000) / 10
      : null;

    return c.json({
      id:     agent.id,
      name:   agent.name,
      status: agent.status,
      invocations: {
        last_24h:     stats.total || 0,
        last_7d:      stats7d.total || 0,
        successes_24h: stats.successes || 0,
        errors_24h:    stats.errors || 0,
        timeouts_24h:  stats.timeouts || 0,
        success_rate_pct: stats.total > 0
          ? Math.round((stats.successes / stats.total) * 1000) / 10
          : null,
        success_rate_7d_pct: stats7d.total > 0
          ? Math.round((stats7d.successes / stats7d.total) * 1000) / 10
          : null,
        avg_latency_ms: stats.avg_latency || null,
        p50_latency_ms: percentile(latencies, 0.50),
        p95_latency_ms: percentile(latencies, 0.95),
        p99_latency_ms: percentile(latencies, 0.99),
        hourly_last_24h: hourly
      },
      health: {
        uptime_pct_24h:  uptimePct,
        last_status:     lastCheck?.status || null,
        last_latency_ms: lastCheck?.latency_ms || null,
        last_checked_at: lastCheck?.checked_at || null
      }
    });
  } catch (e) {
    console.error('GET /metrics/agents/:id failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});


// ── GET /metrics/timeseries ───────────────────────────────────────────────────
// Hourly invocation series, optionally filtered to a single agent.

metricsRouter.get('/timeseries', (c) => {
  try {
    const hours = Math.min(Math.max(parseInt(c.req.query('hours') || '24'), 1), 720);
    const agentId = c.req.query('agent_id') || null;

    const where = [`created_at > datetime('now', '-${hours} hours')`];
    const params = [];
    if (agentId) {
      where.push('agent_id = ?');
      params.push(agentId);
    }

    const series = db.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:00:00Z', created_at) AS hour,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeouts,
        ROUND(AVG(latency_ms)) AS avg_latency_ms
      FROM invocations
      WHERE ${where.join(' AND ')}
      GROUP BY hour
      ORDER BY hour ASC
    `).all(...params);

    return c.json({ hours, agent_id: agentId, series });
  } catch (e) {
    console.error('GET /metrics/timeseries failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});
