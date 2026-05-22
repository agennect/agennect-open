import './load-env.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { agentsRouter } from './routes/agents.js';
import { mcpRouter } from './routes/mcp.js';
import { invokeRouter } from './routes/invoke.js';
import { metricsRouter } from './routes/metrics.js';
import { startHealthChecks } from './health.js';

const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Agent-Auth'
  );
});

app.options('*', (c) => c.text('', 204));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim() || 'change-me-before-deploy';
if (ADMIN_TOKEN === 'change-me-before-deploy') {
  console.warn('⚠ ADMIN_TOKEN is unset or default — admin endpoints accept the placeholder token. Set ADMIN_TOKEN in .env before deploying.');
}

app.use('*', async (c, next) => {
  const auth = c.req.header('Authorization') || '';
  c.set('isAdmin', auth === `Bearer ${ADMIN_TOKEN}`);
  await next();
});

// invokeRouter must come before agentsRouter so /agents/:id/tasks is resolved
// to the invocation handler rather than swallowed by the generic /:id route.
app.route('/agents', invokeRouter);
app.route('/agents', agentsRouter);
app.route('/mcp', mcpRouter);
app.route('/metrics', metricsRouter);

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

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

if (process.env.NODE_ENV !== 'test') {
  startHealthChecks();
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`\n🟢 agennect-open registry running`);
  console.log(`   API:       http://${HOST}:${PORT}/agents`);
  console.log(`   Dashboard: http://${HOST}:${PORT}/dashboard`);
  console.log(`   Metrics:   http://${HOST}:${PORT}/metrics`);
  console.log(`   MCP:       http://${HOST}:${PORT}/mcp\n`);
});

export default app;
