# Security Policy

## Supported versions

agennect-open is at pre-1.0 (v0.x). Only the latest tagged release on
`main` is supported with security fixes. Earlier versions will not
receive backports.

## Reporting a vulnerability

**Please do not open public GitHub issues for security problems.**

Email a description to **security@agennect.com**. If that mailbox is
unreachable, open a private [GitHub Security Advisory] on this repo
instead.

Include:

- a summary of the issue,
- steps to reproduce (or a proof-of-concept),
- the version / commit you tested against,
- the impact you believe it has (data exposure, RCE, DoS, etc.),
- any suggested fix or mitigation if you have one.

We will acknowledge within 3 business days, share an initial
assessment within 7, and aim to ship a fix within 30 days for high /
critical issues. Coordinated disclosure preferred — we'll credit you in
the release notes unless you ask us not to.

[GitHub Security Advisory]: https://github.com/agennect/agennect-open/security/advisories/new

## Scope

In scope:

- The server in `src/` (registry, auth, audit, webhooks, SDK).
- The migrations and DB schema.
- The dashboard's auth + token handling.
- The `src/sdk/` reporter libraries.

Out of scope (please don't report these):

- Vulnerabilities in upstream dependencies — report them upstream first.
- DoS via expensive search queries against your own instance.
- Self-XSS in the dashboard against your own browser session.
- Anything requiring an attacker to already hold an `admin`-scope token.

## What we deploy without

agennect-open is self-hosted by design — there is no agennect-managed
cloud instance covered by this policy. Each operator is responsible for
their own deployment's network exposure, TLS termination, and the
contents of their `ADMIN_TOKEN`, `ADMIN_EMAILS`, and Firebase project.

## Security model summary

- Every mutation requires a Bearer token with `write` or `admin` scope.
- Tokens are stored as SHA-256 hashes; plaintext is shown once on create.
- Per-resource ownership: a `write`-scope user can only mutate rows whose
  `owner_user_id` matches their user id. Admins can mutate anything.
- Webhooks are signed with HMAC-SHA256; the signing key is
  `sha256(secret)` and the secret is shown exactly once.
- Disabled users are rejected by the auth middleware on every request,
  and their tokens are revoked at disable time.
- An audit log row is written for every successful mutation.
