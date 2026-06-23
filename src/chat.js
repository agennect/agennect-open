// Chat completion abstraction with strict structured output.
//
// All providers are asked to produce ONE tool call matching the
// supplied JSON schema. We return the parsed object — or null when
// the configured provider is "mock" / unavailable, signalling the
// caller (currently the Connect Agent) to fall back to its
// deterministic state-machine.
//
// LLM_PROVIDER reuses the same env as embeddings so config stays simple.
// CHAT_MODEL picks the model within the provider; sensible defaults
// per provider.

import { logger } from './logger.js';

const PROVIDER = process.env.LLM_PROVIDER || 'anthropic';

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai:    'gpt-4o-mini',
  ollama:    'llama3.1'
};

function chatModel() {
  return process.env.CHAT_MODEL || DEFAULT_MODELS[PROVIDER] || '';
}

// Returns the parsed tool-call object, or null when no provider is
// usable (mock, missing API key, network failure). Never throws — the
// caller is expected to handle null with a fallback.
export async function structuredChat({ system, messages, tool, maxTokens = 1024 }) {
  try {
    switch (PROVIDER) {
      case 'anthropic': return await anthropicChat({ system, messages, tool, maxTokens });
      case 'openai':    return await openaiChat({    system, messages, tool, maxTokens });
      case 'ollama':    return await ollamaChat({    system, messages, tool, maxTokens });
      case 'mock':      return null;   // explicit fallback signal
      default:
        logger.warn('structuredChat: unknown LLM_PROVIDER, falling back', { provider: PROVIDER });
        return null;
    }
  } catch (e) {
    logger.error('structuredChat failed', { provider: PROVIDER, err: e.message });
    return null;
  }
}

// ── Anthropic Claude ──────────────────────────────────────────────────────
async function anthropicChat({ system, messages, tool, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.startsWith('sk-ant-...')) {
    logger.warn('anthropicChat: ANTHROPIC_API_KEY not set, falling back');
    return null;
  }

  const body = {
    model: chatModel(),
    max_tokens: maxTokens,
    system,
    tools: [{
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema
    }],
    tool_choice: { type: 'tool', name: tool.name },
    messages
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Anthropic response had no tool_use block');
  return toolUse.input;
}

// ── OpenAI ────────────────────────────────────────────────────────────────
async function openaiChat({ system, messages, tool, maxTokens }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith('sk-...')) {
    logger.warn('openaiChat: OPENAI_API_KEY not set, falling back');
    return null;
  }

  const body = {
    model: chatModel(),
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages
    ],
    tools: [{
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema
      }
    }],
    tool_choice: { type: 'function', function: { name: tool.name } }
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.arguments) throw new Error('OpenAI response had no tool_call');
  return JSON.parse(call.function.arguments);
}

// ── Ollama (local) ────────────────────────────────────────────────────────
async function ollamaChat({ system, messages, tool, maxTokens }) {
  const base = process.env.OLLAMA_URL || 'http://localhost:11434';

  // Ollama has format=json but no native tool-use. We coerce by
  // instructing the model to output ONLY a JSON object matching the
  // schema, no tool wrapper.
  const sysWithSchema = [
    system || '',
    '',
    'You MUST respond with exactly one JSON object that conforms to this JSON Schema. No prose, no markdown, no code fences. Just the object.',
    JSON.stringify(tool.schema)
  ].join('\n');

  const body = {
    model: chatModel(),
    messages: [
      { role: 'system', content: sysWithSchema },
      ...messages
    ],
    format: 'json',
    stream: false,
    options: { num_predict: maxTokens }
  };

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)  // local model can be slow
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.message?.content || '';
  return JSON.parse(content);
}
