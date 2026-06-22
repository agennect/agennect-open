import './load-env.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { agentsRouter } from './routes/agents.js';
import { mcpRouter } from './routes/mcp.js';
import { invokeRouter } from './routes/invoke.js';
import { metricsRouter } from './routes/metrics.js';
import { adminRouter } from './routes/admin.js';
import { startHealthChecks } from './health.js';
import { bootstrapEnvToken, verifyToken, scopeSatisfies } from './auth.js';
import { db } from './db.js';

const app = new Hono();

// ── CORS — configurable via CORS_ORIGINS (comma-separated, default '*') ────
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

function resolveCorsOrigin(reqOrigin) {
  if (CORS_ORIGINS.includes('*')) return '*';
  if (reqOrigin && CORS_ORIGINS.includes(reqOrigin)) return reqOrigin;
  return null; // not allowed
}

// ── Security headers ──────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  await next();
  const reqOrigin = c.req.header('Origin');
  const allowed = resolveCorsOrigin(reqOrigin);
  if (allowed) {
    c.header('Access-Control-Allow-Origin', allowed);
    c.header('Vary', 'Origin');
  }
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Agent-Auth, X-Caller-ID');

  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  // STS only useful over HTTPS; enable when the proxy advertises it.
  if (c.req.header('X-Forwarded-Proto') === 'https') {
    c.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
});

app.options('*', (c) => c.text('', 204));

// ── Auth: parse Bearer token, look it up, set context ──────────────────────
bootstrapEnvToken();

app.use('*', async (c, next) => {
  const header = c.req.header('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? verifyToken(match[1]) : null;
  c.set('token', token);
  c.set('scope', token?.scope || null);
  // Backward compat with the old `isAdmin` flag used by some routes:
  // any write-capable token counts as admin for the dashboard's purposes.
  c.set('isAdmin', token ? scopeSatisfies(token.scope, 'write') : false);
  await next();
});

// invokeRouter must come before agentsRouter so /agents/:id/tasks is resolved
// to the invocation handler rather than swallowed by the generic /:id route.
app.route('/agents', invokeRouter);
app.route('/agents', agentsRouter);
app.route('/mcp', mcpRouter);
app.route('/metrics', metricsRouter);
app.route('/admin', adminRouter);

app.use('/dashboard/*', serveStatic({ root: './' }));
app.get('/dashboard', (c) => c.redirect('/dashboard/index.html'));

app.get('/', (c) => c.redirect('/dashboard'));

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  })
);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('Unhandled error:', err.message);
  return c.json({ error: err.message }, 500);
});

// ── Boot ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

let healthCheckHandle = null;
if (process.env.NODE_ENV !== 'test') {
  healthCheckHandle = startHealthChecks();
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`\n🟢 agennect-open registry running`);
  console.log(`   API:       http://${HOST}:${PORT}/agents`);
  console.log(`   Dashboard: http://${HOST}:${PORT}/dashboard`);
  console.log(`   Metrics:   http://${HOST}:${PORT}/metrics`);
  console.log(`   MCP:       http://${HOST}:${PORT}/mcp`);
  console.log(`   Admin:     http://${HOST}:${PORT}/admin/tokens`);
  console.log(`   CORS:      ${CORS_ORIGINS.join(', ')}\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — draining…`);

  if (healthCheckHandle) clearInterval(healthCheckHandle);

  // 15s upper bound; force exit if HTTP server doesn't drain in time.
  const forceTimer = setTimeout(() => {
    console.error('Drain timeout exceeded, forcing exit');
    process.exit(1);
  }, 15000);
  forceTimer.unref();

  server.close((err) => {
    if (err) console.error('HTTP server close error:', err.message);
    try {
      // Checkpoint WAL so the DB file on disk is fully consistent.
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('✓ Database closed cleanly');
    } catch (e) {
      console.error('DB close error:', e.message);
    }
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export default app;
