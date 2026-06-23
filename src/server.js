import './load-env.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { agentsRouter } from './routes/agents.js';
import { mcpRouter } from './routes/mcp.js';
import { invokeRouter } from './routes/invoke.js';
import { metricsRouter } from './routes/metrics.js';
import { adminRouter } from './routes/admin.js';
import { metaRouter } from './routes/meta.js';
import { authRouter } from './routes/auth.js';
import { startHealthChecks } from './health.js';
import { bootstrapEnvToken, verifyToken, scopeSatisfies } from './auth.js';
import { findUserById } from './users.js';
import { db } from './db.js';
import { logger, runWithRequestContext } from './logger.js';

const app = new Hono();

// ── CORS — configurable via CORS_ORIGINS (comma-separated, default '*') ────
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

function resolveCorsOrigin(reqOrigin) {
  if (CORS_ORIGINS.includes('*')) return '*';
  if (reqOrigin && CORS_ORIGINS.includes(reqOrigin)) return reqOrigin;
  return null; // not allowed
}

// ── Request-id + access log ───────────────────────────────────────────────
// Every request runs inside an AsyncLocalStorage context with a generated
// req_id. logger.* calls anywhere downstream automatically include it.
// Exposes the id to clients via X-Request-Id so they can correlate.
app.use('*', async (c, next) => {
  const reqId = c.req.header('X-Request-Id') || crypto.randomUUID();
  const started = Date.now();
  c.set('reqId', reqId);
  c.header('X-Request-Id', reqId);

  await runWithRequestContext({ req_id: reqId }, async () => {
    try {
      await next();
    } finally {
      logger.info('http', {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: Date.now() - started
      });
    }
  });
});

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
  let token = match ? verifyToken(match[1]) : null;
  let user  = token?.user_id ? findUserById(token.user_id) : null;

  // If the underlying user has been disabled since this token was issued,
  // treat the request as if it had no token at all. (We don't revoke the
  // token row here to avoid surprising the admin who disabled them — the
  // disable endpoint already revokes outstanding sessions.)
  if (user && user.disabled_at) {
    token = null;
    user  = null;
  }

  c.set('token', token);
  c.set('user',  user);
  c.set('scope', token?.scope || null);

  // `isAdmin` now means "globally privileged":
  //   - env-bootstrap (no user) with admin scope, OR
  //   - a logged-in user whose role is 'admin'.
  // Regular write-scope users do NOT see admin UI.
  const isGlobalAdmin = token
    ? (!token.user_id && scopeSatisfies(token.scope, 'admin'))
      || (user?.role === 'admin')
    : false;
  c.set('isAdmin', isGlobalAdmin);

  await next();
});

// Canonical /v1 prefix. invokeRouter must come before agentsRouter so
// /agents/:id/tasks is resolved to the invocation handler rather than
// swallowed by the generic /:id route.
app.route('/v1/agents',  invokeRouter);
app.route('/v1/agents',  agentsRouter);
app.route('/v1/mcp',     mcpRouter);
app.route('/v1/metrics', metricsRouter);
app.route('/v1/admin',   adminRouter);
app.route('/v1/auth',    authRouter);

// Top-level aliases — kept for backward compatibility with existing
// clients (the dashboard, the seed script, and earlier README examples).
// New consumers should use /v1.
app.route('/agents',  invokeRouter);
app.route('/agents',  agentsRouter);
app.route('/mcp',     mcpRouter);
app.route('/metrics', metricsRouter);
app.route('/admin',   adminRouter);
app.route('/auth',    authRouter);

// Meta: /openapi.json + /openapi.yaml
app.route('/', metaRouter);

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
  logger.error('unhandled error', { err: err.message, stack: err.stack });
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
  logger.info('agennect-open registry running', {
    host: HOST,
    port: PORT,
    cors: CORS_ORIGINS.join(',')
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown started', { signal });

  if (healthCheckHandle) clearInterval(healthCheckHandle);

  // 15s upper bound; force exit if HTTP server doesn't drain in time.
  const forceTimer = setTimeout(() => {
    logger.error('drain timeout exceeded, forcing exit');
    process.exit(1);
  }, 15000);
  forceTimer.unref();

  server.close((err) => {
    if (err) logger.error('http server close error', { err: err.message });
    try {
      // Checkpoint WAL so the DB file on disk is fully consistent.
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      logger.info('database closed cleanly');
    } catch (e) {
      logger.error('db close error', { err: e.message });
    }
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export default app;
