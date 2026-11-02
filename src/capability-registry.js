const CAPABILITY_RULES = [
  { capability: "authentication-design", pattern: /\b(users?|drivers?|accounts?|login|sign.?in|permissions?|roles?)\b/i },
  { capability: "model-routing", pattern: /\b(models?|providers?|LLMs?|AI|artificial intelligence|RAG|agents?)\b/i },
  { capability: "workflow-automation", pattern: /\b(automations?|automate|workflows?|triggers?|schedulers?)\b/i },
  { capability: "external-integrations", pattern: /\b(integrat|external service|API|calendar|payment|email|CRM)\b/i },
  { capability: "asset-requirements", pattern: /\b(images?|illustrations?|audio|music|sprites?|assets?)\b/i },
  { capability: "game-engineering", pattern: /\b(games?|gameplay|3D|racing|physics|levels?)\b/i },
  { capability: "blockchain-integration", pattern: /\b(blockchain|web3|Solana|Ethereum|wallets?|tokens?|DeFi|smart contracts?)\b/i },
  { capability: "swap-transactions", pattern: /\b(swaps?|trading|slippage|liquidity|transactions?)\b/i },
  { capability: "analytics-engineering", pattern: /\b(analytics|reports?|metrics|dashboards?)\b/i }
];

const BASE_CAPABILITIES = [
  "system-architecture",
  "user-experience",
  "data-modeling",
  "ui-generation",
  "backend-development",
  "frontend-development",
  "test-engineering",
  "security-review",
  "accessibility-review",
  "documentation"
];

function isCapabilityDescriptor(agent) {
  return agent
    && typeof agent.id === "string"
    && /^[a-z0-9][a-z0-9-]{1,63}$/.test(agent.id)
    && typeof agent.name === "string"
    && typeof agent.version === "string"
    && Array.isArray(agent.capabilities)
    && agent.capabilities.length > 0
    && agent.capabilities.every((capability) => typeof capability === "string")
    && Array.isArray(agent.keywords)
    && agent.keywords.every((keyword) => typeof keyword === "string" && keyword.trim().length >= 2)
    && Array.isArray(agent.domains)
    && Array.isArray(agent.supportedLanguages)
    && Array.isArray(agent.availableTools)
    && Array.isArray(agent.securityPermissions)
    && Array.isArray(agent.providerRequirements)
    && typeof agent.availability === "string"
    && typeof agent.deploymentStatus === "string";
}

class AgentCapabilityRegistry {
  constructor(agents = []) {
    this.agents = new Map();
    for (const agent of agents) this.register(agent);
  }

  register(agent) {
    if (!isCapabilityDescriptor(agent)) {
      throw new TypeError("Agent registration requires a complete capability descriptor.");
    }
    if (this.agents.has(agent.id)) {
      const error = new Error(`Agent ${agent.id} is already registered.`);
      error.code = "AGENT_ALREADY_REGISTERED";
      throw error;
    }
    this.agents.set(agent.id, structuredClone(agent));
    return structuredClone(agent);
  }

  list() {
    return [...this.agents.values()].map((agent) => structuredClone(agent));
  }

  get(agentId) {
    const agent = this.agents.get(agentId);
    return agent ? structuredClone(agent) : null;
  }

  findForCapability(capability, domain) {
    return [...this.agents.values()]
      .filter((agent) => agent.capabilities.includes(capability)
        && (agent.domains.includes("*") || agent.domains.includes(domain)))
      .sort((left, right) => {
        const leftAvailable = left.availability === "available" ? 1 : 0;
        const rightAvailable = right.availability === "available" ? 1 : 0;
        return rightAvailable - leftAvailable
          || (right.evaluationScore ?? -1) - (left.evaluationScore ?? -1)
          || left.id.localeCompare(right.id);
      })[0] || null;
  }

  discover(requirements, domain) {
    const requirementText = requirements.map((requirement) => requirement.text).join(" ");
    const matched = CAPABILITY_RULES
      .filter((rule) => rule.pattern.test(requirementText))
      .map(({ capability }) => capability);
    const customMatches = [...this.agents.values()]
      .filter((agent) => agent.keywords.some((keyword) => requirementText.toLowerCase().includes(keyword.toLowerCase())))
      .flatMap((agent) => agent.capabilities);
    const requestedCapabilities = [...new Set([...BASE_CAPABILITIES, ...matched, ...customMatches])];
    const assignments = [];
    const capabilityGaps = [];
    for (const capability of requestedCapabilities) {
      const agent = this.findForCapability(capability, domain);
      if (!agent) {
        capabilityGaps.push({
          capability,
          status: "BLOCKED",
          reason: "No registered agent capability currently covers this requirement."
        });
        continue;
      }
      assignments.push({
        agentId: agent.id,
        agentName: agent.name,
        capability,
        availability: agent.availability,
        deploymentStatus: agent.deploymentStatus,
        providerRequirements: agent.providerRequirements
      });
      if (agent.availability !== "available" || agent.deploymentStatus !== "deployed") {
        capabilityGaps.push({
          capability,
          agentId: agent.id,
          status: "BLOCKED",
          reason: "The capability is catalogued, but no deployed executable worker is available."
        });
      }
    }
    return { requestedCapabilities, assignments, capabilityGaps };
  }
}

module.exports = {
  AgentCapabilityRegistry,
  BASE_CAPABILITIES,
  CAPABILITY_RULES,
  isCapabilityDescriptor
};
