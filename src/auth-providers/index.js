// Pluggable external-auth provider dispatch.
//
// Add a new provider by:
//   1. Implementing src/auth-providers/<name>.js with the contract:
//        export const NAME = '<name>'
//        export async function verifyIdToken(idToken) → identity
//      where identity = { provider_sub, email, email_verified, name, raw }
//   2. Registering it in PROVIDERS below.
//
// Switch the live provider via AUTH_PROVIDER env var.

import * as firebase from './firebase.js';

const PROVIDERS = {
  [firebase.NAME]: firebase
};

export function currentProviderName() {
  return (process.env.AUTH_PROVIDER || 'firebase').trim();
}

export function currentProvider() {
  const name = currentProviderName();
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown AUTH_PROVIDER: ${name}. Known: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

export async function verifyExternalIdToken(idToken) {
  const provider = currentProvider();
  const identity = await provider.verifyIdToken(idToken);
  return { ...identity, provider: provider.NAME };
}
