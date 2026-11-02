const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
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

test("health reports the initialized SQLite persistence adapter", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.persistence, "sqlite");
  assert.equal(health.authentication, "ENABLED");
  assert.equal(health.productionReady, false);
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
