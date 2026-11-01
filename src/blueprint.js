const { randomUUID } = require("node:crypto");
const { getAgent } = require("./agents");

function cleanRequirementText(text) {
  return text.replace(/\s+/g, " ").trim().replace(/^[\s-*•]+/, "");
}

function discoverRequirements(originalRequest) {
  const sentences = originalRequest
    .split(/(?:\r?\n+|(?<=[.!?])\s+)/u)
    .map(cleanRequirementText)
    .filter(Boolean)

  return sentences.map((text, index) => ({
    id: `REQ-USER-${String(index + 1).padStart(3, "0")}`,
    text,
    originalText: text,
    source: "User request",
    decision: "NEEDS_APPROVAL"
  }));
}

function titleFromRequest(request) {
  const firstSentence = request.split(/(?<=[.!?])\s/u, 1)[0];
  const cleaned = firstSentence
    .replace(/^(i want to build|i want|build me|create|make me|build)\s+/i, "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/[.!?\s]+$/g, "");
  const words = cleaned.split(/\s+/).slice(0, 7);
  if (words.length === 0 || !words[0]) return "New application";
  const title = words.join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function createDraft(originalRequest) {
  const createdAt = new Date().toISOString();
  const requirements = discoverRequirements(originalRequest);
  const projectId = randomUUID().replace(/-/g, "");

  return {
    id: projectId,
    title: titleFromRequest(originalRequest),
    originalRequest,
    status: "DRAFT",
    createdAt,
    updatedAt: createdAt,
    requirements,
    blueprint: {
      blueprintVersion: "1.0",
      project: {
        id: projectId,
        name: titleFromRequest(originalRequest),
        version: "0.1.0",
        purpose: originalRequest
      },
      originalUserRequest: originalRequest,
      requirements: [],
      assumptions: [{
        text: "Requirements are extracted locally from the submitted text; no AI provider was used.",
        classification: "Safe default"
      }],
      roles: [],
      pages: [],
      dataEntities: [],
      integrations: [],
      agents: [],
      tasks: [],
      acceptanceGates: [],
      release: {
        status: "NOT_READY",
        evidence: [],
        blockers: ["Requirements have not been approved."]
      }
    },
    executions: [],
    tasks: []
  };
}

function buildTaskGraph(project) {
  const requirementIds = project.requirements
    .filter((requirement) => requirement.decision === "APPROVED")
    .map((requirement) => requirement.id);

  const plans = [
    ["architecture", "systems-architect", []],
    ["ux", "ux-research", ["architecture"]],
    ["database", "database-engineer", ["architecture"]],
    ["backend", "backend-engineer", ["architecture", "database"]],
    ["frontend", "frontend-engineer", ["architecture", "ux"]],
    ["integration", "integration", ["backend", "frontend"]],
    ["testing", "testing", ["integration"]],
    ["security", "security", ["testing"]],
    ["qa", "qa-critic", ["security"]],
    ["release", "release-manager", ["qa"]]
  ];

  const taskIds = new Map(plans.map(([key], index) => [
    key,
    `TASK-${String(index + 1).padStart(3, "0")}`
  ]));

  return plans.map(([key, agentId, dependencyKeys]) => {
    const agent = getAgent(agentId);
    return {
      taskId: taskIds.get(key),
      projectId: project.id,
      requirementIds,
      assignedAgent: {
        id: agent.id,
        name: agent.name
      },
      input: {
        projectId: project.id,
        requirementIds,
        blueprintVersion: project.blueprint.blueprintVersion
      },
      expectedOutputSchema: agent.outputContract,
      dependencies: dependencyKeys.map((dependency) => taskIds.get(dependency)),
      allowedFilePaths: [],
      allowedTools: agent.allowedTools,
      securityConstraints: agent.securityConstraints,
      acceptanceCriteria: [`Produce and verify the ${key} deliverable against the approved requirements.`],
      timeoutSeconds: 300,
      retryPolicy: { maxAttempts: 1 },
      status: "BLOCKED",
      evidence: [],
      failureReason: "No AI provider or production worker is configured in this repository.",
      artifactReferences: [],
      createdAt: new Date().toISOString()
    };
  });
}

function approveRequirements(project, decisions) {
  if (!Array.isArray(decisions) || decisions.length !== project.requirements.length) {
    throw new Error("Provide one decision for every requirement.");
  }

  const submitted = new Map();
  for (const decision of decisions) {
    const normalizedText = typeof decision?.text === "string"
      ? cleanRequirementText(decision.text)
      : "";
    if (
      !decision
      || typeof decision.id !== "string"
      || typeof decision.text !== "string"
      || typeof decision.approved !== "boolean"
      || normalizedText.length === 0
      || decision.text.length > 2000
      || submitted.has(decision.id)
    ) {
      throw new Error("Each requirement decision must include a unique id, non-empty text, and approval choice.");
    }
    submitted.set(decision.id, { ...decision, text: normalizedText });
  }

  if (project.requirements.some((requirement) => !submitted.has(requirement.id))) {
    throw new Error("Requirement IDs do not match this project.");
  }

  for (const requirement of project.requirements) {
    const decision = submitted.get(requirement.id);
    requirement.text = decision.text;
    requirement.decision = decision.approved ? "APPROVED" : "REJECTED";
  }

  if (!project.requirements.some((requirement) => requirement.decision === "APPROVED")) {
    throw new Error("Approve at least one requirement before continuing.");
  }

  const approvedRequirements = project.requirements
    .filter((requirement) => requirement.decision === "APPROVED")
    .map(({ id, text, source, originalText }) => ({ id, text, source, originalText }));

  project.blueprint.requirements = approvedRequirements;
  project.blueprint.release.blockers = [
    "AI implementation workers are blocked until a verified provider and execution environment are configured.",
    "Authentication, database persistence, and deployment are not implemented."
  ];
  project.blueprint.release.status = "BLOCKED";
  project.blueprint.tasks = [];
  project.tasks = buildTaskGraph(project);
  project.blueprint.tasks = project.tasks;
  project.status = "APPROVED_PLAN";
  project.updatedAt = new Date().toISOString();
  project.executions.push({
    executionId: randomUUID(),
    agentId: "product-discovery",
    status: "VERIFIED",
    evidence: ["Requirements were parsed locally and individually approved or rejected by the user."],
    createdAt: project.updatedAt
  });
  project.executions.push({
    executionId: randomUUID(),
    agentId: "beginner-explanation",
    status: "IMPLEMENTED_UNVERIFIED",
    evidence: ["The interface presents the approved requirements in plain language."],
    createdAt: project.updatedAt
  });

  return project;
}

function serializeBlueprint(blueprint) {
  return `${JSON.stringify(blueprint, null, 2)}\n`;
}

module.exports = {
  approveRequirements,
  buildTaskGraph,
  createDraft,
  discoverRequirements,
  serializeBlueprint
};
