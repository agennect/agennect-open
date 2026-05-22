# agennect-open

Self-hosted A2A (Agent-to-Agent) registry with an MCP (Model Context Protocol)
server directory. Runs as a single Docker container, persists to SQLite,
and ships a vanilla HTML dashboard.

This is the open-source core of [Agennect](https://agennect.com). Use it to
publish, discover, and proxy agents that speak Google's A2A protocol, and to
maintain a directory of MCP servers your agents can call.

---

## Features

- **A2A registry** — every agent gets a `.well-known/agent.json` Agent Card.
- **MCP directory** — list and discover Model Context Protocol servers.
- **Semantic search** — vector search over agent name, description,
  and capabilities using `sqlite-vec`.
- **A2A proxy** — `POST /agents/:id/tasks` forwards to the agent's REST
  endpoint, logging every invocation.
- **Background health checks** — periodic GET pings to each agent's
  endpoint; status auto-flips between `active`, `degraded`, `inactive`.
- **KPI metrics** — registry-wide and per-agent counters at `/metrics`.
- **Pluggable embeddings** — Anthropic/Voyage, OpenAI, or Ollama.
- **Zero external services** — one container, one SQLite file, no Redis,
  no Postgres, no Cloudflare.

---

## Quick start

```bash
cp .env.example .env       # then edit ANTHROPIC_API_KEY and ADMIN_TOKEN
docker compose up --build
# in another terminal, seed sample data:
ADMIN_TOKEN=$(grep ADMIN_TOKEN .env | cut -d= -f2) node scripts/seed.js
open http://localhost:3000/dashboard
```

Without Docker:

```bash
npm install
cp .env.example .env
npm start
npm run seed
```

---

## Configuration

All settings come from environment variables (see `.env.example`).

| Variable                | Default                         | Description                                                                                       |
|-------------------------|---------------------------------|---------------------------------------------------------------------------------------------------|
| `PORT`                  | `3000`                          | Port the HTTP server listens on.                                                                  |
| `HOST`                  | `0.0.0.0`                       | Bind address.                                                                                     |
| `REGISTRY_NAME`         | `My Agent Registry`             | Display name shown in `/metrics` and the dashboard.                                               |
| `REGISTRY_URL`          | `http://localhost:3000`         | Public URL used in generated Agent Cards.                                                         |
| `DB_PATH`               | `./data/registry.db`            | SQLite path. Mount this volume in Docker.                                                         |
| `LLM_PROVIDER`          | `anthropic`                     | Embedding provider: `anthropic` (Voyage), `openai`, or `ollama`.                                  |
| `EMBEDDING_MODEL`       | `voyage-3`                      | Provider-specific embedding model.                                                                |
| `EMBEDDING_DIMS`        | `1024`                          | Must match the model: voyage-3 → 1024, text-embedding-3-small → 1536, nomic-embed-text → 768.    |
| `ANTHROPIC_API_KEY`     | —                               | Required when `LLM_PROVIDER=anthropic`. Used for the Voyage embeddings endpoint.                  |
| `OPENAI_API_KEY`        | —                               | Required when `LLM_PROVIDER=openai`.                                                              |
| `OLLAMA_URL`            | `http://localhost:11434`        | Required when `LLM_PROVIDER=ollama`.                                                              |
| `ADMIN_TOKEN`           | `change-me-before-deploy`       | Bearer token required for POST/PUT/DELETE. Change it.                                             |
| `HEALTH_CHECK_INTERVAL` | `300000`                        | Health check loop interval in ms.                                                                 |

---

## API reference

### Public

| Method | Path                                     | Description                                  |
|--------|------------------------------------------|----------------------------------------------|
| GET    | `/health`                                | Liveness probe.                              |
| GET    | `/metrics`                               | Global registry KPIs.                        |
| GET    | `/metrics/agents/:id`                    | Per-agent KPIs.                              |
| GET    | `/agents`                                | List agents. Query: `status`, `protocol`, `hosting`, `page`, `limit`. |
| GET    | `/agents/search?q=`                      | Semantic search by natural language.         |
| GET    | `/agents/:id`                            | Agent detail with capabilities.              |
| GET    | `/agents/:id/.well-known/agent.json`     | A2A Agent Card (schema v0.2).                |
| GET    | `/agents/:id/health`                     | Health checks for the last 24h.              |
| POST   | `/agents/:id/tasks`                      | A2A task entry point. Logged as invocation.  |
| GET    | `/mcp`                                   | List MCP servers. Query: `category`, `transport`. |
| GET    | `/mcp/:id`                               | MCP server detail with tools.                |

### Admin (require `Authorization: Bearer $ADMIN_TOKEN`)

| Method | Path                  | Description                                  |
|--------|-----------------------|----------------------------------------------|
| POST   | `/agents`             | Register an agent. Generates embedding + card. |
| PUT    | `/agents/:id`         | Update agent. Re-embeds if name/description/capabilities change. |
| DELETE | `/agents/:id`         | Soft-delete (`status=inactive`).             |
| POST   | `/mcp`                | Register an MCP server.                      |
| DELETE | `/mcp/:id`            | Soft-delete an MCP server.                   |

### A2A invocation

The caller may pass `X-Agent-Auth: <value>` to forward an API key or OAuth
token to the upstream agent endpoint. The registry never persists this value.

```bash
curl -X POST http://localhost:3000/agents/dataoracle-ab/tasks \
  -H "Content-Type: application/json" \
  -H "X-Agent-Auth: $UPSTREAM_KEY" \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"summarize Q4 sales"}]}}'
```

---

## A2A protocol

Agent Cards conform to the Google A2A spec (`schema_version: 0.2`). Each card
exposes the agent's id, capabilities, authentication scheme, supported
input/output modes, and the task URL on this registry:

- Spec: <https://github.com/google/A2A>
- Card: `GET /agents/:id/.well-known/agent.json`

The registry acts as an A2A endpoint for every agent it knows about. Cards
point at this registry's URL — callers don't need to know the underlying
endpoint or auth requirements. Auth is forwarded per-request via `X-Agent-Auth`.

---

## MCP directory

The MCP directory is a catalog of Model Context Protocol servers your agents
can connect to. The registry does not host MCP servers — it lists them, with
their transport (stdio/http/sse), config URL, tool schema, and author.

- MCP spec: <https://modelcontextprotocol.io>
- Browse: `GET /mcp`
- Detail: `GET /mcp/:id` returns the full tools array.

---

## Self-hosted vs Agennect Cloud

| Feature                          | agennect-open (this repo) | Agennect Cloud         |
|----------------------------------|---------------------------|------------------------|
| A2A registry + Agent Cards       | ✓                         | ✓                      |
| MCP directory                    | ✓                         | ✓                      |
| Semantic search                  | ✓ (sqlite-vec)            | ✓ (managed vectors)    |
| Health checks                    | ✓                         | ✓                      |
| Single-container deploy          | ✓                         | —                      |
| Managed hosting                  | —                         | ✓                      |
| Multi-tenant orgs & RBAC         | —                         | ✓                      |
| Evals / quality scoring          | —                         | ✓                      |
| SSO                              | —                         | ✓                      |
| Hosted agents (no infra of yours) | —                        | ✓                      |
| Source available                 | MIT (this repo)           | proprietary            |

If you need single-org self-hosting on commodity infra, use this repo. If you
need multi-tenant, hosted, or evaluation features, use the cloud.

---

## Contributing

- File issues and PRs at <https://github.com/agennect/agennect-open>.
- To run the integration tests:
  ```bash
  npm start &      # in one terminal
  npm test         # in another
  ```
- To submit a new agent for the public catalog at agennect.com, open a PR with
  your agent's metadata in `seed.js`-format, or use the Agennect Connect
  onboarding agent.

---

## License

MIT — see `LICENSE`.
