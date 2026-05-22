import { Hono } from 'hono';
import { db } from '../db.js';
import { adaptRestToA2A } from '../a2a.js';

export const invokeRouter = new Hono();

// POST /agents/:id/tasks — A2A task entry point
invokeRouter.post('/:id/tasks', async (c) => {
  const id = c.req.param('id');
  const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);

  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  if (agent.status === 'inactive') {
    return c.json({ error: 'Agent is inactive' }, 503);
  }

  let task;
  try {
    task = await c.req.json();
  } catch (e) {
    console.error('POST /agents/:id/tasks body parse failed:', e.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const authValue = c.req.header('X-Agent-Auth') || null;
  const caller =
    c.req.header('X-Forwarded-For') ||
    c.req.header('X-Caller') ||
    'unknown';

  const invocationId = crypto.randomUUID();
  const payloadSize = JSON.stringify(task).length;
  const start = Date.now();

  try {
    const result = await adaptRestToA2A(agent, task, authValue);
    const latency = Date.now() - start;

    logInvocation({
      id: invocationId,
      agent_id: id,
      caller,
      status: 'success',
      latency_ms: latency,
      error_msg: null,
      payload_size: payloadSize
    });

    return c.json(result);
  } catch (e) {
    const latency = Date.now() - start;
    const isTimeout = e.name === 'TimeoutError' || /timeout|abort/i.test(e.message);
    const status = isTimeout ? 'timeout' : 'error';

    console.error(`Invocation failed for agent ${id}:`, e.message);

    logInvocation({
      id: invocationId,
      agent_id: id,
      caller,
      status,
      latency_ms: latency,
      error_msg: e.message,
      payload_size: payloadSize
    });

    return c.json({ error: e.message }, isTimeout ? 504 : 502);
  }
});

function logInvocation(row) {
  try {
    db.prepare(
      `INSERT INTO invocations
       (id, agent_id, caller, status, latency_ms, error_msg, payload_size)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id,
      row.agent_id,
      row.caller,
      row.status,
      row.latency_ms,
      row.error_msg,
      row.payload_size
    );
  } catch (e) {
    console.error('logInvocation failed:', e.message);
  }
}
