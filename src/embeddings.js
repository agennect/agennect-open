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
    default: throw new Error(`Unknown LLM_PROVIDER: ${PROVIDER}`);
  }
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
