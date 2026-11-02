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
  persistGraph(projectId: string, ownerId: string, tasks: any[]): Promise<any[] | null>;
};

const { createHash } = require("node:crypto");
const { featureListForProject } = require("../artifacts");
const { getAgent } = require("../agents");

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

function taskDefinitions(projectType: string, hasAuth: boolean, hasIntegrations: boolean, hasAssets: boolean) {
  const tasks = [
    { key: "architecture", title: "Architecture and technical blueprint", agentId: "systems-architect", dependencies: [] },
    { key: "ux", title: "User journeys and accessible UX", agentId: "ux-research", dependencies: [] },
    { key: "database", title: "Data model and persistence design", agentId: "database-engineer", dependencies: ["architecture"] }
  ];
  if (hasAuth) tasks.push({
    key: "authentication",
    title: "Roles, identity, and permissions design",
    agentId: "authentication",
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
    dependencies: ["architecture", "database"]
  });
  tasks.push({
    key: "ui",
    title: "Page and component design",
    agentId: "ui-generator",
    dependencies: ["architecture", "ux"]
  });
  tasks.push({
    key: "frontend",
    title: projectType === "game" ? "Game interface and controls" : "Interactive frontend implementation",
    agentId: "frontend-engineer",
    dependencies: ["domain", "ui"]
  });
  if (hasAssets || projectType === "game") tasks.push({
    key: "assets",
    title: "Visual asset requirements and generation plan",
    agentId: "asset-generator",
    dependencies: ["ux"]
  });
  if (includeIntegrations) tasks.push({
    key: "integrations",
    title: projectType === "ecommerce" ? "Payment and commerce integrations" : "External service integration plan",
    agentId: "integration",
    dependencies: ["domain"]
  });
  tasks.push(
    {
      key: "testing",
      title: "Automated acceptance and integration tests",
      agentId: "testing",
      dependencies: ["domain", "frontend", ...(includeIntegrations ? ["integrations"] : [])]
    },
    { key: "security", title: "Security and authorization review", agentId: "security", dependencies: ["testing", ...(hasAuth ? ["authentication"] : [])] },
    { key: "accessibility", title: "Keyboard, screen-reader, and responsive verification", agentId: "accessibility", dependencies: ["frontend"] },
    { key: "documentation", title: "User and operator documentation", agentId: "documentation", dependencies: ["testing"] },
    {
      key: "release",
      title: "Release readiness and deployment checks",
      agentId: "release-manager",
      dependencies: ["security", "accessibility", "documentation"]
    }
  );
  return tasks;
}

class ProjectGenerator {
  store: GeneratorStore;
  orchestrator: Orchestrator;

  constructor(store: GeneratorStore, orchestrator: Orchestrator) {
    this.store = store;
    this.orchestrator = orchestrator;
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
    const definitions = taskDefinitions(projectType, hasAuth, hasIntegrations, hasAssets);
    const ids = new Map(definitions.map((task) => [task.key, `${generationId}-${task.key}`]));
    const tasks = definitions.map((definition) => {
      const agent = getAgent(definition.agentId);
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
          relevantBlueprint: {
            roles: Array.isArray(blueprint.roles) ? blueprint.roles : [],
            pages: Array.isArray(blueprint.pages) ? blueprint.pages : [],
            dataEntities: Array.isArray(blueprint.dataEntities) ? blueprint.dataEntities : [],
            integrations: Array.isArray(blueprint.integrations) ? blueprint.integrations : []
          },
          outputContract: agent.outputContract,
          securityConstraints: agent.securityConstraints
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
    const persisted = await this.orchestrator.persistGraph(projectId, ownerId, tasks);
    if (!persisted) return null;
    return {
      status: "IMPLEMENTED_UNVERIFIED",
      projectType,
      generationId,
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
