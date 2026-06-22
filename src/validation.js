// Zod schemas + a tiny helper for converting validation errors
// into a consistent HTTP 400 response.

import { z } from 'zod';

// ── Agent ──────────────────────────────────────────────────────────────────

const AUTH_TYPES = ['none', 'apikey', 'oauth'];
const HOSTINGS   = ['referenced', 'hosted'];
const STATUSES   = ['active', 'inactive', 'degraded'];

export const AgentCreateSchema = z.object({
  name:         z.string().min(1, 'name is required'),
  description:  z.string().min(20, 'description must be at least 20 characters'),
  provider:     z.string().min(1, 'provider is required'),
  version:      z.string().optional(),
  protocols:    z.array(z.string()).optional(),
  endpoint_url: z.string().url().optional().nullable(),
  auth_type:    z.enum(AUTH_TYPES).optional(),
  auth_header:  z.string().optional().nullable(),
  hosting:      z.enum(HOSTINGS).optional(),
  capabilities: z.array(z.string()).optional(),
  tags:         z.array(z.string()).optional()
}).passthrough();

export const AgentUpdateSchema = z.object({
  name:           z.string().min(1).optional(),
  description:    z.string().min(20).optional(),
  provider:       z.string().min(1).optional(),
  version:        z.string().optional(),
  protocols:      z.array(z.string()).optional(),
  endpoint_url:   z.string().url().nullable().optional(),
  auth_type:      z.enum(AUTH_TYPES).optional(),
  auth_header:    z.string().nullable().optional(),
  hosting:        z.enum(HOSTINGS).optional(),
  status:         z.enum(STATUSES).optional(),
  capabilities:   z.array(z.string()).optional(),
  tags:           z.array(z.string()).optional(),
  proxy_enabled:  z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  proxy_timeout_ms: z.number().int().min(100).max(600000).optional()
}).passthrough();

// ── MCP server ─────────────────────────────────────────────────────────────

const TRANSPORTS    = ['stdio', 'http', 'sse'];
const MCP_STATUSES  = ['active', 'inactive'];

export const McpCreateSchema = z.object({
  name:        z.string().min(1, 'name is required'),
  description: z.string().min(1, 'description is required'),
  transport:   z.enum(TRANSPORTS),
  config_url:  z.string().url().optional().nullable(),
  package_url: z.string().url().optional().nullable(),
  tools:       z.array(z.any()).optional(),
  category:    z.string().optional().nullable(),
  author:      z.string().optional().nullable()
}).passthrough();

export const McpUpdateSchema = z.object({
  name:        z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  transport:   z.enum(TRANSPORTS).optional(),
  config_url:  z.string().url().nullable().optional(),
  package_url: z.string().url().nullable().optional(),
  tools:       z.array(z.any()).optional(),
  category:    z.string().nullable().optional(),
  author:      z.string().nullable().optional(),
  status:      z.enum(MCP_STATUSES).optional()
}).passthrough();

// ── Invocation report (Mode B) ─────────────────────────────────────────────

export const ReportSchema = z.object({
  latency_ms:      z.number().nonnegative(),
  status:          z.enum(['success', 'error', 'timeout']),
  request_size:    z.number().int().nonnegative().optional().nullable(),
  response_size:   z.number().int().nonnegative().optional().nullable(),
  error_msg:       z.string().optional().nullable(),
  caller_agent_id: z.string().optional().nullable()
}).passthrough();

// ── Helper ─────────────────────────────────────────────────────────────────
// Returns { data } on success or a Hono Response on failure (return it directly).

export function parseOrError(c, schema, body) {
  const result = schema.safeParse(body);
  if (result.success) return { data: result.data };
  const messages = result.error.issues.map(i => {
    const path = i.path.length ? i.path.join('.') + ': ' : '';
    return path + i.message;
  });
  return { error: c.json({ error: messages.join('; ') }, 400) };
}
