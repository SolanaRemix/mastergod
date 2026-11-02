const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { approveRequirements, buildTaskGraph, createDraft, discoverRequirements } = require("../src/blueprint");
const { agents } = require("../src/agents");
const { AgentCapabilityRegistry } = require("../src/capability-registry");
const { AgentOrchestrator } = require("../src/services/AgentOrchestrator.ts");
const { createServer } = require("../server");

let directory;
let server;
let baseUrl;
let projectStore;
let authStore;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "gods-test-"));
  const application = createServer({ dataDir: directory });
  server = application.server;
  projectStore = application.store;
  authStore = application.authStore;
  await Promise.all([application.store.initialize(), application.authStore.initialize()]);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

async function registerAccount(email) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl
    },
    body: JSON.stringify({ email, password: "A-long-test-password-123!" })
  });
  const result = await response.json();
  return {
    response,
    result,
    cookie: response.headers.get("set-cookie")?.split(";")[0]
  };
}

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await projectStore.close();
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
  assert.deepEqual(project.executions, [], "plan approval must not create fabricated agent execution records");
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
    assert.ok(agent.capabilities.length > 0);
    assert.equal(agent.availability, "catalog-only");
    assert.equal(agent.deploymentStatus, "not-deployed");
  }
  assert.equal(agents.find((agent) => agent.id === "frontend-engineer").execution, "provider");
});

test("capability registry discovers request-specific and registered specialist capabilities", () => {
  const registry = new AgentCapabilityRegistry(agents);
  const specialist = {
    ...agents.find((agent) => agent.id === "integration"),
    id: "solana-swap-specialist",
    name: "Solana Swap Specialist",
    capabilities: ["solana-swap"],
    keywords: ["Solana swap"],
    version: "1.0.0"
  };
  registry.register(specialist);
  const plan = registry.discover([{ id: "REQ-1", text: "Build a Solana swap wallet." }], "web3");
  assert.ok(plan.assignments.some((assignment) => assignment.agentId === specialist.id));
  assert.ok(plan.capabilityGaps.some((gap) => gap.capability === "blockchain-integration"));
  assert.ok(plan.capabilityGaps.some((gap) => gap.capability === "solana-swap"));
  assert.throws(() => registry.register(specialist), { code: "AGENT_ALREADY_REGISTERED" });
});

test("V12 blueprint version, canonical status values, and release gates are consistent", () => {
  const manifest = require("../package.json");
  const blueprint = JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "..", "gods.blueprint.yaml"), "utf8"));
  const knownStatuses = new Set([
    "VERIFIED", "IMPLEMENTED_UNVERIFIED", "PARTIALLY_IMPLEMENTED", "MISSING",
    "BLOCKED", "FAILED", "UNKNOWN", "NOT_APPLICABLE"
  ]);
  assert.equal(manifest.version, "12.0.0");
  assert.equal(blueprint.project.version, manifest.version);
  assert.equal(blueprint.blueprintVersion, manifest.version);
  assert.equal(blueprint.release.productionReady, false);
  assert.equal(blueprint.release.acceptanceGates.length, 17);
  assert.ok(blueprint.requirements.every((requirement) => knownStatuses.has(requirement.status)));
  assert.ok(blueprint.release.acceptanceGates.every((gate) => knownStatuses.has(gate.status)));
});

test("health reports the initialized SQLite persistence adapter", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.persistence, "sqlite");
  assert.equal(health.version, require("../package.json").version);
  assert.equal(health.authentication, "ENABLED");
  assert.equal(health.productionReady, false);
});

test("deployment preflight blocks missing credentials, invalid health URLs, and unmet release gates", () => {
  const script = path.join(__dirname, "..", "scripts", "deploy-release.sh");
  const missingConfiguration = spawnSync("bash", [script, "preflight"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH }
  });
  assert.equal(missingConfiguration.status, 2);
  assert.match(missingConfiguration.stderr, /Deployment BLOCKED: required configuration GODS_DEPLOY_HOST is missing/);

  const configuration = {
    ...process.env,
    GODS_DEPLOY_HOST: "deploy.example",
    GODS_DEPLOY_USER: "gods",
    GODS_DEPLOY_KEY: "placeholder-only",
    GODS_DEPLOY_KNOWN_HOSTS: "deploy.example ssh-ed25519 placeholder-only",
    GODS_DEPLOY_PATH: "/srv/gods",
    GODS_DEPLOY_HEALTH_URL: "https://deploy.example/api/health"
  };
  const invalidUrl = spawnSync("bash", [script, "preflight"], {
    encoding: "utf8",
    env: { ...configuration, GODS_DEPLOY_HEALTH_URL: "http://deploy.example/api/health" }
  });
  assert.equal(invalidUrl.status, 2);
  assert.match(invalidUrl.stderr, /HTTPS health URL is invalid/);

  const malformedUrl = spawnSync("bash", [script, "preflight"], {
    encoding: "utf8",
    env: { ...configuration, GODS_DEPLOY_HEALTH_URL: "https://bad host/?key=do-not-log" }
  });
  assert.equal(malformedUrl.status, 2);
  assert.match(malformedUrl.stderr, /HTTPS health URL is invalid/);
  assert.equal(malformedUrl.stderr.includes("do-not-log"), false);

  const unmetGates = spawnSync("bash", [script, "preflight"], { encoding: "utf8", env: configuration });
  assert.equal(unmetGates.status, 3);
  assert.match(unmetGates.stderr, /project release blueprint still has unmet production gates/);
});

test("registration creates a user account and an opaque, HttpOnly session cookie", async () => {
  const { response, result, cookie } = await registerAccount("Alice@example.com");
  assert.equal(response.status, 201);
  assert.equal(result.user.email, "alice@example.com");
  assert.equal(result.user.role, "user");
  assert.equal(Object.hasOwn(result.user, "passwordHash"), false);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/);
  assert.match(cookie, /^gods_session=/);

  const session = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.id, result.user.id);
});

test("login rejects bad credentials and logout revokes the session", async () => {
  const registration = await registerAccount("logout@example.com");
  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email: "logout@example.com", password: "not-the-password" })
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email: "LOGOUT@example.com", password: "A-long-test-password-123!" })
  });
  assert.equal(login.status, 200);
  const loginCookie = login.headers.get("set-cookie").split(";")[0];
  assert.notEqual(loginCookie, registration.cookie);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { cookie: loginCookie, origin: baseUrl }
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: loginCookie } })).status, 401);
});

test("password reset tokens are single-use, expire, and revoke prior sessions", async () => {
  const account = await registerAccount("recovery@example.com");
  const { AuthService } = require("../src/auth");
  const auth = new AuthService(authStore);
  const token = await auth.requestPasswordReset("RECOVERY@example.com");
  assert.equal(typeof token, "string");
  assert.equal(await auth.resetPassword(token, "new-secure-password-456!"), true);
  assert.equal(await auth.resetPassword(token, "another-secure-password-789!"), false);
  assert.equal(await auth.getSession(account.cookie.split("=")[1]), null);
  assert.equal(await auth.login("recovery@example.com", "A-long-test-password-123!"), null);
  assert.ok(await auth.login("recovery@example.com", "new-secure-password-456!"));
  assert.equal(await auth.resetPassword(token, "short"), false);

  const expiredToken = randomBytes(32).toString("base64url");
  await authStore.createPasswordReset({
    tokenHash: require("../src/auth").hashSessionToken(expiredToken),
    userId: account.result.user.id,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    createdAt: new Date(Date.now() - 60_000).toISOString()
  });
  assert.equal(await auth.resetPassword(expiredToken, "expired-reset-password-123!"), false);
});

test("login refuses to issue a session if the password changes during verification", async () => {
  const { AuthService, hashPassword } = require("../src/auth");
  const credentials = await hashPassword("concurrent-login-password");
  const store = {
    async findUserByEmail() {
      return {
        id: "race-user",
        email: "race@example.com",
        role: "user",
        createdAt: new Date().toISOString(),
        ...credentials
      };
    },
    async createSessionIfPasswordMatches() {
      return false;
    }
  };
  const login = await new AuthService(store).login("race@example.com", "concurrent-login-password");
  assert.equal(login, null);
});

test("authentication enforces password policy, unique email, and same-origin mutations", async () => {
  const shortPassword = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email: "short@example.com", password: "short" })
  });
  assert.equal(shortPassword.status, 400);

  const first = await registerAccount("duplicate@example.com");
  assert.equal(first.response.status, 201);
  const duplicate = await registerAccount("DUPLICATE@example.com");
  assert.equal(duplicate.response.status, 409);

  const crossOrigin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ email: "duplicate@example.com", password: "A-long-test-password-123!" })
  });
  assert.equal(crossOrigin.status, 403);

  const recovery = await fetch(`${baseUrl}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email: "duplicate@example.com" })
  });
  assert.equal(recovery.status, 503);
  assert.equal((await recovery.json()).status, "BLOCKED");
});

test("admin access requires explicit password-verified provisioning for the configured identity", async () => {
  const account = await registerAccount("gxqstudio@gmail.com");
  const denied = await fetch(`${baseUrl}/api/admin/summary`, { headers: { cookie: account.cookie } });
  assert.equal(denied.status, 403);

  const { provisionAdmin } = require("../scripts/provision-admin");
  await assert.rejects(() => provisionAdmin({
    dataDir: directory,
    email: "attacker@example.com",
    password: "A-long-test-password-123!",
    targetEmail: "gxqstudio@gmail.com"
  }), /Only the configured super-admin account/);
  await assert.rejects(() => provisionAdmin({
    dataDir: directory,
    email: "gxqstudio@gmail.com",
    password: "wrong-password",
    targetEmail: "gxqstudio@gmail.com"
  }), /could not be verified/);

  const admin = await provisionAdmin({
    dataDir: directory,
    email: "gxqstudio@gmail.com",
    password: "A-long-test-password-123!",
    targetEmail: "gxqstudio@gmail.com"
  });
  assert.equal(admin.role, "admin");
  const summary = await fetch(`${baseUrl}/api/admin/summary`, { headers: { cookie: account.cookie } });
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).summary.users > 0, true);
});

test("game studio creates a private playable version, refines it, saves progress, and restores history", async () => {
  const owner = await registerAccount("game-owner@example.com");
  const other = await registerAccount("game-other@example.com");
  const create = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie, origin: baseUrl },
    body: JSON.stringify({
      prompt: "Build a 3D multiplayer music game <script>window.pwned=1</script> collecting orbs"
    })
  });
  assert.equal(create.status, 201);
  const result = await create.json();
  const { game } = result;
  assert.equal(game.status, "IMPLEMENTED_UNVERIFIED");
  assert.equal(game.specification.engine, "HTML5 Canvas 2D");
  assert.ok(result.limitations.includes("3D scenes and models"));
  assert.ok(result.limitations.includes("online or local multiplayer"));
  assert.equal(game.versions.length, 1);
  assert.equal(Object.hasOwn(game.versions[0], "source"), false);

  assert.equal((await fetch(`${baseUrl}/api/games`, { headers: { cookie: other.cookie } })
    .then((response) => response.json())).games.length, 0);
  assert.equal((await fetch(`${baseUrl}/api/games/${game.id}`, { headers: { cookie: other.cookie } })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/games/${game.id}/preview`, { headers: { cookie: other.cookie } })).status, 404);

  const preview = await fetch(`${baseUrl}/api/games/${game.id}/preview?version=1`, { headers: { cookie: owner.cookie } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-security-policy"), /sandbox allow-scripts/);
  assert.match(preview.headers.get("content-security-policy"), /connect-src 'none'/);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /<canvas id="arena"/);
  assert.match(previewHtml, /requestAnimationFrame\(draw\)/);
  assert.doesNotMatch(previewHtml, /<\/script><script>window\.pwned/);
  assert.match(previewHtml, /\\u003cscript\\u003ewindow\.pwned=1\\u003c\/script\\u003e/);
  assert.match(previewHtml, /connect-src 'none'/);

  const state = { x: 120, y: 170, score: 4, orbX: 400, orbY: 210, untrusted: "<script>" };
  const save = await fetch(`${baseUrl}/api/games/${game.id}/save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie, origin: baseUrl },
    body: JSON.stringify({ state })
  });
  assert.equal(save.status, 200);
  assert.deepEqual((await save.json()).save.state, {
    x: state.x,
    y: state.y,
    score: state.score,
    orbX: state.orbX,
    orbY: state.orbY
  });
  assert.equal((await fetch(`${baseUrl}/api/games/${game.id}/save`, { headers: { cookie: other.cookie } })).status, 404);

  const invalidSave = await fetch(`${baseUrl}/api/games/${game.id}/save`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie, origin: baseUrl },
    body: JSON.stringify({ state: { ...state, score: -1 } })
  });
  assert.equal(invalidSave.status, 400);

  const refinement = await fetch(`${baseUrl}/api/games/${game.id}/refine`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie, origin: baseUrl },
    body: JSON.stringify({ instruction: "Make the game easier" })
  });
  assert.equal(refinement.status, 200);
  const refined = (await refinement.json()).game;
  assert.equal(refined.latestVersion, 2);
  assert.equal(refined.specification.difficulty, "easy");
  assert.equal(Object.hasOwn(refined.versions[0], "specification"), false);

  const unsupported = await fetch(`${baseUrl}/api/games/${game.id}/refine`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie, origin: baseUrl },
    body: JSON.stringify({ instruction: "Make it 3D" })
  });
  assert.equal(unsupported.status, 422);
  assert.equal((await unsupported.json()).status, "PARTIALLY_IMPLEMENTED");

  const restore = await fetch(`${baseUrl}/api/games/${game.id}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie, origin: baseUrl },
    body: JSON.stringify({ version: 1 })
  });
  assert.equal(restore.status, 200);
  const restored = (await restore.json()).game;
  assert.equal(restored.latestVersion, 3);
  assert.equal(restored.specification.difficulty, "normal");
  assert.equal(restored.versions.length, 3);
  assert.equal((await fetch(`${baseUrl}/api/games/${game.id}`, { headers: { cookie: owner.cookie } })
    .then((response) => response.json())).game.latestVersion, 3);
});

test("project creation, approval, blueprint download, and persistence work end to end", async () => {
  const account = await registerAccount("project-owner@example.com");
  assert.equal(account.response.status, 201);
  const create = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: account.cookie, origin: baseUrl },
    body: JSON.stringify({ prompt: "I want an appointment app for my small business." })
  });
  assert.equal(create.status, 201);
  const { project } = await create.json();

  const approval = await fetch(`${baseUrl}/api/projects/${project.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: account.cookie, origin: baseUrl },
    body: JSON.stringify({
      decisions: project.requirements.map((requirement) => ({
        id: requirement.id,
        text: requirement.text,
        approved: true
      }))
    })
  });
  assert.equal(approval.status, 200);

  const download = await fetch(`${baseUrl}/api/projects/${project.id}/blueprint`, { headers: { cookie: account.cookie } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/yaml; charset=utf-8");
  const blueprint = JSON.parse(await download.text());
  assert.equal(blueprint.requirements.length, 1);
  assert.equal(blueprint.tasks[0].status, "BLOCKED");

  assert.equal((await projectStore.get(project.id)).status, "APPROVED_PLAN");
});

test("project data is private to its owner and unauthenticated access is denied", async () => {
  const owner = await registerAccount("owner@example.com");
  const other = await registerAccount("other@example.com");
  const create = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie, origin: baseUrl },
    body: JSON.stringify({ prompt: "Build a private project for one account." })
  });
  const { project } = await create.json();

  assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 401);
  const list = await fetch(`${baseUrl}/api/projects`, { headers: { cookie: other.cookie } });
  assert.equal((await list.json()).projects.length, 0);
  assert.equal((await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: { cookie: other.cookie } })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: { cookie: owner.cookie } })).status, 200);
});

test("blueprint generation persists an agent graph and artifact files remain owner-scoped and versioned", async () => {
  const owner = await registerAccount("artifact-owner@example.com");
  const other = await registerAccount("artifact-other@example.com");
  const headers = { "content-type": "application/json", cookie: owner.cookie, origin: baseUrl };

  async function createApprovedProject(prompt) {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt })
    });
    assert.equal(response.status, 201);
    const { project } = await response.json();
    const approval = await fetch(`${baseUrl}/api/projects/${project.id}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        decisions: project.requirements.map((requirement) => ({
          id: requirement.id,
          text: requirement.text,
          approved: true
        }))
      })
    });
    assert.equal(approval.status, 200);
    return project;
  }

  async function json(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { ...headers, ...options.headers } });
    return { response, body: await response.json() };
  }

  const truckingProject = await createApprovedProject("Build a trucking tool for drivers, vehicles, and invoices.");
  const bookingsProject = await createApprovedProject("Build a calendar booking app for customer appointments.");
  const workflowProject = await createApprovedProject("Automate customer registration, CRM creation, and welcome emails.");
  const unapprovedProject = (await (async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Build a project that requires approval before task assignment." })
    });
    return (await response.json()).project;
  })());
  const unapproved = await fetch(`${baseUrl}/api/projects/${unapprovedProject.id}/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({})
  });
  assert.equal(unapproved.status, 409);

  const generated = await json(`/api/projects/${truckingProject.id}/generate`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(generated.response.status, 201);
  assert.equal(generated.body.status, "IMPLEMENTED_UNVERIFIED");
  assert.equal(generated.body.projectType, "fleet");
  assert.equal(generated.body.executionStatus, "BLOCKED");
  assert.match(generated.body.executionNote, /no verified agent workers are registered/i);
  assert.ok(generated.body.tasks.some((task) => /Fleet, driver, and load workflows/.test(task.title)));
  assert.ok(generated.body.tasks.every((task) => task.status === "BLOCKED"));
  assert.ok(generated.body.selectedAgents.some((agent) => agent.capability === "authentication-design"));
  assert.ok(generated.body.capabilityGaps.some((gap) => gap.capability === "backend-development"));
  assert.equal(generated.body.execution.status, "blocked");
  assert.equal(generated.body.execution.taskGraph.length, generated.body.taskCount);
  const persistedExecution = await json(`/api/projects/${truckingProject.id}/execution`);
  assert.equal(persistedExecution.response.status, 200);
  assert.equal(persistedExecution.body.execution.originalPrompt, truckingProject.originalRequest);
  assert.equal(persistedExecution.body.execution.requestId, generated.body.generationId);
  assert.equal((await fetch(`${baseUrl}/api/projects/${truckingProject.id}/execution`, {
    headers: { cookie: other.cookie }
  })).status, 404);
  const repeated = await json(`/api/projects/${truckingProject.id}/generate`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.deepEqual(repeated.body.tasks.map((task) => task.taskId), generated.body.tasks.map((task) => task.taskId));
  assert.equal(repeated.body.tasks.length, generated.body.taskCount);

  const alternate = await json(`/api/projects/${bookingsProject.id}/generate`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(alternate.body.projectType, "booking");
  assert.ok(alternate.body.tasks.some((task) => /Booking and scheduling workflows/.test(task.title)));
  assert.ok(alternate.body.selectedAgents.some((agent) => agent.capability === "external-integrations"));
  const workflow = await json(`/api/projects/${workflowProject.id}/generate`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.ok(workflow.body.selectedAgents.some((agent) => agent.capability === "workflow-automation"));
  assert.ok(workflow.body.tasks.some((task) => task.input.capability === "workflow-automation"));
  const noWorker = await json(`/api/projects/${truckingProject.id}/tasks/${encodeURIComponent(generated.body.tasks[0].taskId)}/run`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(noWorker.response.status, 409);
  assert.equal(noWorker.body.task.status, "BLOCKED");
  const taskEvents = await json(`/api/projects/${truckingProject.id}/tasks/${encodeURIComponent(generated.body.tasks[0].taskId)}/events`);
  assert.equal(taskEvents.response.status, 200);
  assert.ok(taskEvents.body.events.length > 0);

  const ownerTree = await json(`/api/projects/${truckingProject.id}/artifacts`);
  assert.equal(ownerTree.response.status, 200);
  assert.equal(ownerTree.body.files.length, 0);
  assert.equal((await fetch(`${baseUrl}/api/projects/${truckingProject.id}/artifacts`, {
    headers: { cookie: other.cookie }
  })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/projects/${truckingProject.id}/artifacts`)).status, 401);

  const retiredGenerator = await json(`/api/projects/${truckingProject.id}/artifacts/generate`, {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(retiredGenerator.response.status, 410);

  const protectedFile = await json(`/api/projects/${truckingProject.id}/artifacts/files`, {
    method: "POST",
    body: JSON.stringify({ path: "package.json", contents: "{}", language: "json" })
  });
  assert.equal(protectedFile.response.status, 201);

  const created = await json(`/api/projects/${truckingProject.id}/artifacts/files`, {
    method: "POST",
    body: JSON.stringify({ path: "docs/notes.md", contents: "Original text", language: "markdown" })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.artifact.version, 1);
  const uploaded = await json(`/api/projects/${truckingProject.id}/artifacts/upload`, {
    method: "POST",
    body: JSON.stringify({
      path: "src/hello.js",
      contentsBase64: Buffer.from("console.log('hello 🌎');", "utf8").toString("base64"),
      language: "js"
    })
  });
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.artifact.contents, "console.log('hello 🌎');");
  const binaryUpload = await json(`/api/projects/${truckingProject.id}/artifacts/upload`, {
    method: "POST",
    body: JSON.stringify({
      path: "assets/image.png",
      contentsBase64: Buffer.from([0xff, 0x00, 0x89]).toString("base64"),
      language: "png"
    })
  });
  assert.equal(binaryUpload.response.status, 415);
  const readBack = await json(`/api/projects/${truckingProject.id}/artifacts/file?path=docs%2Fnotes.md`);
  assert.equal(readBack.body.artifact.contents, "Original text");
  const blocker = await json(`/api/projects/${truckingProject.id}/artifacts/files`, {
    method: "POST",
    body: JSON.stringify({ path: "occupied", contents: "file", language: "text" })
  });
  assert.equal(blocker.response.status, 201);
  const collidingCopy = await json(`/api/projects/${truckingProject.id}/artifacts/duplicate`, {
    method: "POST",
    body: JSON.stringify({ fromPath: "docs/notes.md", toPath: "occupied/child.md" })
  });
  assert.equal(collidingCopy.response.status, 409);
  const secretPath = await json(`/api/projects/${truckingProject.id}/artifacts/files`, {
    method: "POST",
    body: JSON.stringify({ path: ".env", contents: "KEY=value", language: "text" })
  });
  assert.equal(secretPath.response.status, 400);
  const saved = await json(`/api/projects/${truckingProject.id}/artifacts/file?path=docs%2Fnotes.md`, {
    method: "PUT",
    body: JSON.stringify({ contents: "Updated text", expectedVersion: 1 })
  });
  assert.equal(saved.body.artifact.version, 2);
  const staleSave = await json(`/api/projects/${truckingProject.id}/artifacts/file?path=docs%2Fnotes.md`, {
    method: "PUT",
    body: JSON.stringify({ contents: "Lost update", expectedVersion: 1 })
  });
  assert.equal(staleSave.response.status, 409);

  const history = await json(`/api/projects/${truckingProject.id}/artifacts/history?path=docs%2Fnotes.md`);
  assert.deepEqual(history.body.history.map((version) => version.version), [2, 1]);
  const restored = await json(`/api/projects/${truckingProject.id}/artifacts/restore`, {
    method: "POST",
    body: JSON.stringify({ path: "docs/notes.md", version: 1, expectedVersion: 2 })
  });
  assert.equal(restored.body.artifact.contents, "Original text");
  assert.equal(restored.body.artifact.version, 3);

  const duplicate = await json(`/api/projects/${truckingProject.id}/artifacts/duplicate`, {
    method: "POST",
    body: JSON.stringify({ fromPath: "docs/notes.md", toPath: "docs/copy.md" })
  });
  assert.equal(duplicate.response.status, 201);
  const renamed = await json(`/api/projects/${truckingProject.id}/artifacts/rename`, {
    method: "POST",
    body: JSON.stringify({
      kind: "file",
      fromPath: "docs/copy.md",
      toPath: "docs/renamed.md",
      expectedVersion: 1
    })
  });
  assert.equal(renamed.body.artifact.path, "docs/renamed.md");

  const protectedDelete = await fetch(`${baseUrl}/api/projects/${truckingProject.id}/artifacts/file?path=package.json&version=1`, {
    method: "DELETE",
    headers
  });
  assert.equal(protectedDelete.status, 403);
  const traversal = await fetch(`${baseUrl}/api/projects/${truckingProject.id}/artifacts/file?path=${encodeURIComponent("../outside")}`, {
    headers: { cookie: owner.cookie }
  });
  assert.equal(traversal.status, 400);

  const newFolder = await json(`/api/projects/${truckingProject.id}/artifacts/directories`, {
    method: "POST",
    body: JSON.stringify({ path: "scratch/nested" })
  });
  assert.equal(newFolder.response.status, 201);
  const folderRename = await json(`/api/projects/${truckingProject.id}/artifacts/directories`, {
    method: "PATCH",
    body: JSON.stringify({ fromPath: "scratch", toPath: "archive" })
  });
  assert.equal(folderRename.response.status, 200);
  const folderParentCollision = await json(`/api/projects/${truckingProject.id}/artifacts/directories`, {
    method: "PATCH",
    body: JSON.stringify({ fromPath: "docs", toPath: "occupied/subfolder" })
  });
  assert.equal(folderParentCollision.response.status, 409);
  const folderDelete = await fetch(`${baseUrl}/api/projects/${truckingProject.id}/artifacts/directories?path=archive`, {
    method: "DELETE",
    headers
  });
  assert.equal(folderDelete.status, 200);

  const download = await fetch(`${baseUrl}/api/projects/${truckingProject.id}/artifacts/file?path=docs%2Fnotes.md&download=1`, {
    headers: { cookie: owner.cookie }
  });
  assert.equal(await download.text(), "Original text");
  const exportResponse = await fetch(`${baseUrl}/api/projects/${truckingProject.id}/artifacts/export`, {
    headers: { cookie: owner.cookie }
  });
  const exported = await exportResponse.json();
  assert.ok(exported.files.some((file) => file.path === "docs/notes.md" && file.contents === "Original text"));
  const zipResponse = await fetch(`${baseUrl}/api/projects/${truckingProject.id}/artifacts/zip`, {
    headers: { cookie: owner.cookie }
  });
  assert.equal(zipResponse.status, 200);
  assert.equal(zipResponse.headers.get("content-type"), "application/zip");
  const zipBytes = Buffer.from(await zipResponse.arrayBuffer());
  assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);
  const zipDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gods-zip-test-"));
  const zipPath = path.join(zipDirectory, "project.zip");
  await fs.writeFile(zipPath, zipBytes);
  const archiveCheck = spawnSync("unzip", ["-tqq", zipPath], { encoding: "utf8" });
  assert.equal(archiveCheck.status, 0);
  const archivePaths = spawnSync("unzip", ["-Z", "-1", zipPath], { encoding: "utf8" });
  assert.equal(archivePaths.status, 0);
  assert.match(archivePaths.stdout, /docs\/notes\.md/);
  assert.match(archivePaths.stdout, /src\/hello\.js/);
  assert.doesNotMatch(archivePaths.stdout, /\.env|gods\.sqlite|credentials/i);
  await fs.rm(zipDirectory, { recursive: true, force: true });
  const audit = await json(`/api/projects/${truckingProject.id}/artifacts/audit`);
  assert.ok(audit.body.audit.some((entry) => entry.action === "restored"));

  const deleteFile = await fetch(`${baseUrl}/api/projects/${truckingProject.id}/artifacts/file?path=docs%2Frenamed.md&version=1`, {
    method: "DELETE",
    headers
  });
  assert.equal(deleteFile.status, 200);
  assert.equal((await json(`/api/projects/${truckingProject.id}/artifacts/file?path=docs%2Frenamed.md`)).response.status, 404);
});

test("agent task state machine persists retries and prevents repeat execution after completion", async () => {
  const account = await registerAccount("orchestrator@example.com");
  const create = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: account.cookie, origin: baseUrl },
    body: JSON.stringify({ prompt: "Build a small workflow that needs a secure automated test." })
  });
  const { project } = await create.json();
  const approval = await fetch(`${baseUrl}/api/projects/${project.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: account.cookie, origin: baseUrl },
    body: JSON.stringify({
      decisions: project.requirements.map((requirement) => ({
        id: requirement.id,
        text: requirement.text,
        approved: true
      }))
    })
  });
  assert.equal(approval.status, 200);

  const orchestrator = new AgentOrchestrator(projectStore);
  let executions = 0;
  orchestrator.registerAgent("testing", async () => {
    executions += 1;
    if (executions === 1) throw Object.assign(new Error("Temporary provider timeout."), { code: "PROVIDER_TIMEOUT" });
    return {
      status: "IMPLEMENTED_UNVERIFIED",
      artifactReferences: [],
      evidence: ["Test handler executed and returned a structured result."],
      failureReason: null
    };
  });
  const [createdTask] = await orchestrator.persistGraph(project.id, account.result.user.id, [{
    taskId: "test-retry-task",
    projectId: project.id,
    ownerId: account.result.user.id,
    generationId: "test-generation",
    projectType: "general",
    title: "Run bounded tests",
    agentId: "testing",
    dependencies: [],
    input: { projectId: project.id },
    timeoutSeconds: 5,
    maxAttempts: 2,
    attempt: 0,
    status: "BLOCKED",
    blockedReason: null,
    error: null,
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }]);
  assert.equal(createdTask.status, "QUEUED");

  const completed = await orchestrator.executeTask(project.id, account.result.user.id, createdTask.taskId);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.attempt, 2);
  assert.equal(executions, 2);
  assert.equal((await orchestrator.executeTask(project.id, account.result.user.id, createdTask.taskId)).attempt, 2);
  const events = await orchestrator.listEvents(project.id, account.result.user.id, createdTask.taskId);
  assert.deepEqual(events.map((event) => event.toState), [
    "QUEUED",
    "RUNNING",
    "RETRYING",
    "QUEUED",
    "RUNNING",
    "COMPLETED"
  ]);
});

test("project endpoints reject invalid content types and unmatched decisions", async () => {
  const account = await registerAccount("validation@example.com");
  const unknownRoute = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(unknownRoute.status, 404);
  const favicon = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(favicon.status, 204);

  const invalidBody = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: account.cookie, origin: baseUrl },
    body: "null"
  });
  assert.equal(invalidBody.status, 400);

  const wrongContentType = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { cookie: account.cookie, origin: baseUrl },
    body: "{}"
  });
  assert.equal(wrongContentType.status, 415);

  const create = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: account.cookie, origin: baseUrl },
    body: JSON.stringify({ prompt: "Build a secure booking tool." })
  });
  const { project } = await create.json();
  const invalidApproval = await fetch(`${baseUrl}/api/projects/${project.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: account.cookie, origin: baseUrl },
    body: JSON.stringify({ decisions: [] })
  });
  assert.equal(invalidApproval.status, 400);
});

test("SQLite migration imports legacy owned records once and leaves unowned projects private", async () => {
  const legacyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gods-migration-"));
  const user = {
    id: "legacy-user",
    email: "legacy@example.com",
    role: "user",
    salt: "11223344556677889900aabbccddeeff",
    passwordHash: "a".repeat(128),
    createdAt: new Date().toISOString()
  };
  const session = {
    tokenHash: "b".repeat(64),
    userId: user.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString()
  };
  const ownedProject = {
    id: "a".repeat(32),
    ownerId: user.id,
    title: "Keep my project",
    status: "DRAFT",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    blueprint: {}
  };
  const unownedProject = {
    ...ownedProject,
    id: "c".repeat(32),
    ownerId: undefined
  };

  await fs.mkdir(path.join(legacyDirectory, "projects", ownedProject.id), { recursive: true });
  await fs.mkdir(path.join(legacyDirectory, "projects", unownedProject.id), { recursive: true });
  await fs.writeFile(path.join(legacyDirectory, "auth.json"), JSON.stringify({
    users: [user],
    sessions: [session]
  }));
  await fs.writeFile(path.join(legacyDirectory, "projects", ownedProject.id, "project.json"), JSON.stringify(ownedProject));
  await fs.writeFile(path.join(legacyDirectory, "projects", unownedProject.id, "project.json"), JSON.stringify(unownedProject));

  const { AuthStore, ProjectStore } = require("../src/store");
  const authStore = new AuthStore(legacyDirectory);
  const migratedProjects = new ProjectStore(legacyDirectory);
  await Promise.all([authStore.initialize(), migratedProjects.initialize()]);

  assert.equal((await authStore.findUserByEmail("LEGACY@example.com")).id, user.id);
  assert.equal((await authStore.findUserById(user.id)).role, "user");
  assert.equal((await authStore.findSession(session.tokenHash)).userId, user.id);
  assert.equal((await migratedProjects.list(user.id)).length, 1);
  assert.equal((await migratedProjects.get(unownedProject.id)), null);
  assert.equal((await fs.stat(path.join(legacyDirectory, "gods.sqlite"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(legacyDirectory)).mode & 0o777, 0o700);

  await fs.writeFile(path.join(legacyDirectory, "projects", unownedProject.id, "project.json"), JSON.stringify({
    ...unownedProject,
    ownerId: user.id
  }));
  await migratedProjects.close();
  await migratedProjects.initialize();
  assert.equal((await migratedProjects.list(user.id)).length, 1);

  await migratedProjects.close();
  await fs.rm(legacyDirectory, { recursive: true, force: true });
});
