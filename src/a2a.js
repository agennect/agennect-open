export function generateAgentCard(agent, registryUrl) {
  // Accept either the raw DB row (protocols as JSON string) or a hydrated
  // agent (protocols as array).
  let protocols;
  if (Array.isArray(agent.protocols)) {
    protocols = agent.protocols;
  } else {
    try {
      protocols = JSON.parse(agent.protocols || '["A2A"]');
    } catch (e) {
      console.error('generateAgentCard protocols parse failed:', e.message);
      protocols = ['A2A'];
    }
  }
  const capabilities = agent.capabilities || [];

  return {
    schema_version: '0.2',
    id: agent.id,
    name: agent.name,
    description: agent.description,
    version: agent.version || '1.0.0',
    provider: {
      name: agent.provider,
      url: registryUrl
    },
    url: `${registryUrl}/agents/${agent.id}/tasks`,
    protocols,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false
    },
    authentication: {
      schemes: [agent.auth_type || 'none']
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: capabilities.map(cap => ({
      id: cap.toLowerCase().replace(/\s+/g, '_'),
      name: cap,
      description: `${agent.name} capability: ${cap}`,
      inputModes: ['text/plain', 'application/json'],
      outputModes: ['application/json']
    }))
  };
}

export async function adaptRestToA2A(agent, task, authValue) {
  if (!agent.endpoint_url) {
    throw new Error('Agent has no endpoint URL');
  }

  const headers = { 'Content-Type': 'application/json' };

  if (agent.auth_type === 'apikey' && authValue) {
    headers[agent.auth_header || 'X-API-Key'] = authValue;
  } else if (agent.auth_type === 'oauth' && authValue) {
    headers['Authorization'] = `Bearer ${authValue}`;
  }

  const start = Date.now();
  let res;
  try {
    res = await fetch(agent.endpoint_url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        task: task.message?.parts?.[0]?.text || task,
        context: task.context || {}
      }),
      signal: AbortSignal.timeout(30000)
    });
  } catch (e) {
    console.error('adaptRestToA2A fetch failed:', e.message);
    throw e;
  }

  const latency = Date.now() - start;

  if (!res.ok) {
    throw new Error(`Agent returned ${res.status}`);
  }

  let result;
  try {
    result = await res.json();
  } catch (e) {
    console.error('adaptRestToA2A: response was not JSON:', e.message);
    throw new Error('Agent response was not valid JSON');
  }

  return {
    id: crypto.randomUUID(),
    status: { state: 'completed' },
    result: {
      parts: [{ type: 'data', data: result }]
    },
    metadata: { latency_ms: latency }
  };
}
