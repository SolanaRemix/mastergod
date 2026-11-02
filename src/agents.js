const definitions = [
  ["product-discovery", "Product Discovery Agent", "local"],
  ["beginner-explanation", "Beginner Explanation Agent", "local"],
  ["systems-architect", "Systems Architect Agent", "provider"],
  ["ux-research", "UX Research Agent", "provider"],
  ["ui-generator", "UI Generator Agent", "provider"],
  ["asset-generator", "Asset Generator Agent", "provider"],
  ["frontend-engineer", "Frontend Engineer Agent", "provider"],
  ["backend-engineer", "Backend Engineer Agent", "provider"],
  ["database-engineer", "Database Engineer Agent", "provider"],
  ["authentication", "Authentication Agent", "provider"],
  ["integration", "Integration Agent", "provider"],
  ["model-router", "AI Model Router Agent", "provider"],
  ["workflow-automation", "Workflow Automation Agent", "provider"],
  ["testing", "Testing Agent", "provider"],
  ["security", "Security Agent", "provider"],
  ["performance", "Performance Agent", "provider"],
  ["accessibility", "Accessibility Agent", "provider"],
  ["documentation", "Documentation Agent", "provider"],
  ["deployment", "Deployment Agent", "provider"],
  ["qa-critic", "QA Critic Agent", "provider"],
  ["release-manager", "Release Manager Agent", "provider"]
];

const profiles = {
  "product-discovery": ["product-discovery"],
  "beginner-explanation": ["beginner-explanation"],
  "systems-architect": ["system-architecture"],
  "ux-research": ["user-experience"],
  "ui-generator": ["frontend-development"],
  "asset-generator": ["asset-requirements"],
  "frontend-engineer": ["frontend-development"],
  "backend-engineer": ["backend-development"],
  "database-engineer": ["data-modeling"],
  authentication: ["authentication-design"],
  integration: ["external-integrations"],
  "model-router": ["model-routing"],
  "workflow-automation": ["workflow-automation"],
  testing: ["test-engineering"],
  security: ["security-review"],
  performance: ["performance-review"],
  accessibility: ["accessibility-review"],
  documentation: ["documentation"],
  deployment: ["deployment"],
  "qa-critic": ["independent-review"],
  "release-manager": ["release-management"]
};

const agents = Object.freeze(definitions.map(([id, name, execution]) => Object.freeze({
  id,
  name,
  version: "1.0.0",
  description: `${name} capability definition.`,
  capabilities: profiles[id],
  domains: ["*"],
  supportedFrameworks: [],
  supportedLanguages: [],
  availableTools: execution === "local" ? ["requirement-parser", "blueprint-writer"] : [],
  providerRequirements: execution === "local" ? [] : ["configured-provider"],
  securityPermissions: [],
  dependencies: [],
  performanceHistory: [],
  evaluationScore: null,
  availability: "catalog-only",
  deploymentStatus: "not-deployed",
  costLimit: null,
  executionLimit: null,
  inputSchema: {
    projectId: "string",
    requirementIds: "string[]",
    blueprintVersion: "string"
  },
  outputSchema: {
    status: "VERIFIED | IMPLEMENTED_UNVERIFIED | BLOCKED | FAILED",
    artifactReferences: "string[]",
    evidence: "string[]",
    failureReason: "string | null"
  },
  execution,
  inputContract: {
    projectId: "string",
    requirementIds: "string[]",
    blueprintVersion: "string"
  },
  outputContract: {
    status: "VERIFIED | IMPLEMENTED_UNVERIFIED | BLOCKED | FAILED",
    artifactReferences: "string[]",
    evidence: "string[]",
    failureReason: "string | null"
  },
  allowedTools: execution === "local" ? ["requirement-parser", "blueprint-writer"] : [],
  securityConstraints: [
    "Never claim an external operation succeeded without evidence.",
    "Never expose or invent credentials."
  ]
})));

const byId = new Map(agents.map((agent) => [agent.id, agent]));

function getAgent(id) {
  return byId.get(id);
}

module.exports = { agents, getAgent };
