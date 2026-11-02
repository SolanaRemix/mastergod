"use strict";

const IMPLEMENTATION_STATUSES = new Set([
  "VERIFIED",
  "IMPLEMENTED_UNVERIFIED",
  "PARTIALLY_IMPLEMENTED",
  "MISSING",
  "BLOCKED",
  "FAILED",
  "UNKNOWN",
  "NOT_APPLICABLE"
]);

function isApproved(requirement) {
  return requirement.decision === "APPROVED" || requirement.approved === true;
}

function requirementStatus(requirement, tasks, artifacts) {
  if (requirement.decision === "REJECTED" || requirement.approved === false) return "NOT_APPLICABLE";
  if (!isApproved(requirement)) return "UNKNOWN";
  if (!tasks.length) return artifacts.length ? "IMPLEMENTED_UNVERIFIED" : "MISSING";
  if (tasks.some((task) => task.status === "FAILED")) return "FAILED";
  const completed = tasks.filter((task) => task.status === "COMPLETED");
  if (!completed.length && tasks.some((task) => task.status === "BLOCKED")) {
    return artifacts.length ? "PARTIALLY_IMPLEMENTED" : "BLOCKED";
  }
  if (completed.length !== tasks.length) return completed.length ? "PARTIALLY_IMPLEMENTED" : "UNKNOWN";
  return "IMPLEMENTED_UNVERIFIED";
}

function createProjectImplementationManifest({ project, tasks, executions, artifacts, builds }) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const safeExecutions = Array.isArray(executions) ? executions : [];
  const files = Array.isArray(artifacts?.files) ? artifacts.files : [];
  const safeBuilds = Array.isArray(builds) ? builds : [];
  const requirements = Array.isArray(project.requirements) ? project.requirements : [];
  const manifestRequirements = requirements.map((requirement) => {
    const relatedTasks = safeTasks.filter((task) => task.input?.requirementIds?.includes(requirement.id)
      || task.requirementIds?.includes(requirement.id));
    const relatedArtifacts = files.filter((file) => file.requirementIds?.includes(requirement.id)
      || relatedTasks.some((task) => task.taskId === file.taskId));
    const relatedExecutions = safeExecutions.filter((run) => relatedTasks.some((task) => task.taskId === run.taskId));
    const relatedPaths = new Set(relatedArtifacts.map((file) => file.path));
    const relatedBuilds = safeBuilds.map((build) => ({
      buildId: build.id,
      status: build.status,
      createdAt: build.createdAt,
      checks: build.report?.checks?.filter((check) => relatedPaths.has(check.path)) || []
    })).filter((build) => build.checks.length > 0);
    return {
      requirementId: requirement.id,
      description: requirement.text || requirement.originalText || "",
      decision: requirement.decision || (requirement.approved ? "APPROVED" : "NEEDS_APPROVAL"),
      status: requirementStatus(requirement, relatedTasks, relatedArtifacts),
      responsibleAgents: [...new Set(relatedTasks.map((task) => task.agentId))],
      files: relatedArtifacts.map((file) => ({
        path: file.path,
        version: file.version,
        checksum: file.checksum
      })),
      executions: relatedExecutions.map((run) => ({
        executionId: run.id,
        taskId: run.taskId,
        agentId: run.agentId,
        agentVersion: run.agentVersion,
        status: run.status,
        provider: run.modelProvider,
        model: run.modelId,
        validation: run.validation,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt
      })),
      tasks: relatedTasks.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        attempt: task.attempt,
        resultStatus: task.result?.status || null,
        evidence: Array.isArray(task.result?.evidence)
          ? task.result.evidence.filter((item) => typeof item === "string").slice(0, 10)
            .map((item) => item.slice(0, 500))
          : [],
        artifactReferences: Array.isArray(task.result?.artifactReferences)
          ? task.result.artifactReferences.filter((item) => typeof item === "string").slice(0, 50)
          : [],
        updatedAt: task.updatedAt
      })),
      builds: relatedBuilds,
      apiEndpoints: [
        `/api/projects/${project.id}/tasks`,
        `/api/projects/${project.id}/artifacts`,
        `/api/projects/${project.id}/manifest`
      ],
      databaseChanges: "Uses existing owner-scoped SQLite project, task, execution, artifact, and build records; this manifest request applies no schema changes.",
      externalIntegrations: [{
        name: "AI model provider",
        status: relatedExecutions.some((run) => run.modelProvider) ? "IMPLEMENTED_UNVERIFIED" : "BLOCKED",
        evidence: relatedExecutions.map((run) => ({
          executionId: run.id,
          provider: run.modelProvider,
          model: run.modelId
        }))
      }],
      tests: {
        status: "UNKNOWN",
        reason: "Automated test-run results are not persisted against individual project requirements."
      },
      verificationEvidence: [
        ...relatedTasks.map((task) => `task:${task.taskId}:${task.status}`),
        ...relatedArtifacts.map((file) => `artifact:${file.path}@v${file.version}:${file.checksum}`)
      ],
      blockers: relatedTasks.filter((task) => task.status === "BLOCKED")
        .map((task) => ({ taskId: task.taskId, reason: task.blockedReason || "Task is blocked." }))
    };
  });

  const completedTasks = safeTasks.filter((task) => task.status === "COMPLETED").length;
  const hasFailure = safeTasks.some((task) => task.status === "FAILED");
  const hasBuildFailure = safeBuilds[0]?.status === "FAILED";
  const hasPartial = safeTasks.some((task) => task.status === "COMPLETED")
    || files.length > 0
    || safeBuilds.length > 0;
  const status = hasFailure || hasBuildFailure
    ? "FAILED"
    : safeTasks.some((task) => task.status === "BLOCKED") && !hasPartial
      ? "BLOCKED"
      : hasPartial
        ? "PARTIALLY_IMPLEMENTED"
        : project.status === "APPROVED_PLAN"
          ? "MISSING"
          : "UNKNOWN";

  return {
    manifestVersion: "1.0.0",
    project: {
      id: project.id,
      title: project.title,
      status: project.status,
      version: require("../package.json").version,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    },
    status,
    generatedAt: new Date().toISOString(),
    requirements: manifestRequirements,
    agents: safeExecutions.map((run) => ({
      executionId: run.id,
      agentId: run.agentId,
      version: run.agentVersion,
      taskId: run.taskId,
      status: run.status,
      provider: run.modelProvider,
      model: run.modelId,
      toolsInvoked: run.toolsInvoked,
      validation: run.validation,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt
    })),
    independentReview: (() => {
      const reviews = safeExecutions.filter((run) => run.agentId === "independent-verification");
      return {
        status: reviews.some((run) => run.status === "COMPLETED")
          ? "IMPLEMENTED_UNVERIFIED"
          : "MISSING",
        executionIds: reviews.map((run) => run.id),
        note: "A local agent's review is not an independent production acceptance test."
      };
    })(),
    files: files.map((file) => ({
      path: file.path,
      version: file.version,
      sizeBytes: file.sizeBytes,
      checksum: file.checksum,
      status: file.status,
      responsibleAgent: file.responsibleAgent,
      taskId: file.taskId,
      updatedAt: file.updatedAt
    })),
    directories: Array.isArray(artifacts?.directories) ? artifacts.directories : [],
    builds: safeBuilds.map((build) => ({
      buildId: build.id,
      status: build.status,
      createdAt: build.createdAt,
      checks: build.report?.checks?.map((check) => ({
        path: check.path,
        check: check.check,
        status: check.status
      })) || []
    })),
    automatedTests: {
      status: "UNKNOWN",
      reason: "This application does not persist test-run results per project; global test commands must be reported separately."
    },
    externalIntegrations: {
      github: { status: "BLOCKED", reason: "GitHub OAuth and repository synchronization are not configured." },
      modelProviders: { status: "BLOCKED", reason: "No AI model provider credentials or adapters are configured." },
      deployment: { status: "BLOCKED", reason: "No production deployment target is configured." }
    },
    evidenceReadBack: {
      project: true,
      taskCount: safeTasks.length,
      completedTaskCount: completedTasks,
      agentExecutionCount: safeExecutions.length,
      artifactCount: files.length,
      buildCount: safeBuilds.length
    },
    knownLimitations: [
      "Local specialist workers are deterministic and are not model-backed.",
      "A completed local task is not equivalent to a verified production feature.",
      "Static build checks do not install dependencies, compile, or execute project code.",
      "Automated test results are not persisted against this project."
    ]
  };
}

function validateManifestStatuses(manifest) {
  return IMPLEMENTATION_STATUSES.has(manifest.status)
    && manifest.requirements.every((requirement) => IMPLEMENTATION_STATUSES.has(requirement.status));
}

module.exports = { createProjectImplementationManifest, validateManifestStatuses };
