// Meta endpoints: OpenAPI spec.
//
// /openapi.yaml — raw YAML (the canonical authored form)
// /openapi.json — same spec, parsed once at startup and served as JSON

import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parse as parseYaml } from 'yaml';

export const metaRouter = new Hono();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(__dirname, '../../docs/openapi.yaml');
const LLMS_PATH = join(__dirname, '../../llms.txt');

let yamlText = '';
let jsonSpec = null;
let llmsText = '';

try {
  yamlText = readFileSync(SPEC_PATH, 'utf8');
  jsonSpec = parseYaml(yamlText);
} catch (e) {
  console.error('OpenAPI spec load failed:', e.message);
}

try {
  llmsText = readFileSync(LLMS_PATH, 'utf8');
} catch (e) {
  console.error('llms.txt load failed:', e.message);
}

metaRouter.get('/openapi.yaml', (c) => {
  if (!yamlText) return c.json({ error: 'OpenAPI spec unavailable' }, 500);
  c.header('Content-Type', 'text/yaml; charset=utf-8');
  return c.body(yamlText);
});

metaRouter.get('/openapi.json', (c) => {
  if (!jsonSpec) return c.json({ error: 'OpenAPI spec unavailable' }, 500);
  return c.json(jsonSpec);
});

metaRouter.get('/llms.txt', (c) => {
  if (!llmsText) return c.json({ error: 'llms.txt unavailable' }, 500);
  c.header('Content-Type', 'text/plain; charset=utf-8');
  return c.body(llmsText);
});
