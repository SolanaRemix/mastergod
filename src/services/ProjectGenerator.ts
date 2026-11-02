declare const require: (id: string) => any;
declare const module: { exports: unknown };

type Requirement = { id: string; text: string; decision: string };
type BlueprintProject = {
  id: string;
  title: string;
  ownerId: string;
  status: string;
  originalRequest: string;
  requirements: Requirement[];
  blueprint: Record<string, any>;
};

type GeneratorStore = {
  get(projectId: string): Promise<BlueprintProject | null>;
  createAgentTasks(projectId: string, ownerId: string, tasks: any[]): Promise<any[] | null>;
};

type Orchestrator = {
  persistGraph(projectId: string, ownerId: string, tasks: any[], execution?: Record<string, unknown>): Promise<any[] | null>;
};

const { createHash } = require("node:crypto");
const { featureListForProject } = require("../artifacts");
const { agents, getAgent } = require("../agents");
const { AgentCapabilityRegistry } = require("../capability-registry");

function assertBlueprint(project: BlueprintProject, projectId: string, ownerId: string): Requirement[] {
  if (!project || project.id !== projectId || project.ownerId !== ownerId) {
    throw Object.assign(new Error("Project not found."), { status: 404 });
  }
  if (project.status !== "APPROVED_PLAN" || !project.blueprint || typeof project.blueprint !== "object") {
    throw Object.assign(new Error("Approve project requirements before creating agent tasks."), {
      status: 409,
      code: "PROJECT_NOT_APPROVED"
    });
  }
  const blueprint = project.blueprint;
  if (blueprint.project?.id !== project.id
    || blueprint.project?.name !== project.title
    || typeof blueprint.blueprintVersion !== "string"
    || !Array.isArray(blueprint.requirements)
    || !Array.isArray(project.requirements)) {
    throw Object.assign(new Error("The project blueprint is incomplete or does not match its saved project."), {
      status: 422,
      code: "INVALID_BLUEPRINT"
    });
  }
  const approved = project.requirements.filter((requirement) => requirement.decision === "APPROVED");
  if (!approved.length || approved.length > 200) {
    throw Object.assign(new Error("The blueprint must contain between 1 and 200 approved requirements."), {
      status: 422,
      code: "INVALID_BLUEPRINT"
    });
  }
  const byId = new Map(approved.map((requirement) => [requirement.id, requirement]));
  const seen = new Set<string>();
  const requirements = blueprint.requirements.map((requirement: any) => {
    if (!requirement || typeof requirement.id !== "string" || typeof requirement.text !== "string"
      || !requirement.text.trim() || requirement.text.length > 2000
      || seen.has(requirement.id) || !byId.has(requirement.id)
      || byId.get(requirement.id)?.text !== requirement.text) {
      throw Object.assign(new Error("Blueprint requirements must exactly match the approved project requirements."), {
        status: 422,
        code: "INVALID_BLUEPRINT"
      });
    }
    seen.add(requirement.id);
    return { id: requirement.id, text: requirement.text };
  });
  if (requirements.length !== approved.length || requirements.reduce((size, item) => size + item.text.length, 0) > 100_000) {
    throw Object.assign(new Error("Blueprint requirements are incomplete or exceed the supported size."), {
      status: 422,
      code: "INVALID_BLUEPRINT"
    });
  }
  return requirements;
}

function projectTypeFor(project: BlueprintProject): string {
  const features = new Set(featureListForProject(project).map((feature: { slug: string }) => feature.slug));
  const text = project.requirements
    .filter((requirement) => requirement.decision === "APPROVED")
    .map((requirement) => requirement.text)
    .join(" ");
  if (features.has("gameplay") || features.has("levels") || /\bgame\b/i.test(text)) return "game";
  if (features.has("vehicles") || features.has("dispatch") || features.has("loads") || features.has("drivers")) return "fleet";
  if (/\b(e-?commerce|online store|shopping cart|checkout)\b/i.test(text)) return "ecommerce";
  if (features.has("bookings")) return "booking";
  if (features.has("chat")) return "conversational";
  return "general";
}

function taskDefinitions(projectType: string, hasAuth: boolean, hasIntegrations: boolean, hasAssets: boolean, requestText = "") {
  const tasks = [
    { key: "architecture", title: "Architecture and technical blueprint", agentId: "systems-architect", capability: "system-architecture", dependencies: [] },
    { key: "ux", title: "User journeys and accessible UX", agentId: "ux-research", capability: "user-experience", dependencies: [] },
    { key: "database", title: "Data model and persistence design", agentId: "database-engineer", capability: "data-modeling", dependencies: ["architecture"] }
  ];
  if (hasAuth) tasks.push({
    key: "authentication",
    title: "Roles, identity, and permissions design",
    agentId: "authentication",
    capability: "authentication-design",
    dependencies: ["architecture", "database"]
  });
  const domainAgent = projectType === "conversational" ? "model-router" : "backend-engineer";
  const includeIntegrations = hasIntegrations || projectType === "ecommerce" || projectType === "booking";
  tasks.push({
    key: "domain",
    title: projectType === "fleet"
      ? "Fleet, driver, and load workflows"
      : projectType === "booking"
        ? "Booking and scheduling workflows"
        : projectType === "ecommerce"
          ? "Catalog, checkout, and order workflows"
          : projectType === "game"
            ? "Game rules and player progression"
            : projectType === "conversational"
              ? "Conversation and model-routing design"
              : "Core application workflows",
    agentId: domainAgent,
    capability: projectType === "conversational" ? "model-routing" : "backend-development",
    dependencies: ["architecture", "database"]
  });
  tasks.push({
    key: "ui",
    title: "Page and component design",
    agentId: "ui-generator",
    capability: "ui-generation",
    dependencies: ["architecture", "ux"]
  });
  tasks.push({
    key: "frontend",
    title: projectType === "game" ? "Game interface and controls" : "Interactive frontend implementation",
    agentId: "frontend-engineer",
    capability: "frontend-development",
    dependencies: ["domain", "ui"]
  });
  if (hasAssets || projectType === "game") tasks.push({
    key: "assets",
    title: "Visual asset requirements and generation plan",
    agentId: "asset-generator",
    capability: "asset-requirements",
    dependencies: ["ux"]
  });
  if (includeIntegrations) tasks.push({
    key: "integrations",
    title: projectType === "ecommerce" ? "Payment and commerce integrations" : "External service integration plan",
    agentId: "integration",
    capability: "external-integrations",
    dependencies: ["domain"]
  });
  if (/\b(automations?|automate|workflows?|triggers?|schedulers?)\b/i.test(requestText)) {
    tasks.push({
      key: "workflow",
      title: "Workflow triggers, actions, and recovery design",
      agentId: "workflow-automation",
      capability: "workflow-automation",
      dependencies: ["architecture", "database"]
    });
  }
  if (/\b(models?|providers?|LLMs?|AI|artificial intelligence|RAG|agents?)\b/i.test(requestText)
    && projectType !== "conversational") {
    tasks.push({
      key: "model-routing",
      title: "AI model capabilities and routing design",
      agentId: "model-router",
      capability: "model-routing",
      dependencies: ["architecture"]
    });
  }
  tasks.push(
    {
      key: "testing",
      title: "Automated acceptance and integration tests",
      agentId: "testing",
      capability: "test-engineering",
      dependencies: ["domain", "frontend", ...(includeIntegrations ? ["integrations"] : []), ...(tasks.some((task) => task.key === "workflow") ? ["workflow"] : [])]
    },
    { key: "security", title: "Security and authorization review", agentId: "security", capability: "security-review", dependencies: ["testing", ...(hasAuth ? ["authentication"] : [])] },
    { key: "accessibility", title: "Keyboard, screen-reader, and responsive verification", agentId: "accessibility", capability: "accessibility-review", dependencies: ["frontend"] },
    { key: "documentation", title: "User and operator documentation", agentId: "documentation", capability: "documentation", dependencies: ["testing"] },
    {
      key: "release",
      title: "Release readiness and deployment checks",
      agentId: "release-manager",
      capability: "release-management",
      dependencies: ["security", "accessibility", "documentation"]
    }
  );
  return tasks;
}

class ProjectGenerator {
  store: GeneratorStore;
  orchestrator: Orchestrator;
  registry: any;

  constructor(store: GeneratorStore, orchestrator: Orchestrator, registry = new AgentCapabilityRegistry(agents)) {
    this.store = store;
    this.orchestrator = orchestrator;
    this.registry = registry;
  }

  async generate(projectId: string, ownerId: string): Promise<Record<string, unknown> | null> {
    const project = await this.store.get(projectId);
    if (!project || project.ownerId !== ownerId) return null;
    const requirements = assertBlueprint(project, projectId, ownerId);
    const blueprint = project.blueprint;
    const projectType = projectTypeFor(project);
    const text = requirements.map((requirement) => requirement.text).join(" ");
    const features = featureListForProject(project);
    const hasAuth = /\b(users?|drivers?|accounts?|login|sign.?in|permissions?|roles?)\b/i.test(text);
    const hasIntegrations = (Array.isArray(blueprint.integrations) && blueprint.integrations.length > 0)
      || /\b(integrat|external service|API|calendar|payment|email)\b/i.test(text);
    const hasAssets = features.some((feature: { slug: string }) => feature.slug === "assets")
      || /\b(images?|illustrations?|audio|music|sprites?)\b/i.test(text);
    const generationPayload = JSON.stringify({
      projectId,
      blueprintVersion: blueprint.blueprintVersion,
      projectType,
      requirements
    });
    const generationId = createHash("sha256").update(generationPayload).digest("hex").slice(0, 20);
    const capabilityPlan = this.registry.discover(requirements, projectType);
    const definitions = taskDefinitions(projectType, hasAuth, hasIntegrations, hasAssets, text) as any[];
    const assignedCapabilities = new Set(definitions.map((definition) => definition.capability));
    for (const assignment of capabilityPlan.assignments) {
      if (assignedCapabilities.has(assignment.capability)) continue;
      assignedCapabilities.add(assignment.capability);
      definitions.push({
        key: `cap-${assignment.capability.replace(/[^a-z0-9-]/gi, "-").slice(0, 60)}`,
        title: `${assignment.agentName}: ${assignment.capability} requirements`,
        agentId: assignment.agentId,
        capability: assignment.capability,
        dependencies: ["architecture", "database"]
      });
    }
    const ids = new Map(definitions.map((task) => [task.key, `${generationId}-${task.key}`]));
    const tasks = definitions.map((definition) => {
      const assignment = capabilityPlan.assignments.find((candidate: any) => candidate.capability === definition.capability);
      const agent = (assignment && this.registry.get(assignment.agentId)) || getAgent(definition.agentId);
      if (!agent) throw new Error(`Unknown agent contract: ${definition.agentId}.`);
      return {
        taskId: ids.get(definition.key),
        projectId,
        ownerId,
        generationId,
        projectType,
        title: definition.title,
        agentId: agent.id,
        dependencies: definition.dependencies.map((key) => ids.get(key)),
        input: {
          projectId,
          projectType,
          title: project.title,
          originalRequest: project.originalRequest,
          blueprintVersion: blueprint.blueprintVersion,
          requirements,
          requirementIds: requirements.map((requirement) => requirement.id),
          capability: definition.capability,
          assignmentAvailability: assignment?.availability || agent.availability,
          relevantBlueprint: {
            roles: Array.isArray(blueprint.roles) ? blueprint.roles : [],
            pages: Array.isArray(blueprint.pages) ? blueprint.pages : [],
            dataEntities: Array.isArray(blueprint.dataEntities) ? blueprint.dataEntities : [],
            integrations: Array.isArray(blueprint.integrations) ? blueprint.integrations : []
          },
          outputContract: agent.outputContract || agent.outputSchema,
          securityConstraints: agent.securityConstraints || agent.securityPermissions || []
        },
        timeoutSeconds: 300,
        maxAttempts: 2,
        attempt: 0,
        status: "BLOCKED",
        blockedReason: null,
        error: null,
        result: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });
    const execution = {
      requestId: generationId,
      projectId,
      originalPrompt: project.originalRequest,
      requirements: requirements.map((requirement) => ({ id: requirement.id, text: requirement.text })),
      blueprintVersion: blueprint.blueprintVersion,
      selectedAgents: capabilityPlan.assignments,
      createdAgents: [],
      modelAssignments: [],
      taskGraph: tasks.map((task) => ({
        taskId: task.taskId,
        agentId: task.agentId,
        requirementIds: requirements.map((requirement) => requirement.id),
        dependencies: task.dependencies
      })),
      artifacts: [],
      approvals: [{ type: "blueprint", status: "APPROVED" }],
      testResults: [],
      capabilityGaps: capabilityPlan.capabilityGaps,
      status: capabilityPlan.capabilityGaps.length ? "blocked" : "executing"
    };
    const persisted = await this.orchestrator.persistGraph(projectId, ownerId, tasks, execution);
    if (!persisted) return null;
    return {
      status: "IMPLEMENTED_UNVERIFIED",
      projectType,
      generationId,
      selectedAgents: capabilityPlan.assignments,
      capabilityGaps: capabilityPlan.capabilityGaps,
      execution,
      taskCount: persisted.length,
      executionStatus: persisted.some((task) => task.status === "QUEUED")
        ? "QUEUED"
        : "BLOCKED",
      executionNote: persisted.some((task) => task.status === "QUEUED")
        ? "Tasks are queued for registered agent workers; completion requires executed work and evidence."
        : "Task graph is persisted, but no verified agent workers are registered. No project code was generated.",
      tasks: persisted
    };
  }
}

module.exports = { ProjectGenerator, assertBlueprint, projectTypeFor, taskDefinitions };
