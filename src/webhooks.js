// Outbound webhooks with HMAC-SHA256 signatures.
//
// Subscribers register a URL + list of events (or "*" for all).
// When a matching event fires (currently: every audit() call),
// we POST a JSON payload to the URL with this header:
//
//   X-Agennect-Signature: t=<unix_ts>,v1=<hex(hmac_sha256(secret, t + "." + body))>
//
// Receivers can verify by re-computing the HMAC with their secret and
// comparing in constant time. The body is the raw POST body bytes,
// not the parsed JSON.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { db } from './db.js';

export const SIGNATURE_HEADER = 'X-Agennect-Signature';
const DELIVERY_TIMEOUT_MS = 5000;

export function generateWebhookSecret() {
  return 'whsec_' + randomBytes(32).toString('base64url');
}

export function hashSecret(plaintext) {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

// Returns true if `events` (the subscription's array) covers `eventName`.
function subscriptionMatches(events, eventName) {
  if (!Array.isArray(events)) return false;
  if (events.includes('*')) return true;
  if (events.includes(eventName)) return true;
  // Wildcard suffix like "agent.*"
  const prefix = eventName.split('.')[0] + '.*';
  return events.includes(prefix);
}

// Fan out an event to all matching subscribers. Fire-and-forget — errors
// are recorded against the webhook row but never thrown to the caller.
export function dispatchEvent(eventName, payload) {
  let webhooks;
  try {
    webhooks = db.prepare(
      `SELECT id, name, url, events FROM webhooks`
    ).all();
  } catch (e) {
    console.error('dispatchEvent: webhook lookup failed:', e.message);
    return;
  }

  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    event: eventName,
    delivered_at: new Date().toISOString(),
    data: payload
  });

  for (const w of webhooks) {
    let events;
    try { events = JSON.parse(w.events); }
    catch (e) {
      console.error(`webhook ${w.id} events parse failed:`, e.message);
      continue;
    }
    if (!subscriptionMatches(events, eventName)) continue;
    // We don't have the plaintext secret — we sign with the stored hash
    // hex. That's still a valid HMAC key; the receiver verifies with the
    // same hash, which they captured at creation. (The convention here:
    // the "secret" the receiver gets back from POST /admin/webhooks IS
    // what we hash, and the hash is the actual signing key.)
    deliver(w, body, ts).catch(e =>
      console.error(`webhook ${w.id} delivery failed:`, e.message)
    );
  }
}

async function deliver(webhook, body, ts) {
  // Fetch the signing key (the stored hash). We hash the secret once on
  // creation; both sides use that hash as the HMAC key.
  const key = db.prepare(`SELECT secret_hash FROM webhooks WHERE id = ?`).get(webhook.id)?.secret_hash;
  if (!key) return;

  const signature = createHmac('sha256', key)
    .update(`${ts}.${body}`)
    .digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    [SIGNATURE_HEADER]: `t=${ts},v1=${signature}`,
    'User-Agent': 'agennect-open-webhook/0.1'
  };

  let status = 0;
  let errMsg = null;
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    });
    status = res.status;
    if (!res.ok) {
      errMsg = `HTTP ${res.status}`;
    }
  } catch (e) {
    errMsg = e.message;
  }

  try {
    const failureIncrement = errMsg ? 1 : 0;
    db.prepare(`
      UPDATE webhooks
      SET last_delivery_at = datetime('now'),
          last_status = ?,
          last_error = ?,
          delivery_count = delivery_count + 1,
          failure_count = failure_count + ?
      WHERE id = ?
    `).run(status, errMsg, failureIncrement, webhook.id);
  } catch (e) {
    console.error(`webhook ${webhook.id} bookkeeping update failed:`, e.message);
  }
}

// Receiver-side verifier helper (exported so tests + SDKs can reuse it).
// Returns true when the signature is valid AND the timestamp is within
// the tolerance window. Defaults to 5 minutes — clamps replay attacks.
export function verifySignature(rawBody, signatureHeader, secretHash, toleranceSec = 300) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map(p => p.trim().split('='))
  );
  const t = parseInt(parts.t || '0', 10);
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - t);
  if (ageSec > toleranceSec) return false;

  const expected = createHmac('sha256', secretHash)
    .update(`${t}.${rawBody}`)
    .digest('hex');

  try {
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(v1, 'hex')
    );
  } catch (e) {
    return false;
  }
}
