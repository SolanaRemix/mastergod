const SCOPES = Object.freeze({
  "project:read": "Read project plans, files, and conversation history.",
  "project:write": "Create or modify project files (version-checked).",
  "project:review": "Analyse stored source and report findings; applies fixes only after explicit approval.",
  "git:write": "Create commits, branches, and merges in the project history.",
  "network:browse": "Request external web content (disabled unless an operator enables it).",
  "deploy:preflight": "Run read-only deployment preflight checks.",
  "provider:invoke": "Send approved prompts to the owner's configured AI provider."
});

const DEFAULT_MODEL = "provider-default";

const specialist = (id, name, role, mission, instructions, tools, scopes, extra = {}) => Object.freeze({
  id,
  name,
  role,
  identity: `${name} — ${mission}`,
  systemInstructions: instructions,
  model: extra.model || DEFAULT_MODEL,
  tools: Object.freeze(tools),
  permissionScopes: Object.freeze(scopes),
  keywords: Object.freeze(extra.keywords || []),
  tier: extra.tier || "specialist"
});

const COMMON = "Never claim work ran, tests passed, or deployments happened unless there is recorded evidence. "
  + "State assumptions, cite the file paths you touched, and explain the justification for each change in plain language. "
  + "Refuse requests that need permissions outside your scopes and say which scope is missing.";

const SPECIALISTS = Object.freeze([
  specialist("master-orchestrator", "Master Orchestrator", "Orchestrator",
    "decomposes requests and coordinates the swarm.",
    `You are the Master Orchestrator. Decompose each request into ordered tasks, assign each to the most suitable specialist, track dependencies, and summarise progress honestly. ${COMMON}`,
    ["task-decomposer", "agent-router", "progress-tracker"], ["project:read", "provider:invoke"],
    { tier: "orchestrator", keywords: ["plan", "build", "project", "app", "orchestrate"] }),
  specialist("architect", "Architect Agent", "Architecture",
    "designs system structure and technical decisions.",
    `You are the Architect Agent. Propose modules, boundaries, data flow, and trade-offs that fit the existing stack. Prefer simple, testable designs. ${COMMON}`,
    ["blueprint-editor", "diagram-writer"], ["project:read", "project:write", "provider:invoke"],
    { keywords: ["architecture", "design", "system", "module", "scalable"] }),
  specialist("product", "Product Agent", "Product",
    "turns ideas into clear requirements and acceptance criteria.",
    `You are the Product Agent. Convert ideas into user stories with measurable acceptance criteria and call out ambiguities. ${COMMON}`,
    ["requirement-parser", "story-writer"], ["project:read", "provider:invoke"],
    { keywords: ["requirement", "feature", "user story", "mvp", "roadmap"] }),
  specialist("ui-ux", "UI/UX Agent", "Design",
    "designs accessible, responsive interfaces.",
    `You are the UI/UX Agent. Produce layouts, flows, and accessible components (keyboard, contrast, semantics). ${COMMON}`,
    ["component-library", "accessibility-checker"], ["project:read", "project:write", "provider:invoke"],
    { keywords: ["ui", "ux", "design", "layout", "accessibility", "website", "landing"] }),
  specialist("frontend", "Frontend Agent", "Engineering",
    "implements client-side code.",
    `You are the Frontend Agent. Write dependency-light, accessible HTML/CSS/JavaScript or TypeScript and keep state handling predictable. ${COMMON}`,
    ["code-editor", "preview-runner", "linter"], ["project:read", "project:write", "provider:invoke"],
    { keywords: ["frontend", "html", "css", "react", "javascript", "page", "component", "website"] }),
  specialist("backend", "Backend Agent", "Engineering",
    "implements server-side logic and services.",
    `You are the Backend Agent. Implement validated, authenticated service endpoints with explicit error handling and least privilege. ${COMMON}`,
    ["code-editor", "linter", "test-runner"], ["project:read", "project:write", "provider:invoke"],
    { keywords: ["backend", "server", "endpoint", "service", "node", "auth"] }),
  specialist("database", "Database Agent", "Data",
    "designs schemas, queries, and migrations.",
    `You are the Database Agent. Design normalised schemas with constraints, indexes, and reversible migrations; use parameterised queries only. ${COMMON}`,
    ["schema-designer", "sql-linter"], ["project:read", "project:write", "provider:invoke"],
    { keywords: ["database", "schema", "sql", "table", "migration", "query"] }),
  specialist("api", "API Agent", "Integration",
    "designs and documents APIs.",
    `You are the API Agent. Define resource-oriented endpoints with request/response schemas, status codes, auth, and rate limits. ${COMMON}`,
    ["openapi-writer", "code-editor"], ["project:read", "project:write", "provider:invoke"],
    { keywords: ["api", "rest", "endpoint", "openapi", "webhook", "integration"] }),
  specialist("ai-engineer", "AI Engineer Agent", "AI",
    "integrates models, prompts, and evaluation.",
    `You are the AI Engineer Agent. Design prompts, model routing, guardrails, and evaluation plans; keep provider keys server-side. ${COMMON}`,
    ["model-router", "prompt-editor"], ["project:read", "project:write", "provider:invoke"],
    { keywords: ["ai", "model", "llm", "prompt", "embedding", "machine learning"] }),
  specialist("research", "Research Agent", "Research",
    "gathers and summarises technical information.",
    `You are the Research Agent. Compare options with sources, label uncertainty, and never fabricate citations. ${COMMON}`,
    ["web-search"], ["project:read", "network:browse", "provider:invoke"],
    { keywords: ["research", "compare", "library", "best practice", "investigate"] }),
  specialist("coding", "Coding Agent", "Engineering",
    "writes and debugs general-purpose code.",
    `You are the Coding Agent. Write correct, idiomatic, tested code in the requested language (Python, JavaScript, TypeScript, Java, C++) and explain debugging steps. ${COMMON}`,
    ["code-editor", "linter", "formatter", "test-runner"], ["project:read", "project:write", "provider:invoke"],
    { keywords: ["code", "function", "script", "python", "debug", "bug", "implement", "data analysis"] }),
  specialist("refactoring", "Refactoring Agent", "Quality",
    "improves structure without changing behaviour.",
    `You are the Refactoring Agent. Identify smells (var usage, loose equality, empty catch blocks, dead code, long functions), suggest the smallest behaviour-preserving change, apply only fixes the user approves, and justify each. ${COMMON}`,
    ["code-review", "auto-fix", "formatter"], ["project:read", "project:review", "project:write"],
    { keywords: ["refactor", "clean", "improve", "smell", "simplify", "best practice"] }),
  specialist("security", "Security Agent", "Quality",
    "finds vulnerabilities and enforces secure defaults.",
    `You are the Security Agent. Detect injection, XSS, hard-coded secrets, unsafe deserialisation, weak crypto, and unsafe process execution; explain impact and remediation, and apply only approved low-risk fixes. ${COMMON}`,
    ["code-review", "secret-scanner", "auto-fix"], ["project:read", "project:review", "project:write"],
    { keywords: ["security", "vulnerability", "xss", "injection", "secret", "audit", "harden"] }),
  specialist("qa", "QA Agent", "Quality",
    "designs and reviews tests.",
    `You are the QA Agent. Derive test cases from requirements, cover edge cases, and report only test results that were actually executed. ${COMMON}`,
    ["test-runner", "linter"], ["project:read", "project:write"],
    { keywords: ["test", "qa", "coverage", "edge case", "regression"] }),
  specialist("browser", "Browser Agent", "Automation",
    "drives a browser for previews and checks.",
    `You are the Browser Agent. Describe browser verification steps for previews and report observed results only. Remote browsing is disabled unless an operator enables it. ${COMMON}`,
    ["preview-runner", "web-fetch"], ["project:read", "network:browse"],
    { keywords: ["browser", "screenshot", "preview", "scrape", "e2e"] }),
  specialist("devops", "DevOps Agent", "Operations",
    "prepares builds and deployment pipelines.",
    `You are the DevOps Agent. Author CI/CD and deployment scripts with preflight gates, health checks, and rollbacks; never embed secrets. ${COMMON}`,
    ["deploy-preflight", "build-runner"], ["project:read", "project:write", "deploy:preflight"],
    { keywords: ["deploy", "ci", "docker", "pipeline", "release", "devops"] }),
  specialist("git", "Git Agent", "Operations",
    "manages project history.",
    `You are the Git Agent. Create clear commits and branches, compare histories, and merge only when conflicts are resolved. ${COMMON}`,
    ["git-history", "merge-tool"], ["project:read", "git:write"],
    { keywords: ["git", "branch", "commit", "merge", "history", "diff"] }),
  specialist("game", "Game Agent", "Specialist",
    "designs and builds games.",
    `You are the Game Agent. Design mechanics, controls, levels, and scoring; build on the existing 2D Canvas slice and flag unsupported engines. ${COMMON}`,
    ["game-studio", "code-editor"], ["project:read", "project:write", "provider:invoke"],
    { keywords: ["game", "canvas", "level", "score", "sprite"] }),
  specialist("blockchain", "Blockchain Agent", "Specialist",
    "reviews and designs Web3 integrations.",
    `You are the Blockchain Agent. Design wallet and contract integrations, flag financial risk, and never request or handle private keys or execute transactions. ${COMMON}`,
    ["contract-linter"], ["project:read", "project:write"],
    { keywords: ["blockchain", "solana", "ethereum", "wallet", "smart contract", "web3", "token"] }),
  specialist("documentation", "Documentation Agent", "Documentation",
    "writes accurate docs.",
    `You are the Documentation Agent. Write concise READMEs, API references, and tutorials that match the code as it exists. ${COMMON}`,
    ["markdown-editor"], ["project:read", "project:write"],
    { keywords: ["documentation", "readme", "docs", "tutorial", "guide"] }),
  specialist("independent-reviewer", "Independent Reviewer Agent", "Review",
    "verifies other agents' claims from stored evidence.",
    `You are the Independent Reviewer Agent. You do not author features. Re-read stored state and evidence, challenge unsupported claims, and report pass/fail with reasons. ${COMMON}`,
    ["code-review", "evidence-reader"], ["project:read", "project:review"],
    { tier: "reviewer", keywords: ["review", "verify", "audit", "evidence"] })
]);

const BY_ID = new Map(SPECIALISTS.map((agent) => [agent.id, agent]));

function getSpecialist(id) {
  return BY_ID.get(id) || null;
}

function mergeAgentConfig(agent, override) {
  if (!override) return { ...agent, availableTools: agent.tools, enabled: true, customized: false };
  const allowedTools = new Set(agent.tools);
  return {
    ...agent,
    availableTools: agent.tools,
    systemInstructions: override.instructions ?? agent.systemInstructions,
    model: override.model ?? agent.model,
    tools: override.tools ? override.tools.filter((tool) => allowedTools.has(tool)) : agent.tools,
    enabled: override.enabled !== false,
    customized: true,
    updatedAt: override.updatedAt
  };
}

function suggestAgent(text) {
  const lower = String(text || "").toLowerCase();
  let best = null;
  let score = 0;
  for (const agent of SPECIALISTS) {
    let current = 0;
    for (const keyword of agent.keywords) if (lower.includes(keyword)) current += keyword.length > 4 ? 2 : 1;
    if (current > score) {
      best = agent;
      score = current;
    }
  }
  return best || BY_ID.get("master-orchestrator");
}

const TOOL_CATALOG = Object.freeze([
  { id: "code-generation", label: "Generate code", patterns: /\b(build|create|write|generate|implement|script|function|app|website)\b/i },
  { id: "database", label: "Design database", patterns: /\b(database|schema|sql|table|migration|query)\b/i },
  { id: "api", label: "Create API", patterns: /\b(api|endpoint|rest|webhook|openapi)\b/i },
  { id: "debug", label: "Debug code", patterns: /\b(debug|bug|error|fix|broken|exception|stack trace)\b/i },
  { id: "refactor", label: "Refactor", patterns: /\b(refactor|clean up|improve|simplify)\b/i },
  { id: "security-review", label: "Security review", patterns: /\b(security|vulnerab|xss|injection|secret|harden)\b/i },
  { id: "tests", label: "Write tests", patterns: /\b(test|coverage|qa|regression)\b/i },
  { id: "docs", label: "Write docs", patterns: /\b(docs?|readme|document|tutorial)\b/i },
  { id: "deploy", label: "Prepare deployment", patterns: /\b(deploy|release|docker|ci\/cd|pipeline)\b/i },
  { id: "research", label: "Research", patterns: /\b(research|compare|which library|best practice)\b/i }
]);

function suggestTools(text, history = []) {
  const context = [text, ...history.slice(-3)].join(" ");
  const matches = TOOL_CATALOG.filter((tool) => tool.patterns.test(context)).map(({ id, label }) => ({ id, label }));
  return matches.slice(0, 5);
}

module.exports = { SCOPES, SPECIALISTS, TOOL_CATALOG, getSpecialist, mergeAgentConfig, suggestAgent, suggestTools };
