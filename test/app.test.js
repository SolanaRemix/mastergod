const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { approveRequirements, buildTaskGraph, createDraft, discoverRequirements } = require("../src/blueprint");
const { agents } = require("../src/agents");
const { createServer } = require("../server");

let directory;
let server;
let baseUrl;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "gods-test-"));
  const application = createServer({ dataDir: directory });
  server = application.server;
  await application.store.initialize();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
});

test("requirement discovery preserves user wording and assigns stable IDs", () => {
  assert.deepEqual(
    discoverRequirements("Drivers can register. Admins can manage vehicles!"),
    [
      { id: "REQ-USER-001", text: "Drivers can register.", originalText: "Drivers can register.", source: "User request", decision: "NEEDS_APPROVAL" },
      { id: "REQ-USER-002", text: "Admins can manage vehicles!", originalText: "Admins can manage vehicles!", source: "User request", decision: "NEEDS_APPROVAL" }
    ]
  );
});

test("requirement discovery does not silently truncate long requests", () => {
  const prompt = Array.from({ length: 101 }, (_, index) => `Requirement ${index + 1}.`).join(" ");
  assert.equal(discoverRequirements(prompt).length, 101);
});

test("draft names are concise and based on the first sentence", () => {
  const project = createDraft("I want an appointment app. Customers can choose a service. Staff can manage bookings.");
  assert.equal(project.title, "Appointment app");
});

test("approval persists accepted requirements and a dependency-aware blocked task graph", () => {
  const project = createDraft("Customers book appointments. Staff manage schedules.");
  approveRequirements(project, project.requirements.map((requirement) => ({
    id: requirement.id,
    text: requirement.text,
    approved: true
  })));

  assert.equal(project.status, "APPROVED_PLAN");
  assert.equal(project.blueprint.requirements.length, 2);
  assert.equal(project.tasks.length, 10);
  assert.ok(project.tasks.every((task) => task.status === "BLOCKED"));
  assert.equal(project.tasks[1].dependencies[0], project.tasks[0].taskId);
  assert.ok(project.tasks.every((task) => task.requirementIds.length === 2));
  assert.equal(buildTaskGraph(project)[0].assignedAgent.id, "systems-architect");
});

test("approval rejects requirement edits that normalize to empty text", () => {
  const project = createDraft("Customers can make bookings.");
  assert.throws(() => approveRequirements(project, [{
    id: project.requirements[0].id,
    text: "- *",
    approved: true
  }]), /non-empty text/);
});

test("agent catalog declares complete contracts without overstating provider execution", () => {
  assert.equal(agents.length, 21);
  for (const agent of agents) {
    assert.ok(agent.inputContract.projectId);
    assert.ok(agent.outputContract.status);
    assert.ok(agent.securityConstraints.length > 0);
  }
  assert.equal(agents.find((agent) => agent.id === "frontend-engineer").execution, "provider");
});

test("project creation, approval, blueprint download, and persistence work end to end", async () => {
  const create = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "I want an appointment app for my small business." })
  });
  assert.equal(create.status, 201);
  const { project } = await create.json();

  const approval = await fetch(`${baseUrl}/api/projects/${project.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      decisions: project.requirements.map((requirement) => ({
        id: requirement.id,
        text: requirement.text,
        approved: true
      }))
    })
  });
  assert.equal(approval.status, 200);

  const download = await fetch(`${baseUrl}/api/projects/${project.id}/blueprint`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/yaml; charset=utf-8");
  const blueprint = JSON.parse(await download.text());
  assert.equal(blueprint.requirements.length, 1);
  assert.equal(blueprint.tasks[0].status, "BLOCKED");

  const projectFile = path.join(directory, "projects", project.id, "project.json");
  assert.equal(JSON.parse(await fs.readFile(projectFile, "utf8")).status, "APPROVED_PLAN");
});

test("project endpoints reject invalid content types and unmatched decisions", async () => {
  const unknownRoute = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(unknownRoute.status, 404);
  const favicon = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(favicon.status, 204);

  const invalidBody = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null"
  });
  assert.equal(invalidBody.status, 400);

  const wrongContentType = await fetch(`${baseUrl}/api/projects`, { method: "POST", body: "{}" });
  assert.equal(wrongContentType.status, 415);

  const create = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Build a secure booking tool." })
  });
  const { project } = await create.json();
  const invalidApproval = await fetch(`${baseUrl}/api/projects/${project.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decisions: [] })
  });
  assert.equal(invalidApproval.status, 400);
});
