# Contributing to agennect-open

Thanks for thinking about a contribution. agennect-open is a small
focused project; the bar for new dependencies, abstractions, and
config knobs is high.

## What we welcome

- Bug fixes with a minimal repro
- Test coverage for surfaces that don't have it yet
- Docs improvements (typos, clearer examples, missing flags)
- New SSO providers under `src/auth-providers/`
- New embedding providers in `src/embeddings.js`
- A real onboarding agent (see roadmap)

## What we usually decline

- New npm dependencies without a clear, narrow reason
- Frontend frameworks for the dashboard (it must stay buildless)
- TypeScript or other compile steps
- Multi-tenant org/project hierarchy (out of scope for now)
- Re-architectures that don't ship with a migration path

If you're not sure, open an issue first to discuss.

## Local setup

Node 20+, no other tools required.

```bash
git clone https://github.com/agennect/agennect-open
cd agennect-open
npm install
cp .env.example .env       # optional; defaults work
npm start                  # http://localhost:3000/dashboard
npm run seed               # populate 4 agents + 6 MCP servers
npm test                   # integration suite (needs the server up)
```

For the dashboard's SSO flow you'll need a Firebase project — see the
README's "Users, SSO & ownership" section.

## Coding conventions

- Plain JavaScript ES modules. No TypeScript.
- Two-space indent, semicolons.
- One Hono router per resource in `src/routes/`.
- Hand-written zod schemas live in `src/validation.js`.
- Every `fetch` call uses `AbortSignal.timeout(...)`. No bare timeouts.
- Every `catch` block logs via the project logger (or `console.error`
  in old code we haven't migrated).
- All HTTP errors return `{ error: string }` as JSON.
- No new top-level dependencies without justification.
- New mutation routes MUST call `audit(c, {action, target_*, before, after})`
  so webhooks fire automatically.

## Migrations

- Numbered files in `migrations/` — `001_*.sql` is initial, then
  `002_*.sql`, `003_*.sql`, ... Append-only; **never edit a numbered
  migration that has shipped on `main`**.
- The runner tolerates "duplicate column" errors so re-running 002+
  is safe.
- Add a smoke test (`DB_PATH=./data/_smoke.db node -e ...`) to your
  PR description showing the new schema applies on a fresh DB.

## Tests

`tests/integration.js` is a single Node script that hits the running
server. Blocks are grouped by feature (BLOCK 1..8.x). Add a new block
rather than extending an existing one when adding coverage.

A successful run prints `PASS N  FAIL 0` and exits 0.

CI uses `LLM_PROVIDER=mock` (Sprint 7) so semantic-search tests don't
need real API keys. If you add a feature that calls an external service,
provide a mock so the suite stays hermetic.

## Pull requests

- Open against `main`.
- One feature or fix per PR. Keep them small enough to review.
- The PR description should state: what changed, why, how you tested,
  any migration steps, and any backward-compat notes.
- Tests must pass in CI. The Actions workflow runs on every push and PR.
- Squash-merge is fine; the PR title becomes the commit subject.

## Release

Maintainers tag releases on `main` (`v0.x.0`). The README's screenshot
should be re-captured if there were visible dashboard changes.

## Code of conduct

Be kind. Disagree on substance, not on people. The maintainers will
remove anything that crosses into harassment or personal attacks.
