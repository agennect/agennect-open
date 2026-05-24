// agennect-open SDK — Mode B invocation reporter (JavaScript / Node 20+)
//
// Copy this file into your agent or orchestrator project. No dependencies
// beyond global fetch (Node 18+, modern browsers).
//
// Usage:
//   import { AgennectReporter } from './reporter.js';
//
//   const reporter = new AgennectReporter('http://localhost:3000', {
//     callerId: 'my-orchestrator'
//   });
//
//   // Option A: let the SDK invoke the agent and report for you.
//   const { invoke } = reporter.wrap('dataoracle-x7k2');
//   const { result, latency_ms } = await invoke(
//     'https://myagent.com/tasks',
//     { message: { parts: [{ type: 'text', text: 'Analyze Q1 data' }] } }
//   );
//
//   // Option B: report metrics for an invocation you handled yourself.
//   await reporter.report('dataoracle-x7k2', {
//     latency_ms: 340,
//     status: 'success',
//     request_size: 512,
//     response_size: 1024
//   });

export class AgennectReporter {
  constructor(registryUrl, options = {}) {
    if (!registryUrl) throw new Error('AgennectReporter: registryUrl is required');
    this.registryUrl = String(registryUrl).replace(/\/$/, '');
    this.reportTimeoutMs = options.reportTimeoutMs ?? 5000;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 30000;
    this.callerId = options.callerId || null;
  }

  // Returns an object with .invoke() bound to one agent id.
  wrap(agentId) {
    if (!agentId) throw new Error('wrap(): agentId is required');
    return {
      invoke: async (endpointUrl, payload, authHeaders = {}) => {
        return this.invoke(agentId, endpointUrl, payload, authHeaders);
      }
    };
  }

  // Calls the agent endpoint, reports metrics (fire-and-forget),
  // and returns { result, latency_ms }. Throws on non-success.
  async invoke(agentId, endpointUrl, payload, authHeaders = {}) {
    if (!agentId)      throw new Error('invoke(): agentId is required');
    if (!endpointUrl)  throw new Error('invoke(): endpointUrl is required');

    const start = Date.now();
    let status = 'error';
    let errorMsg = null;
    let result = null;
    let responseSize = null;

    const requestBody = JSON.stringify(payload ?? {});
    const requestSize = new TextEncoder().encode(requestBody).length;

    try {
      const res = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: requestBody,
        signal: AbortSignal.timeout(this.invokeTimeoutMs)
      });

      const text = await res.text();
      responseSize = new TextEncoder().encode(text).length;

      if (res.ok) {
        status = 'success';
        try { result = JSON.parse(text); }
        catch (e) { result = { text }; }
      } else {
        status = 'error';
        errorMsg = `HTTP ${res.status}`;
      }
    } catch (e) {
      status = (e.name === 'TimeoutError' || e.name === 'AbortError')
        ? 'timeout' : 'error';
      errorMsg = e.message;
    }

    const latency_ms = Date.now() - start;

    // Fire-and-forget; don't block the caller on registry availability.
    this._report(agentId, {
      latency_ms,
      status,
      request_size: requestSize,
      response_size: responseSize,
      error_msg: errorMsg
    }).catch((err) => {
      console.error('[AgennectReporter] report failed:', err.message);
    });

    if (status !== 'success') {
      const err = new Error(errorMsg || 'Invocation failed');
      err.status = status;
      err.latency_ms = latency_ms;
      throw err;
    }

    return { result, latency_ms };
  }

  // Report metrics for an invocation you handled yourself.
  async report(agentId, metrics) {
    if (!agentId) throw new Error('report(): agentId is required');
    return this._report(agentId, metrics);
  }

  async _report(agentId, metrics) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.callerId) headers['X-Caller-ID'] = this.callerId;

    const res = await fetch(
      `${this.registryUrl}/agents/${encodeURIComponent(agentId)}/report`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(metrics),
        signal: AbortSignal.timeout(this.reportTimeoutMs)
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Report failed: ${res.status} ${text}`);
    }
    return res.json();
  }
}
