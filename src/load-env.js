// Minimal .env loader. No dependency. Idempotent.
// Reads ./.env from the current working directory if present.
// Existing process.env values always win.

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function parseEnv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip wrapping quotes (single or double), preserving inner content.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv(path = '.env') {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return false;
  try {
    const parsed = parseEnv(readFileSync(full, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return true;
  } catch (e) {
    console.error('loadEnv failed:', e.message);
    return false;
  }
}

loadEnv();
