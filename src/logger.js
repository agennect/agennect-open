// Tiny structured logger. JSON lines in production (each log is one parseable
// JSON object); pretty single-line in dev. Zero dependencies.
//
// Request scoping via AsyncLocalStorage: middleware calls runWithRequestContext
// per HTTP request; any logger.* call inside that callback (even from deeply
// nested awaits) automatically picks up the req_id.
//
// Usage:
//   import { logger } from './logger.js';
//   logger.info('agent created', { agent_id });
//   logger.error('embed failed', { provider, err: e.message });

import { AsyncLocalStorage } from 'async_hooks';

const STORE = new AsyncLocalStorage();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const PRETTY = (process.env.LOG_PRETTY ?? (process.env.NODE_ENV !== 'production' ? '1' : '')) === '1';

export function runWithRequestContext(ctx, fn) {
  return STORE.run(ctx, fn);
}

function getCtx() {
  return STORE.getStore() || {};
}

function emit(level, msg, extra) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const rec = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...getCtx(),
    ...(extra || {})
  };

  if (PRETTY) {
    const tag = `[${rec.level.toUpperCase()}]`;
    const req = rec.req_id ? ` ${rec.req_id.slice(0, 8)}` : '';
    const extras = Object.entries(rec)
      .filter(([k]) => !['ts', 'level', 'msg', 'req_id'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    const line = `${rec.ts} ${tag}${req} ${rec.msg}${extras ? ' ' + extras : ''}`;
    (level === 'error' ? console.error : console.log)(line);
  } else {
    const line = JSON.stringify(rec);
    (level === 'error' ? console.error : console.log)(line);
  }
}

export const logger = {
  debug: (msg, extra) => emit('debug', msg, extra),
  info:  (msg, extra) => emit('info',  msg, extra),
  warn:  (msg, extra) => emit('warn',  msg, extra),
  error: (msg, extra) => emit('error', msg, extra)
};

// Helper for routes/middleware that have a Hono context — adds request-shaped
// fields without forcing every caller to remember them.
export function reqLog(c, level, msg, extra) {
  const merged = {
    method: c.req.method,
    path:   c.req.path,
    ...(extra || {})
  };
  emit(level, msg, merged);
}
