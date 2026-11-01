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

const agents = Object.freeze(definitions.map(([id, name, execution]) => Object.freeze({
  id,
  name,
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
