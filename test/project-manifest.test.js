const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createProjectImplementationManifest,
  validateManifestStatuses
} = require("../src/project-manifest");

test("implementation manifest uses recorded evidence and never equates task completion with verification", () => {
  const project = {
    id: "0123456789abcdef0123456789abcdef",
    title: "Evidence project",
    status: "APPROVED_PLAN",
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    requirements: [
      { id: "REQ-1", text: "Save a generated page.", decision: "APPROVED" },
      { id: "REQ-2", text: "Connect GitHub.", decision: "APPROVED" },
      { id: "REQ-3", text: "Rejected item.", decision: "REJECTED" },
      { id: "REQ-4", text: "Create a user-managed file.", decision: "APPROVED" }
    ]
  };
  const manifest = createProjectImplementationManifest({
    project,
    tasks: [
      { taskId: "TASK-1", agentId: "code-generation-agent", status: "COMPLETED", attempt: 1,
        input: { requirementIds: ["REQ-1"] }, updatedAt: "2026-11-02T00:00:01.000Z" },
      { taskId: "TASK-2", agentId: "web3-blockchain", status: "BLOCKED", attempt: 1,
        blockedReason: "No integration configured.", input: { requirementIds: ["REQ-2"] },
        updatedAt: "2026-11-02T00:00:02.000Z" }
    ],
    executions: [{
      id: "EXEC-1", taskId: "TASK-1", agentId: "code-generation-agent", agentVersion: "1.0.0",
      status: "COMPLETED", modelProvider: null, modelId: null, toolsInvoked: ["project-artifact-write"],
      validation: { outputContract: "VERIFIED" }, startedAt: "2026-11-02T00:00:00.000Z",
      finishedAt: "2026-11-02T00:00:01.000Z"
    }],
    artifacts: {
      files: [{
        path: "generated-app/index.html", version: 1, checksum: "abc123", sizeBytes: 128,
        status: "IMPLEMENTED_UNVERIFIED", responsibleAgent: "code-generation-agent",
        taskId: "TASK-1", requirementIds: ["REQ-1"], updatedAt: "2026-11-02T00:00:01.000Z"
      }, {
        path: "docs/notes.md", version: 1, checksum: "def456", sizeBytes: 64,
        status: "IMPLEMENTED_UNVERIFIED", responsibleAgent: "project-owner",
        taskId: "PROJECT-IMPORT-1", requirementIds: ["REQ-4"], updatedAt: "2026-11-02T00:00:03.000Z"
      }]
    },
    builds: []
  });

  assert.equal(manifest.status, "PARTIALLY_IMPLEMENTED");
  assert.equal(manifest.requirements[0].status, "IMPLEMENTED_UNVERIFIED");
  assert.equal(manifest.requirements[0].files[0].path, "generated-app/index.html");
  assert.equal(manifest.requirements[1].status, "BLOCKED");
  assert.equal(manifest.requirements[2].status, "NOT_APPLICABLE");
  assert.equal(manifest.requirements[3].status, "IMPLEMENTED_UNVERIFIED");
  assert.equal(manifest.requirements[3].tasks.length, 0);
  assert.equal(manifest.requirements[3].files[0].path, "docs/notes.md");
  assert.equal(manifest.automatedTests.status, "UNKNOWN");
  assert.equal(manifest.externalIntegrations.github.status, "BLOCKED");
  assert.equal(validateManifestStatuses(manifest), true);
});
