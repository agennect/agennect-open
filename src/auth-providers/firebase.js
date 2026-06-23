// Firebase Auth provider.
//
// Verifies a Firebase ID token server-side. We never trust client claims
// directly — we fetch Google's signing keys (JWKS), verify the JWT, and
// check issuer + audience match the configured FIREBASE_PROJECT_ID.
//
// Required env:
//   FIREBASE_PROJECT_ID — the GCP project id used by your Firebase app.
//
// Returns a normalized identity:
//   { provider_sub, email, email_verified, name, raw }

import { jwtVerify, createRemoteJWKSet } from 'jose';

// Google publishes Firebase token signing keys at this JWKS URL.
// createRemoteJWKSet caches and refreshes automatically per RFC 7517.
const JWKS = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
));

export const NAME = 'firebase';

export async function verifyIdToken(idToken) {
  const projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID is not set');
  }

  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ['RS256']
  });

  if (!payload.sub) throw new Error('Firebase token missing sub');
  if (!payload.email) throw new Error('Firebase token missing email');

  return {
    provider_sub:   String(payload.sub),
    email:          String(payload.email),
    email_verified: Boolean(payload.email_verified),
    name:           payload.name ? String(payload.name) : null,
    raw:            payload
  };
}
