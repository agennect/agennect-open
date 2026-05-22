import '../src/load-env.js';

const BASE = process.env.REGISTRY_URL || 'http://localhost:3000';
const TOKEN = process.env.ADMIN_TOKEN || 'change-me-before-deploy';

const agents = [
  {
    name: "DataOracle",
    description: "Specialized agent for exploratory data analysis, automated reporting, and insight generation. Compatible with Snowflake, BigQuery, and Redshift. Follows CRISP-DM methodology.",
    provider: "Agennect",
    protocols: ["A2A", "MCP"],
    hosting: "referenced",
    auth_type: "none",
    capabilities: ["EDA", "SQL", "BigQuery", "Snowflake", "CRISP-DM", "Visualization"],
    tags: ["data", "analytics"]
  },
  {
    name: "GovernanceGuard",
    description: "Data governance agent aligned with DAMA framework. Audits data pipelines for lineage violations, classifies PII, enforces RBAC policies, and generates compliance reports.",
    provider: "Agennect",
    protocols: ["A2A"],
    hosting: "referenced",
    auth_type: "none",
    capabilities: ["DAMA", "PII", "Lineage", "RBAC", "Compliance", "Audit"],
    tags: ["governance", "compliance"]
  },
  {
    name: "PipelineBot",
    description: "ELT pipeline builder and monitor. Generates dbt models, validates transformations, detects data anomalies, and alerts on pipeline failures across modern data stacks.",
    provider: "Agennect",
    protocols: ["A2A", "REST"],
    hosting: "referenced",
    auth_type: "none",
    capabilities: ["dbt", "ELT", "Monitoring", "Anomaly Detection", "Airflow"],
    tags: ["pipelines", "data-engineering"]
  },
  {
    name: "Agennect Connect",
    description: "Onboarding agent that helps developers list and validate their agents in the registry. Conducts structured interviews, validates A2A compatibility, and generates Agent Cards.",
    provider: "Agennect",
    protocols: ["A2A"],
    hosting: "hosted",
    auth_type: "none",
    capabilities: ["Onboarding", "Validation", "A2A", "Registry", "Agent Cards"],
    tags: ["meta", "onboarding"]
  }
];

const mcpServers = [
  {
    name: "Snowflake MCP",
    description: "Query, transform, and administer Snowflake directly from any compatible agent. Supports SQL execution, schema inspection, and warehouse management.",
    transport: "http",
    category: "data",
    author: "Snowflake Inc.",
    tools: [
      { name: "execute_query", description: "Execute a SQL query against Snowflake" },
      { name: "list_tables", description: "List tables in a schema" },
      { name: "describe_table", description: "Get schema for a specific table" }
    ]
  },
  {
    name: "GitHub MCP",
    description: "Create PRs, review code, manage issues, and interact with repositories from your agents.",
    transport: "http",
    category: "devtools",
    author: "GitHub",
    tools: [
      { name: "create_issue", description: "Create a GitHub issue" },
      { name: "create_pr", description: "Open a pull request" },
      { name: "list_repos", description: "List repositories for a user or org" }
    ]
  },
  {
    name: "BigQuery MCP",
    description: "Execute analytical queries in BigQuery with GCP authentication. Supports large dataset operations and ML model inference.",
    transport: "http",
    category: "data",
    author: "Google",
    tools: [
      { name: "run_query", description: "Run a BigQuery SQL query" },
      { name: "list_datasets", description: "List available datasets" }
    ]
  },
  {
    name: "Slack MCP",
    description: "Send messages, read channels, react to events, and manage Slack workspaces in real time.",
    transport: "sse",
    category: "communication",
    author: "Slack",
    tools: [
      { name: "send_message", description: "Send a message to a channel" },
      { name: "list_channels", description: "List available channels" }
    ]
  },
  {
    name: "PostgreSQL MCP",
    description: "Direct parameterized queries to PostgreSQL. Safe, schema-aware, supports transactions.",
    transport: "stdio",
    category: "data",
    author: "Community",
    tools: [
      { name: "query", description: "Execute a parameterized SQL query" },
      { name: "describe", description: "Describe a table schema" }
    ]
  },
  {
    name: "Brave Search MCP",
    description: "Real-time web search without tracking. Ideal for research agents needing current information.",
    transport: "http",
    category: "search",
    author: "Brave",
    tools: [
      { name: "search", description: "Search the web for a query" },
      { name: "news", description: "Get recent news articles" }
    ]
  }
];

async function postJson(path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } catch (e) {
    console.error(`POST ${path} failed:`, e.message);
    throw e;
  }
}

async function waitForServer() {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) return true;
    } catch (e) { /* keep waiting */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  console.log(`Seeding registry at ${BASE}`);

  const reachable = await waitForServer();
  if (!reachable) {
    console.error(`Server not reachable at ${BASE}. Start it first: npm start`);
    process.exit(1);
  }

  let agentOk = 0, agentFail = 0;
  for (const a of agents) {
    try {
      const out = await postJson('/agents', a);
      console.log(`  ✓ agent: ${a.name} → ${out.id}`);
      agentOk++;
    } catch (e) {
      console.error(`  ✗ agent: ${a.name} — ${e.message}`);
      agentFail++;
    }
  }

  let mcpOk = 0, mcpFail = 0;
  for (const s of mcpServers) {
    try {
      const out = await postJson('/mcp', s);
      console.log(`  ✓ mcp: ${s.name} → ${out.id}`);
      mcpOk++;
    } catch (e) {
      console.error(`  ✗ mcp: ${s.name} — ${e.message}`);
      mcpFail++;
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Agents: ${agentOk} ok, ${agentFail} failed`);
  console.log(`  MCP:    ${mcpOk} ok, ${mcpFail} failed`);

  if (agentFail || mcpFail) process.exit(1);
}

main().catch(e => {
  console.error('Seed failed:', e.message);
  process.exit(1);
});
