const TOKEN_KEY = 'agennect_admin_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
  updateAdminUI();
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

// ─────────────────────────────────────── Tabs

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const target = document.getElementById('tab-' + btn.dataset.tab);
    if (target) target.classList.add('active');
    if (btn.dataset.tab === 'health') loadHealth();
  });
});

// ─────────────────────────────────────── Overview

async function loadOverview() {
  const cards = document.getElementById('cards');
  cards.innerHTML = '';
  try {
    const m = await api('/metrics');
    const data = [
      ['Total Agents', m.registry.agents_total],
      ['Active', m.registry.agents_active],
      ['Invocations 24h', m.invocations.last_24h],
      ['Success Rate', m.invocations.success_rate_24h != null
        ? (m.invocations.success_rate_24h * 100).toFixed(1) + '%'
        : '—'],
      ['Avg Latency', m.invocations.avg_latency_ms_24h != null
        ? m.invocations.avg_latency_ms_24h + ' ms'
        : '—'],
      ['MCP Servers', m.registry.mcp_servers],
      ['Agents Down', m.health.agents_down],
      ['Agents Up', m.health.agents_up]
    ];
    cards.innerHTML = data.map(([l, v]) => `
      <div class="card">
        <div class="label">${escapeHtml(l)}</div>
        <div class="value">${escapeHtml(v)}</div>
      </div>
    `).join('');

    const tbody = document.querySelector('#topAgentsTable tbody');
    tbody.innerHTML = m.top_agents.length
      ? m.top_agents.map(a => `
          <tr>
            <td>${escapeHtml(a.name || '(deleted)')}</td>
            <td class="muted">${escapeHtml(a.id || '')}</td>
            <td>${a.invocations_24h}</td>
          </tr>
        `).join('')
      : `<tr><td colspan="3" class="muted">No invocations in the last 24h.</td></tr>`;
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
          <td>
            <a href="/agents/${encodeURIComponent(a.id)}/.well-known/agent.json" target="_blank">Card</a>
            ${isAdmin()
              ? `<button class="ghost" data-deactivate="${escapeHtml(a.id)}">Deactivate</button>`
              : ''}
          </td>
        </tr>`;
    }));
    tbody.innerHTML = rows.join('');

    tbody.querySelectorAll('[data-deactivate]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deactivate;
        if (!confirm(`Deactivate agent ${id}?`)) return;
        try {
          await api(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
          loadAgents();
          loadOverview();
        } catch (e) {
          console.error('Deactivate failed:', e.message);
          alert('Deactivate failed: ' + e.message);
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
  tbody.innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;
  try {
    const data = await api('/mcp?limit=100');
    if (!data.servers.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted">No MCP servers yet.</td></tr>`;
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
      </tr>
    `).join('');
  } catch (e) {
    console.error('loadMcp failed:', e.message);
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Error: ${escapeHtml(e.message)}</td></tr>`;
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

// ─────────────────────────────────────── Add agent modal

const modal = document.getElementById('addAgentModal');
document.getElementById('agentAddBtn').addEventListener('click', () => {
  modal.hidden = false;
});
document.getElementById('cancelAddAgent').addEventListener('click', () => {
  modal.hidden = true;
});

document.getElementById('addAgentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('addAgentError');
  errBox.textContent = '';
  const form = e.target;
  const fd = new FormData(form);
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
  try {
    await api('/agents', { method: 'POST', body: JSON.stringify(body) });
    modal.hidden = true;
    form.reset();
    loadAgents();
    loadOverview();
  } catch (err) {
    console.error('Add agent failed:', err.message);
    errBox.textContent = err.message;
  }
});

// ─────────────────────────────────────── Settings

document.getElementById('saveTokenBtn').addEventListener('click', () => {
  const v = document.getElementById('adminTokenInput').value.trim();
  setToken(v);
});

document.getElementById('clearTokenBtn').addEventListener('click', () => {
  document.getElementById('adminTokenInput').value = '';
  setToken('');
});

// ─────────────────────────────────────── Init

updateAdminUI();
loadOverview();
loadAgents();
loadMcp();
