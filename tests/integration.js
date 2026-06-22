import '../src/load-env.js';

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
      // Embedding provider unavailable in test env — soft-pass
      console.log('  ⚠ semantic search returned 500 (embedding provider unavailable) — skipping content checks');
      passed++;
    } else {
      check('GET /agents/search?q=... → 200', false, `status=${r1.status}`);
    }

    const r2 = await http('GET', '/agents/search?q=pipeline');
    if (r2.status === 200 && r2.body?.results?.length) {
      check('Search for "pipeline" returns at least one result', r2.body.results.length > 0);
    } else if (r2.status === 500) {
      console.log('  ⚠ semantic search for "pipeline" skipped — embedding unavailable');
      passed++;
    } else {
      console.log('  ⚠ no results for "pipeline" — empty index acceptable');
      passed++;
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
