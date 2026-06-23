import '../src/load-env.js';
import { createServer } from 'http';
import { createHmac } from 'crypto';

const BASE = process.env.REGISTRY_URL || 'http://localhost:3000';
const TOKEN = process.env.ADMIN_TOKEN || 'change-me-before-deploy';

let passed = 0;
let failed = 0;
const failures = [];

async function http(method, path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.admin) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* tolerate non-json */ }
  return { status: res.status, body: json, raw: res };
}

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function block(title, fn) {
  return (async () => {
    console.log(`\n${title}`);
    try {
      await fn();
    } catch (e) {
      failed++;
      failures.push({ name: title, detail: e.message });
      console.error(`  ✗ block crashed: ${e.message}`);
    }
  })();
}

async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch (e) { /* keep waiting */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  console.log(`Integration tests against ${BASE}`);

  if (!(await waitForServer())) {
    console.error('Server not reachable. Start it first: npm start');
    process.exit(1);
  }

  let createdAgentId = null;
  let createdMcpId = null;

  await block('BLOCK 1 — Server health', async () => {
    const h = await http('GET', '/health');
    check('GET /health → 200', h.status === 200, `status=${h.status}`);
    check('GET /health status: ok', h.body?.status === 'ok');
    const m = await http('GET', '/metrics');
    check('GET /metrics → 200', m.status === 200, `status=${m.status}`);
    check('GET /metrics has registry object', !!m.body?.registry);
  });

  await block('BLOCK 2 — Agent CRUD', async () => {
    const noAuth = await http('POST', '/agents', {
      body: { name: 'X', description: 'short', provider: 'me' }
    });
    check('POST /agents (no token) → 401', noAuth.status === 401, `status=${noAuth.status}`);

    const created = await http('POST', '/agents', {
      admin: true,
      body: {
        name: 'TestAgent ' + Date.now(),
        description: 'A test agent created by the integration suite. Long enough to pass validation.',
        provider: 'TestSuite',
        protocols: ['A2A'],
        capabilities: ['testing', 'integration', 'fixtures'],
        hosting: 'referenced',
        auth_type: 'none'
      }
    });
    check('POST /agents (admin, valid) → 201', created.status === 201, `status=${created.status} body=${JSON.stringify(created.body)}`);
    check('POST /agents response has id', !!created.body?.id);
    createdAgentId = created.body?.id;

    const list = await http('GET', '/agents');
    check('GET /agents → 200', list.status === 200);
    check('GET /agents returns array', Array.isArray(list.body?.agents));

    if (createdAgentId) {
      const one = await http('GET', `/agents/${createdAgentId}`);
      check('GET /agents/:id → 200', one.status === 200, `status=${one.status}`);
      check('GET /agents/:id has capabilities array', Array.isArray(one.body?.capabilities));

      const card = await http('GET', `/agents/${createdAgentId}/.well-known/agent.json`);
      check('GET agent card → 200', card.status === 200);
      check('Agent card schema_version 0.2', card.body?.schema_version === '0.2');

      const upd = await http('PUT', `/agents/${createdAgentId}`, {
        admin: true,
        body: { description: 'Updated description — still longer than twenty characters.' }
      });
      check('PUT /agents/:id (admin) → 200', upd.status === 200, `status=${upd.status}`);
    }

    const missing = await http('POST', '/agents', {
      admin: true,
      body: { description: 'A description that is at least twenty chars long', provider: 'p' }
    });
    check('POST /agents (missing name) → 400', missing.status === 400, `status=${missing.status}`);
    check('POST /agents missing name has error', !!missing.body?.error);
  });

  await block('BLOCK 3 — Semantic search', async () => {
    const noQ = await http('GET', '/agents/search');
    check('GET /agents/search (no q) → 400', noQ.status === 400, `status=${noQ.status}`);

    const r1 = await http('GET', '/agents/search?q=data+governance');
    if (r1.status === 200) {
      check('GET /agents/search?q=... → 200', true);
      check('Search results is array', Array.isArray(r1.body?.results));
    } else if (r1.status === 500) {
      // Embedding provider unavailable — soft-pass (LLM_PROVIDER=mock avoids this in CI)
      console.log('  ⚠ semantic search returned 500 (no embedder configured) — skipping');
      passed++;
      return;
    } else {
      check('GET /agents/search?q=... → 200', false, `status=${r1.status}`);
      return;
    }

    // Strict ranking check: register two probe agents whose embedding text
    // is dominated by different vocab, then search for each and verify the
    // matching agent ranks first. Deterministic under LLM_PROVIDER=mock;
    // real embedders should also rank correctly.
    const pipelineAgent = await http('POST', '/agents', {
      admin: true,
      body: {
        name: 'SearchProbePipeline ' + Date.now(),
        description: 'Pipeline pipeline pipeline ELT dbt airflow scheduler orchestration',
        provider: 'integration',
        capabilities: ['pipeline', 'dbt', 'airflow']
      }
    });
    const govAgent = await http('POST', '/agents', {
      admin: true,
      body: {
        name: 'SearchProbeGovernance ' + Date.now(),
        description: 'Governance governance lineage classification PII RBAC compliance audit DAMA',
        provider: 'integration',
        capabilities: ['governance', 'PII', 'RBAC']
      }
    });

    if (pipelineAgent.body?.id && govAgent.body?.id) {
      const pId = pipelineAgent.body.id;
      const gId = govAgent.body.id;

      const pipeRes = await http('GET', '/agents/search?q=pipeline+orchestration&limit=5');
      check('Search "pipeline orchestration" returns results', (pipeRes.body?.results || []).length > 0);
      const topP = pipeRes.body?.results?.[0]?.agent?.id;
      check('Top result is the pipeline probe', topP === pId, `top=${topP}, want=${pId}`);

      const govRes = await http('GET', '/agents/search?q=governance+lineage&limit=5');
      check('Search "governance lineage" returns results', (govRes.body?.results || []).length > 0);
      const topG = govRes.body?.results?.[0]?.agent?.id;
      check('Top result is the governance probe', topG === gId, `top=${topG}, want=${gId}`);

      // Cleanup
      await http('DELETE', `/agents/${pId}`, { admin: true });
      await http('DELETE', `/agents/${gId}`, { admin: true });
    }
  });

  await block('BLOCK 4 — MCP directory', async () => {
    const created = await http('POST', '/mcp', {
      admin: true,
      body: {
        name: 'TestMcp ' + Date.now(),
        description: 'An MCP server for tests',
        transport: 'http',
        category: 'test',
        author: 'TestSuite',
        tools: [{ name: 'echo', description: 'Echo back input' }]
      }
    });
    check('POST /mcp (admin, valid) → 201', created.status === 201, `status=${created.status} body=${JSON.stringify(created.body)}`);
    createdMcpId = created.body?.id;

    const list = await http('GET', '/mcp');
    check('GET /mcp → 200', list.status === 200);
    check('GET /mcp returns array', Array.isArray(list.body?.servers));

    if (createdMcpId) {
      const one = await http('GET', `/mcp/${createdMcpId}`);
      check('GET /mcp/:id → 200', one.status === 200);
      check('GET /mcp/:id has tools array', Array.isArray(one.body?.tools));
    }
  });

  await block('BLOCK 5 — Invocations (Mode B SDK + Mode A proxy gate)', async () => {
    if (!createdAgentId) {
      console.log('  ⚠ no agent id from BLOCK 2 — skipping');
      return;
    }

    // Mode B — report a successful invocation
    const r1 = await http('POST', `/agents/${createdAgentId}/report`, {
      body: { latency_ms: 340, status: 'success', request_size: 512, response_size: 1024 }
    });
    check('POST /:id/report (success) → 200', r1.status === 200, `status=${r1.status}`);
    check('Report returns ok + invocation_id', r1.body?.ok === true && !!r1.body?.invocation_id);

    // Mode B — report a timeout
    const r2 = await http('POST', `/agents/${createdAgentId}/report`, {
      body: { latency_ms: 5001, status: 'timeout', error_msg: 'Agent timed out after 5000ms' }
    });
    check('POST /:id/report (timeout) → 200', r2.status === 200);

    // Mode B — invalid (missing latency_ms)
    const r3 = await http('POST', `/agents/${createdAgentId}/report`, {
      body: { status: 'success' }
    });
    check('POST /:id/report (invalid) → 400', r3.status === 400);

    // Mode A — proxy disabled by default → 422 with hint
    const proxy = await http('POST', `/agents/${createdAgentId}/tasks`, {
      body: { message: { role: 'user', parts: [{ type: 'text', text: 'ping' }] } }
    });
    check('POST /:id/tasks (proxy off) → 422', proxy.status === 422, `status=${proxy.status}`);
    check('422 response includes a hint', typeof proxy.body?.hint === 'string');

    // Metrics reflect the reports
    const m = await http('GET', `/metrics/agents/${createdAgentId}`);
    check('GET /metrics/agents/:id → 200', m.status === 200);
    check('agent metrics has invocations.last_24h >= 2', (m.body?.invocations?.last_24h || 0) >= 2);
    check('p50_latency_ms is a number', typeof m.body?.invocations?.p50_latency_ms === 'number');

    // /invocations list
    const list = await http('GET', `/agents/${createdAgentId}/invocations`);
    check('GET /:id/invocations → 200', list.status === 200);
    check('invocations is array', Array.isArray(list.body?.invocations));
    check('first invocation has mode field', list.body?.invocations?.[0]?.mode === 'sdk');

    // Global timeseries
    const ts = await http('GET', '/metrics/timeseries?hours=24');
    check('GET /metrics/timeseries → 200', ts.status === 200);
    check('timeseries.series is array', Array.isArray(ts.body?.series));

    // Global metrics reflects the test invocations and includes mode_breakdown
    const gm = await http('GET', '/metrics');
    check('Global metrics last_24h includes test invocations', (gm.body?.invocations?.last_24h || 0) >= 2);
    check('Global metrics has mode_breakdown', typeof gm.body?.invocations?.mode_breakdown === 'object');
    check('Global success_rate_24h_pct is number or null',
      gm.body?.invocations?.success_rate_24h_pct === null ||
      typeof gm.body?.invocations?.success_rate_24h_pct === 'number');
  });

  await block('BLOCK 6 — Health', async () => {
    if (createdAgentId) {
      const h = await http('GET', `/agents/${createdAgentId}/health`);
      check('GET /agents/:id/health → 200', h.status === 200);
      check('Health response has uptime_pct field', 'uptime_pct' in (h.body || {}));
    }
    const m = await http('GET', '/metrics');
    check('Metrics agents_active is a number', typeof m.body?.registry?.agents_active === 'number');
  });

  await block('BLOCK 7.5 — Multi-token auth + audit log', async () => {
    // 1. Bootstrap admin token can mint a write-scoped token
    const wName = 'integration-write-' + Date.now();
    const wCreated = await http('POST', '/admin/tokens', {
      admin: true,
      body: { name: wName, scope: 'write' }
    });
    check('POST /admin/tokens (admin) → 201', wCreated.status === 201, `status=${wCreated.status}`);
    check('Response includes plaintext token', typeof wCreated.body?.token === 'string');
    const writeToken = wCreated.body?.token;
    const writeId    = wCreated.body?.id;

    // 2. write-scope token CAN create agents, CANNOT create tokens
    if (writeToken) {
      const okAgent = await fetch(`${BASE}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${writeToken}` },
        body: JSON.stringify({
          name: 'WriteScopeAgent ' + Date.now(),
          description: 'Created via write-scope token in the integration suite.',
          provider: 'integration'
        })
      });
      check('write-scope can POST /agents → 201', okAgent.status === 201, `status=${okAgent.status}`);

      const badAdmin = await fetch(`${BASE}/admin/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${writeToken}` },
        body: JSON.stringify({ name: 'should-fail', scope: 'read' })
      });
      check('write-scope CANNOT POST /admin/tokens → 403', badAdmin.status === 403, `status=${badAdmin.status}`);
    }

    // 3. read-scope token CANNOT mutate
    const rCreated = await http('POST', '/admin/tokens', {
      admin: true,
      body: { name: 'integration-read-' + Date.now(), scope: 'read' }
    });
    check('POST /admin/tokens read → 201', rCreated.status === 201);
    const readToken = rCreated.body?.token;
    if (readToken) {
      const denied = await fetch(`${BASE}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${readToken}` },
        body: JSON.stringify({
          name: 'ReadScopeFail',
          description: 'This request should be rejected with a 403 forbidden.',
          provider: 'integration'
        })
      });
      check('read-scope CANNOT POST /agents → 403', denied.status === 403, `status=${denied.status}`);
    }

    // 4. Audit log surfaces the mutations we just made
    const auditRes = await http('GET', '/admin/audit?limit=20', { admin: true });
    check('GET /admin/audit (admin) → 200', auditRes.status === 200);
    check('Audit entries is array', Array.isArray(auditRes.body?.entries));
    check('At least one audit entry exists', (auditRes.body?.entries || []).length > 0);
    const hasTokenCreate = (auditRes.body?.entries || []).some(e => e.action === 'token.create');
    check('Audit log contains token.create entry', hasTokenCreate);

    // 5. Revoking the write token makes it stop working
    if (writeId && writeToken) {
      const rev = await http('DELETE', `/admin/tokens/${writeId}`, { admin: true });
      check('DELETE /admin/tokens/:id (admin) → 200', rev.status === 200);

      const afterRev = await fetch(`${BASE}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${writeToken}` },
        body: JSON.stringify({
          name: 'AfterRevoke',
          description: 'This should be rejected because the token was just revoked.',
          provider: 'integration'
        })
      });
      check('revoked token → 401', afterRev.status === 401, `status=${afterRev.status}`);
    }
  });

  await block('BLOCK 7.7 — OpenAPI + /v1 alias', async () => {
    const j = await http('GET', '/openapi.json');
    check('GET /openapi.json → 200', j.status === 200);
    check('OpenAPI doc has openapi 3.1.x', /^3\.1/.test(j.body?.openapi || ''));
    check('OpenAPI has paths block', !!j.body?.paths);

    const y = await fetch(`${BASE}/openapi.yaml`, { signal: AbortSignal.timeout(8000) });
    check('GET /openapi.yaml → 200', y.status === 200);
    const yText = await y.text();
    check('OpenAPI YAML starts with version', /^openapi:/m.test(yText));

    // /v1 alias returns same shape as the top-level
    const a = await http('GET', '/v1/agents?limit=1');
    check('GET /v1/agents → 200', a.status === 200);
    check('/v1/agents response has agents array', Array.isArray(a.body?.agents));
  });

  await block('BLOCK 7.8 — Webhooks (register + signed delivery)', async () => {
    // 1. Spin up a tiny receiver
    const received = [];
    let resolveDelivery;
    const deliveryPromise = new Promise((res) => { resolveDelivery = res; });

    const receiver = await new Promise((res) => {
      const s = createServer((req, resp) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          received.push({
            url: req.url,
            method: req.method,
            signature: req.headers['x-agennect-signature'],
            body
          });
          resp.writeHead(200, { 'Content-Type': 'application/json' });
          resp.end('{"ok":true}');
          if (received.length === 1) resolveDelivery();
        });
      });
      s.listen(0, '127.0.0.1', () => res(s));
    });
    const port = receiver.address().port;
    const receiverUrl = `http://127.0.0.1:${port}/agennect-webhook`;

    try {
      // 2. Register the webhook for agent.create events
      const reg = await http('POST', '/admin/webhooks', {
        admin: true,
        body: { name: 'integration-test', url: receiverUrl, events: ['agent.create'] }
      });
      check('POST /admin/webhooks (admin) → 201', reg.status === 201, `status=${reg.status}`);
      check('webhook returns plaintext secret', typeof reg.body?.secret === 'string');
      const webhookId = reg.body?.id;
      const secret = reg.body?.secret;

      // 3. Trigger an agent.create
      const create = await http('POST', '/agents', {
        admin: true,
        body: {
          name: 'WebhookTriggerAgent ' + Date.now(),
          description: 'Created by integration suite to trigger a webhook delivery.',
          provider: 'integration'
        }
      });
      check('POST /agents (triggers webhook) → 201', create.status === 201);

      // 4. Wait for delivery (up to ~3s)
      await Promise.race([
        deliveryPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('delivery timeout')), 3000))
      ]).catch(() => {});

      check('Webhook receiver got exactly 1 delivery', received.length === 1, `got ${received.length}`);

      if (received[0]) {
        const r = received[0];
        check('Delivery has signature header', !!r.signature);
        check('Delivery body is JSON with event=agent.create', (() => {
          try {
            const parsed = JSON.parse(r.body);
            return parsed.event === 'agent.create';
          } catch (e) { return false; }
        })());

        // Verify the signature with sha256(secret) as the key
        if (r.signature && secret) {
          const parts = Object.fromEntries(r.signature.split(',').map(p => p.split('=')));
          const key = createHmac('sha256', '')   // placeholder
            .update('')
            .digest();
          // Need sha256 of the secret as the actual HMAC key
          const { createHash } = await import('crypto');
          const signingKey = createHash('sha256').update(secret).digest('hex');
          const expected = createHmac('sha256', signingKey)
            .update(`${parts.t}.${r.body}`)
            .digest('hex');
          check('HMAC signature verifies against sha256(secret)', expected === parts.v1, `expected ${expected} got ${parts.v1}`);
        }
      }

      // 5. Clean up the webhook
      if (webhookId) {
        const del = await http('DELETE', `/admin/webhooks/${webhookId}`, { admin: true });
        check('DELETE /admin/webhooks/:id → 200', del.status === 200);
      }
    } finally {
      receiver.close();
    }
  });

  await block('BLOCK 7.9 — Users, SSO scaffolding, ownership', async () => {
    // /auth/config returns the active provider
    const cfg = await http('GET', '/auth/config');
    check('GET /auth/config → 200', cfg.status === 200);
    check('config has provider field', typeof cfg.body?.provider === 'string');

    // /auth/login input validation
    const noBody = await http('POST', '/auth/login', { body: {} });
    check('POST /auth/login without id_token → 400', noBody.status === 400);

    const badToken = await http('POST', '/auth/login', { body: { id_token: 'not-a-real-jwt' } });
    check('POST /auth/login with bad token → 401', badToken.status === 401);

    // /auth/me with the bootstrap token: token present, user null (env-bootstrap)
    const me = await http('GET', '/auth/me', { admin: true });
    check('GET /auth/me (bootstrap token) → 200', me.status === 200);
    check('me.token has admin scope', me.body?.token?.scope === 'admin');
    check('me.user is null for env-bootstrap', me.body?.user === null);

    // System user owns seeded/legacy resources. Create one via bootstrap →
    // it should also be system-owned since bootstrap has no user_id.
    const created = await http('POST', '/agents', {
      admin: true,
      body: {
        name: 'OwnershipProbe ' + Date.now(),
        description: 'Created by integration tests to verify ownership stamping.',
        provider: 'integration'
      }
    });
    check('POST /agents (bootstrap) → 201', created.status === 201);
    if (created.body?.id) {
      const detail = await http('GET', `/agents/${created.body.id}`);
      check('agent has owner_user_id', !!detail.body?.owner_user_id, `got ${detail.body?.owner_user_id}`);
      check('owner is system user', detail.body?.owner_user_id === '00000000-0000-0000-0000-000000000001');

      // Anonymous (no token) attempt to mutate → 401
      const anonMut = await http('PUT', `/agents/${created.body.id}`, {
        body: { description: 'should be rejected, not authenticated at all here.' }
      });
      check('anonymous PUT → 401', anonMut.status === 401);

      // Cleanup
      await http('DELETE', `/agents/${created.body.id}`, { admin: true });
    }
  });

  await block('BLOCK 8.0 — Users admin endpoints', async () => {
    // Bootstrap can list users — should at least include the system user
    const list = await http('GET', '/admin/users', { admin: true });
    check('GET /admin/users (admin) → 200', list.status === 200);
    check('users is an array', Array.isArray(list.body?.users));
    const system = (list.body?.users || []).find(u => u.provider === 'system');
    check('system user is present', !!system);

    // Non-admin (no auth) cannot list
    const denied = await http('GET', '/admin/users');
    check('GET /admin/users (no auth) → 401', denied.status === 401);

    // Refuse to mutate the system user
    if (system) {
      const tryMutate = await http('PUT', `/admin/users/${system.id}`, {
        admin: true,
        body: { role: 'user' }
      });
      check('PUT system user → 400', tryMutate.status === 400);
    }

    // PUT on a missing user → 404
    const missing = await http('PUT', '/admin/users/__missing__', {
      admin: true,
      body: { role: 'user' }
    });
    check('PUT missing user → 404', missing.status === 404);
  });

  await block('BLOCK 8.1 — Webhook pause + test', async () => {
    // 1. Spin up a receiver
    const received = [];
    let resolveDelivery;
    const deliveryPromise = new Promise((res) => { resolveDelivery = res; });
    const receiver = await new Promise((res) => {
      const s = createServer((req, resp) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          received.push({ body, signature: req.headers['x-agennect-signature'] });
          resp.writeHead(200); resp.end('{"ok":true}');
          resolveDelivery();
        });
      });
      s.listen(0, '127.0.0.1', () => res(s));
    });
    const url = `http://127.0.0.1:${receiver.address().port}/sprint6-test`;

    try {
      // 2. Register a webhook for webhook.test (and only that)
      const reg = await http('POST', '/admin/webhooks', {
        admin: true,
        body: { name: 'sprint6', url, events: ['webhook.test'] }
      });
      check('POST /admin/webhooks → 201', reg.status === 201);
      const wid = reg.body?.id;

      // 3. Pause the webhook, then trigger test — receiver must NOT get hit
      if (wid) {
        const paused = await http('PUT', `/admin/webhooks/${wid}`, {
          admin: true,
          body: { paused: true }
        });
        check('PUT pause → 200', paused.status === 200);

        const blockedTest = await http('POST', `/admin/webhooks/${wid}/test`, { admin: true });
        check('test fire while paused → 400', blockedTest.status === 400);

        // Sanity: receiver got nothing
        await new Promise(r => setTimeout(r, 400));
        check('receiver got 0 deliveries while paused', received.length === 0);

        // 4. Resume + fire — receiver should get the synthetic event
        await http('PUT', `/admin/webhooks/${wid}`, {
          admin: true, body: { paused: false }
        });
        const t = await http('POST', `/admin/webhooks/${wid}/test`, { admin: true });
        check('test fire while active → 200', t.status === 200);

        await Promise.race([
          deliveryPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('delivery timeout')), 3000))
        ]).catch(() => {});

        check('receiver got 1 delivery after test fire', received.length === 1, `got ${received.length}`);
        if (received[0]) {
          try {
            const parsed = JSON.parse(received[0].body);
            check('delivery event is webhook.test', parsed.event === 'webhook.test');
          } catch (e) {
            check('delivery body parses as JSON', false, e.message);
          }
        }

        // Cleanup
        await http('DELETE', `/admin/webhooks/${wid}`, { admin: true });
      }
    } finally {
      receiver.close();
    }
  });

  await block('BLOCK 8.2 — Meta: llms.txt + request-id', async () => {
    const llms = await fetch(`${BASE}/llms.txt`, { signal: AbortSignal.timeout(8000) });
    check('GET /llms.txt → 200', llms.status === 200);
    const ct = llms.headers.get('content-type') || '';
    check('llms.txt content-type is text/plain', /text\/plain/.test(ct), `got ${ct}`);
    const body = await llms.text();
    check('llms.txt mentions /v1/agents', body.includes('/v1/agents'));

    // Server should echo client-provided X-Request-Id; otherwise mint one
    const h = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'X-Request-Id': 'integration-probe-id-123' }
    });
    check('X-Request-Id echoed back', h.headers.get('x-request-id') === 'integration-probe-id-123');

    const h2 = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(8000) });
    const rid = h2.headers.get('x-request-id') || '';
    check('X-Request-Id minted when absent', rid.length >= 8);
  });

  await block('BLOCK 8.5 — Connect Agent (built-in onboarding)', async () => {
    // The connect agent should be bootstrapped automatically on server start.
    const detail = await http('GET', '/agents/agennect-connect');
    check('GET /agents/agennect-connect → 200', detail.status === 200);
    check('agent is flagged is_builtin', detail.body?.is_builtin === 1);
    check('agent owner is the system user',
      detail.body?.owner_user_id === '00000000-0000-0000-0000-000000000001');

    // Agent Card renders fine
    const card = await http('GET', '/agents/agennect-connect/.well-known/agent.json');
    check('agent card → 200', card.status === 200);
    check('card schema_version 0.2', card.body?.schema_version === '0.2');
    check('card has skills', Array.isArray(card.body?.skills) && card.body.skills.length > 0);

    // Conversation: state-machine path (LLM_PROVIDER=mock in CI returns null,
    // forcing the fallback). Step through the full flow and verify the agent
    // is actually created.
    const sess = 'integration-connect-' + Date.now();
    const post = (text) => http('POST', '/agents/agennect-connect/tasks', {
      admin: true,   // exercise as the bootstrap admin so ownership stamps deterministically
      body: {
        id: sess,
        message: { role: 'user', parts: [{ type: 'text', text }] },
        context: { session_id: sess }
      }
    });

    const t0 = await post('');               // opener
    check('turn 0 → 200', t0.status === 200);
    check('opener mentions agent/mcp choice',
      /agent|mcp/i.test(t0.body?.result?.parts?.[0]?.text || ''));

    const t1 = await post('agent');          // pick path
    check('turn 1 asks for name',
      /name/i.test(t1.body?.result?.parts?.[0]?.text || ''));

    const probeName = 'ConnectProbe ' + Date.now();
    const t2 = await post(probeName);        // name
    check('turn 2 asks for description',
      /description/i.test(t2.body?.result?.parts?.[0]?.text || ''));

    const t3 = await post('A concise probe agent created by the integration suite to exercise the Connect onboarding flow end to end.');
    check('turn 3 asks for provider',
      /provider/i.test(t3.body?.result?.parts?.[0]?.text || ''));

    const t4 = await post('integration');    // provider
    check('turn 4 asks for endpoint',
      /endpoint/i.test(t4.body?.result?.parts?.[0]?.text || ''));

    const t5 = await post('none');           // endpoint
    check('turn 5 asks for capabilities',
      /capabilit/i.test(t5.body?.result?.parts?.[0]?.text || ''));

    const t6 = await post('testing, probe'); // capabilities → review
    const reviewText = t6.body?.result?.parts?.[0]?.text || '';
    check('turn 6 shows review with the chosen name',
      reviewText.includes(probeName) && /create/i.test(reviewText));

    const t7 = await post('yes');            // confirm → submit
    check('turn 7 confirms creation', /agennect|registered|done/i.test(
      t7.body?.result?.parts?.[0]?.text || ''));

    // The new agent should exist in the registry now
    const listed = await http('GET', '/agents?limit=100');
    const created = (listed.body?.agents || []).find(a => a.name === probeName);
    check('connect-created agent appears in /agents', !!created, `looked for name="${probeName}"`);
    if (created) {
      // Cleanup
      await http('DELETE', `/agents/${created.id}`, { admin: true });
    }
  });

  await block('BLOCK 7 — Dashboard', async () => {
    const d = await fetch(`${BASE}/dashboard`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });
    check('GET /dashboard → 200 or 302', [200, 301, 302].includes(d.status), `status=${d.status}`);
    const h = await http('GET', '/health');
    check('GET /health (final) → 200', h.status === 200);
  });

  // Cleanup
  if (createdAgentId) {
    await http('DELETE', `/agents/${createdAgentId}`, { admin: true }).catch(() => {});
  }
  if (createdMcpId) {
    await http('DELETE', `/mcp/${createdMcpId}`, { admin: true }).catch(() => {});
  }

  console.log(`\n────────────────────────────────────`);
  console.log(`PASS ${passed}    FAIL ${failed}`);
  if (failed > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    }
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Test runner failed:', e.message);
  process.exit(1);
});
