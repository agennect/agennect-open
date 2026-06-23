const PROVIDER = process.env.LLM_PROVIDER || 'anthropic';
const MODEL = process.env.EMBEDDING_MODEL || 'voyage-3';

export async function embed(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('embed(): text must be a non-empty string');
  }
  switch (PROVIDER) {
    case 'anthropic': return embedVoyage(text);
    case 'openai':    return embedOpenAI(text);
    case 'ollama':    return embedOllama(text);
    case 'mock':      return embedMock(text);
    default: throw new Error(`Unknown LLM_PROVIDER: ${PROVIDER}`);
  }
}

// Deterministic bag-of-words style embedder, used by CI so semantic-search
// tests don't need a real API key. Same text always yields the same vector;
// texts sharing tokens cluster near each other under cosine distance.
function embedMock(text) {
  const dims = parseInt(process.env.EMBEDDING_DIMS || '1024');
  const vec = new Array(dims).fill(0);
  const tokens = String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1);

  for (const tok of tokens) {
    let h = 5381;
    for (let i = 0; i < tok.length; i++) {
      h = (h * 33) ^ tok.charCodeAt(i);
    }
    const idx = Math.abs(h | 0) % dims;
    vec[idx] += 1;
  }

  // L2-normalize so cosine distance behaves nicely.
  let mag = 0;
  for (const v of vec) mag += v * v;
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < dims; i++) vec[i] /= mag;

  return vec;
}

async function embedVoyage(text) {
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ANTHROPIC_API_KEY}`
      },
      body: JSON.stringify({ input: [text], model: MODEL }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`Voyage API error: ${res.status}`);
    const data = await res.json();
    return data.data[0].embedding;
  } catch (e) {
    console.error('embedVoyage failed:', e.message);
    throw e;
  }
}

async function embedOpenAI(text) {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({ input: text, model: MODEL }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    const data = await res.json();
    return data.data[0].embedding;
  } catch (e) {
    console.error('embedOpenAI failed:', e.message);
    throw e;
  }
}

async function embedOllama(text) {
  try {
    const base = process.env.OLLAMA_URL || 'http://localhost:11434';
    const res = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL || 'nomic-embed-text',
        prompt: text
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
    const data = await res.json();
    return data.embedding;
  } catch (e) {
    console.error('embedOllama failed:', e.message);
    throw e;
  }
}
