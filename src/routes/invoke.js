import { Hono } from 'hono';
import { db } from '../db.js';
import { ReportSchema, parseOrError } from '../validation.js';

export const invokeRouter = new Hono();

// ── MODE B: SDK report endpoint ───────────────────────────────────────────────
// The caller invoked the agent directly and reports the result here.
// No proxy, no added latency.
//
// POST /agents/:id/report
// Body:
// {
//   "latency_ms":      340,                  // required, number
//   "status":          "success" | "error" | "timeout",  // required
//   "request_size":    512,                  // optional, bytes sent to agent
//   "response_size":   1024,                 // optional, bytes received
//   "error_msg":       "...",                // optional, only on non-success
//   "caller_agent_id": "..."                 // optional, id of the calling agent
// }

invokeRouter.post('/:id/report', async (c) => {
  const agentId = c.req.param('id');

  const agent = db.prepare(
    `SELECT id, status FROM agents WHERE id = ?`
  ).get(agentId);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  let raw;
  try {
    raw = await c.req.json();
  } catch (e) {
    console.error('POST /:id/report body parse failed:', e.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = parseOrError(c, ReportSchema, raw);
  if (parsed.error) return parsed.error;
  const {
    latency_ms,
    status,
    request_size,
    response_size,
    error_msg,
    caller_agent_id
  } = parsed.data;

  const caller =
    c.req.header('X-Caller-ID') ||
    c.req.header('X-Forwarded-For') ||
    'sdk';

  const id = crypto.randomUUID();

  try {
    db.prepare(`
      INSERT INTO invocations
        (id, agent_id, caller, status, latency_ms, error_msg,
         payload_size, response_size, mode, caller_agent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sdk', ?)
    `).run(
      id,
      agentId,
      caller,
      status,
      Math.round(latency_ms),
      error_msg || null,
      Number.isFinite(request_size) ? request_size : null,
      Number.isFinite(response_size) ? response_size : null,
      caller_agent_id || null
    );
  } catch (e) {
    console.error('POST /:id/report insert failed:', e.message);
    return c.json({ error: e.message }, 500);
  }

  return c.json({ ok: true, invocation_id: id });
});


// ── MODE A: Proxy endpoint (opt-in per agent) ────────────────────────────────
// The registry forwards the A2A task to the agent's endpoint, measures
// everything, logs it, and returns the A2A response. Only enabled when
// agent.proxy_enabled = 1.
//
// POST /agents/:id/tasks
// Body: A2A Task object

invokeRouter.post('/:id/tasks', async (c) => {
  const agentId = c.req.param('id');

  const agent = db.prepare(
    `SELECT id, name, status, endpoint_url, auth_type, auth_header,
            proxy_enabled, proxy_timeout_ms
     FROM agents WHERE id = ?`
  ).get(agentId);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  if (!agent.proxy_enabled) {
    return c.json({
      error: 'Proxy mode not enabled for this agent',
      hint: 'Use POST /agents/:id/report to report SDK-mode invocations',
      sdk_docs: 'https://github.com/agennect/agennect-open#invocation-modes',
      endpoint_url: agent.endpoint_url
    }, 422);
  }

  if (agent.status === 'inactive') {
    return c.json({ error: 'Agent is inactive' }, 503);
  }

  if (!agent.endpoint_url) {
    return c.json({ error: 'Agent has no endpoint URL configured' }, 502);
  }

  let task;
  try {
    task = await c.req.json();
  } catch (e) {
    console.error('POST /:id/tasks body parse failed:', e.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const taskId = task.id || crypto.randomUUID();

  // Build auth headers (caller supplies the upstream value via X-Agent-Auth)
  const headers = { 'Content-Type': 'application/json' };
  const authValue = c.req.header('X-Agent-Auth') || '';
  if (agent.auth_type === 'apikey' && authValue) {
    headers[agent.auth_header || 'X-API-Key'] = authValue;
  } else if (agent.auth_type === 'oauth' && authValue) {
    headers['Authorization'] = `Bearer ${authValue}`;
  }

  const caller =
    c.req.header('X-Caller-ID') ||
    c.req.header('X-Forwarded-For') ||
    'proxy';

  const requestBody = JSON.stringify({ ...task, id: taskId });
  const requestSize = new TextEncoder().encode(requestBody).length;

  const timeout = agent.proxy_timeout_ms || 30000;
  const totalStart = Date.now();
  let agentStart = totalStart;
  let agentLatency = 0;
  let invocationStatus = 'error';
  let errorMsg = null;
  let responseSize = null;
  let responseBody = null;

  try {
    agentStart = Date.now();
    const agentRes = await fetch(agent.endpoint_url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(timeout)
    });
    agentLatency = Date.now() - agentStart;

    const responseText = await agentRes.text();
    responseSize = new TextEncoder().encode(responseText).length;

    if (agentRes.ok) {
      invocationStatus = 'success';
      try {
        responseBody = JSON.parse(responseText);
      } catch (e) {
        // Agent returned non-JSON; wrap as A2A text part.
        responseBody = {
          id: taskId,
          status: { state: 'completed' },
          result: { parts: [{ type: 'text', text: responseText }] }
        };
      }
    } else {
      invocationStatus = 'error';
      errorMsg = `Agent returned HTTP ${agentRes.status}`;
      responseBody = {
        id: taskId,
        status: { state: 'failed' },
        error: { message: errorMsg, code: agentRes.status }
      };
    }
  } catch (e) {
    agentLatency = Date.now() - agentStart;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      invocationStatus = 'timeout';
      errorMsg = `Agent timed out after ${timeout}ms`;
    } else {
      invocationStatus = 'error';
      errorMsg = e.message;
    }
    console.error(`Proxy invocation failed for ${agentId}:`, errorMsg);
    responseBody = {
      id: taskId,
      status: { state: 'failed' },
      error: { message: errorMsg }
    };
  }

  const totalLatency = Date.now() - totalStart;

  const invId = crypto.randomUUID();
  try {
    db.prepare(`
      INSERT INTO invocations
        (id, agent_id, caller, status, latency_ms, error_msg,
         payload_size, response_size, mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proxy')
    `).run(
      invId, agentId, caller, invocationStatus,
      agentLatency, errorMsg, requestSize, responseSize
    );

    if (invocationStatus === 'success' && agent.status === 'degraded') {
      db.prepare(
        `UPDATE agents SET status = 'active', updated_at = datetime('now')
         WHERE id = ?`
      ).run(agentId);
    }
  } catch (e) {
    console.error('Proxy invocation log failed:', e.message);
  }

  const httpStatus =
    invocationStatus === 'success' ? 200 :
    invocationStatus === 'timeout' ? 504 : 502;

  return c.json({
    ...responseBody,
    _agennect: {
      invocation_id: invId,
      agent_id: agentId,
      latency_ms: totalLatency,
      agent_latency_ms: agentLatency,
      mode: 'proxy',
      proxied_at: new Date().toISOString()
    }
  }, httpStatus);
});


// ── GET /agents/:id/invocations ───────────────────────────────────────────────
// Last 50 (configurable) invocations for an agent. No auth required.

invokeRouter.get('/:id/invocations', (c) => {
  const agentId = c.req.param('id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);

  const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  try {
    const invocations = db.prepare(`
      SELECT id, status, latency_ms, mode, created_at,
             payload_size, response_size, error_msg, caller_agent_id
      FROM invocations
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(agentId, limit);

    return c.json({
      agent_id: agentId,
      invocations,
      total: invocations.length
    });
  } catch (e) {
    console.error('GET /:id/invocations failed:', e.message);
    return c.json({ error: e.message }, 500);
  }
});
