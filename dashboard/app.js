console.log('[dashboard] app.js loaded');

window.addEventListener('error', (e) => {
  console.error('[dashboard] uncaught error:', e.message, 'at', e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[dashboard] unhandled rejection:', e.reason);
});

const TOKEN_KEY = 'agennect_admin_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(t) {
  // Strip an accidentally-pasted "Bearer " prefix — the api() helper adds it.
  const cleaned = (t || '').replace(/^Bearer\s+/i, '').trim();
  if (cleaned) localStorage.setItem(TOKEN_KEY, cleaned);
  else localStorage.removeItem(TOKEN_KEY);
  updateAdminUI();
  // Tables embed per-row admin buttons at render time, so re-fetch them
  // whenever admin state flips.
  loadAgents();
  loadMcp();
  loadOverview();
}

function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function isAdmin() { return !!getToken(); }

function updateAdminUI() {
  document.querySelectorAll('.admin-only').forEach(el => {
    el.hidden = !isAdmin();
  });
  const status = document.getElementById('tokenStatus');
  if (status) {
    status.textContent = isAdmin()
      ? '✓ Token saved — admin actions enabled.'
      : 'No token set. Admin actions are hidden.';
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(opts.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* tolerate empty body */ }
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ─────────────────────────────────────── Tabs (event delegation)

const initialTabs = document.querySelectorAll('.tab');
console.log('[dashboard] tabs found:', initialTabs.length);

document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab');
  if (!tab) return;
  console.log('[dashboard] tab click:', tab.dataset.tab);

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');

  const target = document.getElementById('tab-' + tab.dataset.tab);
  if (target) {
    target.classList.add('active');
  } else {
    console.warn('[dashboard] no panel for', tab.dataset.tab);
  }

  if (tab.dataset.tab === 'health') loadHealth();
  if (tab.dataset.tab === 'agents') loadAgents();
  if (tab.dataset.tab === 'mcp') loadMcp();
  if (tab.dataset.tab === 'overview') loadOverview();
});

// ─────────────────────────────────────── Overview

async function loadOverview() {
  const cards = document.getElementById('cards');
  cards.innerHTML = '';
  try {
    const m = await api('/metrics');
    const inv = m.invocations || {};
    const fmtMs = (v) => v != null ? v + ' ms' : '—';

    const data = [
      ['Total Agents',     m.registry.agents_total],
      ['Active',           m.registry.agents_active],
      ['Invocations 24h',  inv.last_24h],
      ['Success Rate',     inv.success_rate_24h_pct != null ? inv.success_rate_24h_pct + '%' : '—'],
      ['Avg Latency',      fmtMs(inv.avg_latency_ms_24h)],
      ['P95 Latency',      fmtMs(inv.p95_latency_ms_24h)],
      ['MCP Servers',      m.registry.mcp_servers],
      ['Agents Down',      m.health.agents_down]
    ];
    cards.innerHTML = data.map(([l, v]) => `
      <div class="card">
        <div class="label">${escapeHtml(l)}</div>
        <div class="value">${escapeHtml(v)}</div>
      </div>
    `).join('');

    // Mode breakdown (SDK vs proxy invocations in last 24h)
    const breakdown = inv.mode_breakdown || {};
    const breakdownEl = document.getElementById('modeBreakdown');
    if (breakdownEl) {
      const sdk = breakdown.sdk || 0;
      const proxy = breakdown.proxy || 0;
      breakdownEl.innerHTML = (sdk + proxy) > 0
        ? `Invocation mode (24h): <strong>SDK</strong> ${sdk} · <strong>Proxy</strong> ${proxy}`
        : `<span class="muted">No invocations logged in the last 24h.</span>`;
    }

    const tbody = document.querySelector('#topAgentsTable tbody');
    tbody.innerHTML = m.top_agents.length
      ? m.top_agents.map(a => `
          <tr>
            <td>${escapeHtml(a.name || '(deleted)')}</td>
            <td class="muted">${escapeHtml(a.id || '')}</td>
            <td>${a.invocations_24h}</td>
            <td>${fmtMs(a.avg_latency_ms)}</td>
            <td>${a.success_rate_pct != null ? a.success_rate_pct + '%' : '—'}</td>
          </tr>
        `).join('')
      : `<tr><td colspan="5" class="muted">No invocations in the last 24h.</td></tr>`;
  } catch (e) {
    console.error('loadOverview failed:', e.message);
    cards.innerHTML = `<div class="card"><div class="label">Error</div><div class="value">${escapeHtml(e.message)}</div></div>`;
  }
}

// ─────────────────────────────────────── Agents

async function loadAgents() {
  const tbody = document.querySelector('#agentsTable tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="muted">Loading…</td></tr>`;
  try {
    const data = await api('/agents?limit=100');
    if (!data.agents.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted">No agents yet. Run npm run seed.</td></tr>`;
      return;
    }
    const rows = await Promise.all(data.agents.map(async (a) => {
      let inv = '—', latency = '—';
      try {
        const m = await api(`/metrics/agents/${a.id}`);
        inv = m.invocations.last_24h;
        latency = m.invocations.avg_latency_ms != null ? m.invocations.avg_latency_ms + ' ms' : '—';
      } catch (e) { /* tolerate */ }
      return `
        <tr>
          <td>${escapeHtml(a.name)}</td>
          <td>${escapeHtml(a.provider)}</td>
          <td>${(a.protocols || []).map(p => escapeHtml(p)).join(', ')}</td>
          <td><span class="status-pill status-${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td>
          <td><span class="muted">—</span></td>
          <td>${inv}</td>
          <td>${latency}</td>
          <td class="actions">
            <a href="/agents/${encodeURIComponent(a.id)}/.well-known/agent.json" target="_blank">Card</a>
            ${isAdmin()
              ? `<button class="ghost" data-edit-agent="${escapeHtml(a.id)}">Edit</button>
                 <button class="ghost" data-toggle-agent="${escapeHtml(a.id)}" data-target-status="${a.status === 'active' ? 'inactive' : 'active'}">${a.status === 'active' ? 'Deactivate' : 'Activate'}</button>`
              : ''}
          </td>
        </tr>`;
    }));
    tbody.innerHTML = rows.join('');

    tbody.querySelectorAll('[data-edit-agent]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.editAgent;
        try {
          const agent = await api(`/agents/${encodeURIComponent(id)}`);
          openAgentModal(agent);
        } catch (e) {
          console.error('Load agent for edit failed:', e.message);
          alert('Could not load agent: ' + e.message);
        }
      });
    });

    tbody.querySelectorAll('[data-toggle-agent]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.toggleAgent;
        const target = btn.dataset.targetStatus;
        const verb = target === 'active' ? 'Activate' : 'Deactivate';
        if (!confirm(`${verb} agent ${id}?`)) return;
        try {
          await api(`/agents/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ status: target })
          });
          loadAgents();
          loadOverview();
        } catch (e) {
          console.error(`${verb} failed:`, e.message);
          alert(`${verb} failed: ` + e.message);
        }
      });
    });
  } catch (e) {
    console.error('loadAgents failed:', e.message);
    tbody.innerHTML = `<tr><td colspan="8" class="muted">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function searchAgents(q) {
  const tbody = document.querySelector('#agentsTable tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="muted">Searching…</td></tr>`;
  try {
    const data = await api(`/agents/search?q=${encodeURIComponent(q)}`);
    if (!data.results.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted">No matches.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.results.map(r => {
      const a = r.agent;
      const scorePct = Math.round((r.score || 0) * 100);
      return `
        <tr>
          <td>${escapeHtml(a.name)}</td>
          <td>${escapeHtml(a.provider)}</td>
          <td>${(a.protocols || []).map(p => escapeHtml(p)).join(', ')}</td>
          <td><span class="status-pill status-${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td>
          <td>
            <span class="score-bar"><span style="width:${scorePct}%"></span></span>
            <span class="muted">${scorePct}%</span>
          </td>
          <td>—</td><td>—</td>
          <td>
            <a href="/agents/${encodeURIComponent(a.id)}/.well-known/agent.json" target="_blank">Card</a>
          </td>
        </tr>`;
    }).join('');
  } catch (e) {
    console.error('searchAgents failed:', e.message);
    tbody.innerHTML = `<tr><td colspan="8" class="muted">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

document.getElementById('agentSearchBtn').addEventListener('click', () => {
  const q = document.getElementById('agentSearch').value.trim();
  if (q) searchAgents(q);
});

document.getElementById('agentSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = e.target.value.trim();
    if (q) searchAgents(q);
  }
});

document.getElementById('agentClearBtn').addEventListener('click', () => {
  document.getElementById('agentSearch').value = '';
  loadAgents();
});

// ─────────────────────────────────────── MCP

async function loadMcp() {
  const tbody = document.querySelector('#mcpTable tbody');
  tbody.innerHTML = `<tr><td colspan="7" class="muted">Loading…</td></tr>`;
  try {
    // Admins see inactive servers too, so they can reactivate them.
    const query = isAdmin() ? '/mcp?limit=100&status=all' : '/mcp?limit=100';
    const data = await api(query);
    if (!data.servers.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted">No MCP servers yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.servers.map(s => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td><span class="status-pill status-active">${escapeHtml(s.transport)}</span></td>
        <td>${escapeHtml(s.category || '—')}</td>
        <td>${(s.tools || []).length}</td>
        <td>${escapeHtml(s.author || '—')}</td>
        <td><span class="status-pill status-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span></td>
        <td class="actions">
          ${isAdmin()
            ? `<button class="ghost" data-edit-mcp="${escapeHtml(s.id)}">Edit</button>
               <button class="ghost" data-toggle-mcp="${escapeHtml(s.id)}" data-target-status="${s.status === 'active' ? 'inactive' : 'active'}">${s.status === 'active' ? 'Deactivate' : 'Activate'}</button>`
            : '<span class="muted">—</span>'}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-edit-mcp]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.editMcp;
        try {
          const server = await api(`/mcp/${encodeURIComponent(id)}`);
          openMcpModal(server);
        } catch (e) {
          console.error('Load mcp for edit failed:', e.message);
          alert('Could not load MCP server: ' + e.message);
        }
      });
    });

    tbody.querySelectorAll('[data-toggle-mcp]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.toggleMcp;
        const target = btn.dataset.targetStatus;
        const verb = target === 'active' ? 'Activate' : 'Deactivate';
        if (!confirm(`${verb} MCP server ${id}?`)) return;
        try {
          await api(`/mcp/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ status: target })
          });
          loadMcp();
          loadOverview();
        } catch (e) {
          console.error(`${verb} MCP failed:`, e.message);
          alert(`${verb} failed: ` + e.message);
        }
      });
    });
  } catch (e) {
    console.error('loadMcp failed:', e.message);
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

// ─────────────────────────────────────── Health

async function loadHealth() {
  const list = document.getElementById('healthList');
  list.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const data = await api('/agents?limit=100');
    if (!data.agents.length) {
      list.innerHTML = `<p class="muted">No agents registered.</p>`;
      return;
    }
    const rows = await Promise.all(data.agents.map(async (a) => {
      let h = null;
      try { h = await api(`/agents/${encodeURIComponent(a.id)}/health`); } catch (e) { /* tolerate */ }
      const checks = (h?.checks || []).slice(0, 24).reverse();
      const dots = Array.from({ length: 24 }).map((_, i) => {
        const c = checks[i];
        return `<span class="dot ${c ? escapeHtml(c.status) : ''}" title="${c ? escapeHtml(c.checked_at) : 'no check'}"></span>`;
      }).join('');
      return `
        <div class="health-row">
          <div class="head">
            <span class="name">${escapeHtml(a.name)} <span class="muted">${escapeHtml(a.id)}</span></span>
            <span class="pct">${h?.uptime_pct != null ? h.uptime_pct + '%' : '—'} uptime</span>
          </div>
          <div class="dots">${dots}</div>
        </div>`;
    }));
    list.innerHTML = rows.join('');
  } catch (e) {
    console.error('loadHealth failed:', e.message);
    list.innerHTML = `<p class="muted">Error: ${escapeHtml(e.message)}</p>`;
  }
}

// ─────────────────────────────────────── Modals (agent + MCP)

// Generic "Cancel" hook for any modal that has [data-close-modal="modalId"]
document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => {
    const m = document.getElementById(btn.dataset.closeModal);
    if (m) m.hidden = true;
  });
});

// ── Agent modal (add + edit) ────────────────────────────────────────────────

const agentModal       = document.getElementById('agentModal');
const agentForm        = document.getElementById('agentForm');
const agentModalTitle  = document.getElementById('agentModalTitle');
const agentSubmitBtn   = document.getElementById('agentSubmitBtn');
const agentFormError   = document.getElementById('agentFormError');

function openAgentModal(agent /* null = add */) {
  agentFormError.textContent = '';
  agentForm.reset();
  agentForm.elements.id.value = agent?.id || '';
  agentModalTitle.textContent = agent ? `Edit agent: ${agent.name}` : 'Register a new agent';
  agentSubmitBtn.textContent = agent ? 'Save' : 'Create';
  agentForm.querySelectorAll('.edit-only').forEach(el => { el.hidden = !agent; });

  if (agent) {
    agentForm.elements.name.value = agent.name || '';
    agentForm.elements.description.value = agent.description || '';
    agentForm.elements.provider.value = agent.provider || '';
    agentForm.elements.endpoint_url.value = agent.endpoint_url || '';
    agentForm.elements.protocols.value = (agent.protocols || []).join(', ');
    agentForm.elements.capabilities.value = (agent.capabilities || []).join(', ');
    agentForm.elements.hosting.value = agent.hosting || 'referenced';
    agentForm.elements.auth_type.value = agent.auth_type || 'none';
    if (agentForm.elements.status) agentForm.elements.status.value = agent.status || 'active';
  }
  agentModal.hidden = false;
}

document.getElementById('agentAddBtn').addEventListener('click', () => openAgentModal(null));

agentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  agentFormError.textContent = '';
  const fd = new FormData(agentForm);
  const id = fd.get('id');
  const body = {
    name: fd.get('name'),
    description: fd.get('description'),
    provider: fd.get('provider'),
    endpoint_url: fd.get('endpoint_url') || undefined,
    protocols: (fd.get('protocols') || 'A2A').split(',').map(s => s.trim()).filter(Boolean),
    capabilities: (fd.get('capabilities') || '').split(',').map(s => s.trim()).filter(Boolean),
    hosting: fd.get('hosting'),
    auth_type: fd.get('auth_type')
  };
  if (id) body.status = fd.get('status');

  try {
    if (id) {
      await api(`/agents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/agents', { method: 'POST', body: JSON.stringify(body) });
    }
    agentModal.hidden = true;
    agentForm.reset();
    loadAgents();
    loadOverview();
  } catch (err) {
    console.error('Agent form submit failed:', err.message);
    agentFormError.textContent = err.message;
  }
});

// ── MCP modal (add + edit) ──────────────────────────────────────────────────

const mcpModal      = document.getElementById('mcpModal');
const mcpForm       = document.getElementById('mcpForm');
const mcpModalTitle = document.getElementById('mcpModalTitle');
const mcpSubmitBtn  = document.getElementById('mcpSubmitBtn');
const mcpFormError  = document.getElementById('mcpFormError');

function openMcpModal(server /* null = add */) {
  mcpFormError.textContent = '';
  mcpForm.reset();
  mcpForm.elements.id.value = server?.id || '';
  mcpModalTitle.textContent = server ? `Edit MCP server: ${server.name}` : 'Register a new MCP server';
  mcpSubmitBtn.textContent = server ? 'Save' : 'Create';
  mcpForm.querySelectorAll('.edit-only').forEach(el => { el.hidden = !server; });

  if (server) {
    mcpForm.elements.name.value = server.name || '';
    mcpForm.elements.description.value = server.description || '';
    mcpForm.elements.transport.value = server.transport || 'http';
    mcpForm.elements.category.value = server.category || '';
    mcpForm.elements.author.value = server.author || '';
    mcpForm.elements.config_url.value = server.config_url || '';
    mcpForm.elements.package_url.value = server.package_url || '';
    mcpForm.elements.tools.value = JSON.stringify(server.tools || [], null, 2);
    if (mcpForm.elements.status) mcpForm.elements.status.value = server.status || 'active';
  } else {
    mcpForm.elements.tools.value = '[]';
  }
  mcpModal.hidden = false;
}

document.getElementById('mcpAddBtn').addEventListener('click', () => openMcpModal(null));

mcpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  mcpFormError.textContent = '';
  const fd = new FormData(mcpForm);
  const id = fd.get('id');

  let tools;
  try {
    tools = JSON.parse(fd.get('tools') || '[]');
    if (!Array.isArray(tools)) throw new Error('tools must be a JSON array');
  } catch (err) {
    mcpFormError.textContent = 'Tools field must be a JSON array. ' + err.message;
    return;
  }

  const body = {
    name: fd.get('name'),
    description: fd.get('description'),
    transport: fd.get('transport'),
    category: fd.get('category') || undefined,
    author: fd.get('author') || undefined,
    config_url: fd.get('config_url') || undefined,
    package_url: fd.get('package_url') || undefined,
    tools
  };
  if (id) body.status = fd.get('status');

  try {
    if (id) {
      await api(`/mcp/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/mcp', { method: 'POST', body: JSON.stringify(body) });
    }
    mcpModal.hidden = true;
    mcpForm.reset();
    loadMcp();
    loadOverview();
  } catch (err) {
    console.error('MCP form submit failed:', err.message);
    mcpFormError.textContent = err.message;
  }
});

// ─────────────────────────────────────── Settings

document.getElementById('saveTokenBtn').addEventListener('click', () => {
  const input = document.getElementById('adminTokenInput');
  const v = input.value.trim();
  setToken(v);
  // Visible feedback that the click did something.
  const status = document.getElementById('tokenStatus');
  if (status) {
    const original = status.textContent;
    status.textContent = v ? '✓ Saved. Switch to Agents or MCP to use admin actions.' : '✗ Token cleared.';
    setTimeout(() => { if (status.textContent !== original) updateAdminUI(); }, 2500);
  }
  input.value = '';
});

document.getElementById('clearTokenBtn').addEventListener('click', () => {
  document.getElementById('adminTokenInput').value = '';
  setToken('');
  const status = document.getElementById('tokenStatus');
  if (status) status.textContent = '✗ Token cleared.';
});

document.getElementById('testTokenBtn').addEventListener('click', async () => {
  const status = document.getElementById('tokenStatus');
  if (!isAdmin()) {
    status.textContent = '✗ No token saved. Paste it and click Save first.';
    return;
  }
  status.textContent = 'Testing…';
  // Use an admin-only endpoint that doesn't mutate anything.
  // PUT /agents/__nonexistent__ with admin = 404; without admin = 401.
  try {
    const res = await fetch('/agents/__token_probe__', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: '{}',
      signal: AbortSignal.timeout(8000)
    });
    if (res.status === 401) {
      status.textContent = '✗ Token rejected. The server expects a different value (check the ADMIN_TOKEN your server was started with).';
    } else if (res.status === 404) {
      status.textContent = '✓ Token accepted. Admin actions enabled.';
    } else {
      status.textContent = `? Server returned ${res.status}. Token probably ok, but unexpected response.`;
    }
  } catch (e) {
    console.error('Token test failed:', e.message);
    status.textContent = '✗ Test failed: ' + e.message;
  }
});

// ─────────────────────────────────────── Init

updateAdminUI();
loadOverview();
loadAgents();
loadMcp();
