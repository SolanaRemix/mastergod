const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createServer } = require("../server");
const {
  OpenAICompatibleAdapter,
  ModelRouter,
  PRODUCT_DISCOVERY_SCHEMA,
  ProviderError,
  isPrivateAddress,
  validateProviderEndpoint
} = require("../src/providers");

const API_KEY = "test-provider-key-must-never-be-returned";
const discovery = {
  purpose: "Manage trucking operations.",
  targetUsers: ["Drivers", "Administrators"],
  roles: ["Driver", "Administrator"],
  pages: ["Driver dashboard", "Admin dashboard"],
  features: ["Manage vehicles", "Track loads"],
  workflows: ["Drivers submit load updates."],
  dataEntities: ["User", "Vehicle", "Load"],
  relationships: ["A driver is assigned to vehicles."],
  authentication: "Users sign in before accessing private records.",
  permissions: ["Drivers manage their assigned loads."],
  integrations: [],
  payments: [],
  notifications: [],
  reporting: [],
  security: ["Validate authorization for every owner-scoped record."],
  mobileAndDesktop: "Responsive layouts for mobile and desktop.",
  deployment: "Deployment provider and budget need confirmation.",
  openQuestions: ["Which deployment provider should be used?"]
};

let directory;
let application;
let server;
let baseUrl;
let upstream;
let upstreamUrl;
let upstreamMode = "ok";
let upstreamAttempts = 0;
let seenAuthorization;
let seenCompletionBody;

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

before(async () => {
  upstream = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      if (upstreamMode === "model-401") return sendJson(response, 401, { error: "unauthorized" });
      if (upstreamMode === "model-invalid-json") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end("{not-json");
      }
      return sendJson(response, 200, { data: [{ id: "gods-test-model", owned_by: "test" }] });
    }
    if (request.url === "/v1/chat/completions") {
      upstreamAttempts += 1;
      seenAuthorization = request.headers.authorization;
      let raw = "";
      for await (const chunk of request) raw += chunk;
      seenCompletionBody = JSON.parse(raw);
      if (upstreamMode === "completion-401") return sendJson(response, 401, { error: "unauthorized" });
      if (upstreamMode === "rate-limit") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        return response.end(JSON.stringify({ error: "limited" }));
      }
      if (upstreamMode === "server-error") return sendJson(response, 503, { error: "unavailable" });
      if (upstreamMode === "completion-invalid-json") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end("{not-json");
      }
      if (upstreamMode === "malformed-discovery") {
        return sendJson(response, 200, { choices: [{ message: { content: "{}" } }] });
      }
      if (upstreamMode === "timeout") return;
      return sendJson(response, 200, {
        choices: [{ message: { content: JSON.stringify(discovery) } }],
        usage: { prompt_tokens: 12, completion_tokens: 34 }
      });
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  directory = await fs.mkdtemp(path.join(os.tmpdir(), "gods-provider-test-"));
  application = createServer({
    dataDir: directory,
    providerOptions: {
      encryptionKey: randomBytes(32),
      allowLocal: true,
      sleep: async () => {}
    }
  });
  server = application.server;
  await Promise.all([application.store.initialize(), application.authStore.initialize()]);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  if (application) await application.store.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

async function register(email) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password: "A-long-test-password-123!" })
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  return { cookie: response.headers.get("set-cookie").split(";")[0], user: body.user };
}

function authHeaders(account, extra = {}) {
  return { cookie: account.cookie, origin: baseUrl, ...extra };
}

async function createApprovedProject(account, prompt) {
  const created = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: JSON.stringify({ prompt })
  });
  assert.equal(created.status, 201);
  const { project } = await created.json();
  const approved = await fetch(`${baseUrl}/api/projects/${project.id}/approve`, {
    method: "POST",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: JSON.stringify({
      decisions: project.requirements.map((requirement) => ({
        id: requirement.id,
        text: requirement.text,
        approved: true
      }))
    })
  });
  assert.equal(approved.status, 200);
  const generated = await fetch(`${baseUrl}/api/projects/${project.id}/generate`, {
    method: "POST",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: "{}"
  });
  assert.equal(generated.status, 201);
  const result = await generated.json();
  return { project, task: result.tasks.find((task) => task.title.includes("Product Discovery")) };
}

test("SSRF endpoint policy rejects private addresses unless local-provider opt-in is explicit", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.1.2", "192.168.1.2", "::1", "fc00::1", "::ffff:7f00:1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  await assert.rejects(
    validateProviderEndpoint("https://127.0.0.1/v1"),
    (error) => error.code === "PRIVATE_PROVIDER_URL"
  );
  await assert.rejects(
    validateProviderEndpoint("https://api.openai.com/v1", {
      lookup: async () => [{ address: "10.0.0.2" }]
    }),
    (error) => error.code === "PRIVATE_PROVIDER_URL"
  );
  await assert.rejects(
    validateProviderEndpoint("https://untrusted.example.test/v1", {
      lookup: async () => [{ address: "8.8.8.8" }]
    }),
    (error) => error.code === "PROVIDER_HOST_NOT_SUPPORTED"
  );
  await assert.rejects(
    validateProviderEndpoint("http://provider.example.test/v1", {
      allowLocal: false,
      lookup: async () => [{ address: "8.8.8.8" }]
    }),
    (error) => error.code === "INSECURE_PROVIDER_URL"
  );
  assert.equal((await validateProviderEndpoint("http://127.0.0.1/v1", { allowLocal: true })).hostname, "127.0.0.1");
  assert.equal((await validateProviderEndpoint("https://api.openai.com/v1", {
    lookup: async () => [{ address: "8.8.8.8" }]
  })).hostname, "api.openai.com");
});

test("credential APIs encrypt secrets, redact responses, enforce ownership, audit writes, and read back", async () => {
  const owner = await register("provider-owner@example.com");
  const other = await register("provider-other@example.com");
  assert.equal((await fetch(`${baseUrl}/api/providers`)).status, 401);

  const crossOrigin = await fetch(`${baseUrl}/api/providers/openai-compatible/credential`, {
    method: "PUT",
    headers: { cookie: owner.cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: API_KEY, endpoint: upstreamUrl, model: "gods-test-model" })
  });
  assert.equal(crossOrigin.status, 403);

  const saved = await fetch(`${baseUrl}/api/providers/openai-compatible/credential`, {
    method: "PUT",
    headers: authHeaders(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ apiKey: API_KEY, endpoint: upstreamUrl, model: "gods-test-model" })
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.deepEqual(Object.keys(savedBody.provider).sort(), ["hasKey", "provider_id", "updated_at"]);
  assert.equal(savedBody.provider.hasKey, true);
  assert.equal(JSON.stringify(savedBody).includes(API_KEY), false);

  const listing = await fetch(`${baseUrl}/api/providers`, { headers: authHeaders(owner) });
  assert.equal(listing.status, 200);
  assert.deepEqual((await listing.json()).providers[0], savedBody.provider);
  const otherListing = await fetch(`${baseUrl}/api/providers`, { headers: authHeaders(other) });
  assert.equal((await otherListing.json()).providers[0].hasKey, false);

  const stored = await application.store.persistence.database.prepare(`
    SELECT ciphertext, iv, tag FROM provider_credentials WHERE owner_id = ?
  `).get(owner.user.id);
  assert.ok(stored.ciphertext && stored.iv && stored.tag);
  assert.equal(stored.ciphertext.includes(API_KEY), false);
  const rotatedKey = "rotated-provider-key-also-private";
  const rotated = await fetch(`${baseUrl}/api/providers/openai-compatible/credential`, {
    method: "PUT",
    headers: authHeaders(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ apiKey: rotatedKey, endpoint: upstreamUrl, model: "gods-test-model" })
  });
  assert.equal(rotated.status, 200);
  assert.equal(JSON.stringify(await rotated.json()).includes(rotatedKey), false);
  const rotatedStorage = await application.store.persistence.database.prepare(`
    SELECT ciphertext FROM provider_credentials WHERE owner_id = ?
  `).get(owner.user.id);
  assert.notEqual(rotatedStorage.ciphertext, stored.ciphertext);
  assert.equal(application.store.persistence.database.prepare(`
    SELECT COUNT(*) AS count FROM provider_credentials WHERE owner_id = ?
  `).get(owner.user.id).count, 1);
  assert.equal(application.store.persistence.database.prepare(`
    SELECT COUNT(*) AS count FROM provider_audit WHERE owner_id = ? AND action = 'credential-set'
  `).get(owner.user.id).count, 2);

  const deletedByOther = await fetch(`${baseUrl}/api/providers/openai-compatible/credential`, {
    method: "DELETE",
    headers: authHeaders(other, { "content-type": "application/json" }),
    body: "{}"
  });
  assert.equal(deletedByOther.status, 200);
  assert.equal((await application.store.getProviderCredential(owner.user.id, "openai-compatible")).ownerId, owner.user.id);
  const deleted = await fetch(`${baseUrl}/api/providers/openai-compatible/credential`, {
    method: "DELETE",
    headers: authHeaders(owner, { "content-type": "application/json" }),
    body: "{}"
  });
  assert.equal(deleted.status, 200);
  assert.equal((await application.store.getProviderCredential(owner.user.id, "openai-compatible")), null);
});

test("Product Discovery stays BLOCKED without a configured provider and persists the routing decision", async () => {
  const account = await register("provider-blocked@example.com");
  const unavailableModels = await fetch(`${baseUrl}/api/providers/openai-compatible/models`, {
    headers: authHeaders(account)
  });
  assert.equal(unavailableModels.status, 503);
  const unavailableBody = await unavailableModels.json();
  assert.equal(unavailableBody.status, "BLOCKED");
  assert.match(unavailableBody.reason, /provider/i);
  const unavailableHealth = await fetch(`${baseUrl}/api/providers/openai-compatible/health`, {
    method: "POST",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: "{}"
  });
  assert.equal(unavailableHealth.status, 503);
  assert.equal((await unavailableHealth.json()).status, "BLOCKED");
  const { project, task } = await createApprovedProject(account, "Build a trucking app for drivers and vehicles.");
  assert.ok(task);
  assert.equal(task.status, "QUEUED");

  const run = await fetch(`${baseUrl}/api/projects/${project.id}/tasks/${task.taskId}/run`, {
    method: "POST",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: "{}"
  });
  assert.equal(run.status, 503);
  const result = await run.json();
  assert.equal(result.task.status, "BLOCKED");
  assert.match(result.reason, /provider/i);
  const decisions = await fetch(`${baseUrl}/api/projects/${project.id}/routing-decisions`, {
    headers: authHeaders(account)
  });
  assert.equal(decisions.status, 200);
  const decisionBody = await decisions.json();
  assert.equal(decisionBody.decisions.length, 1);
  assert.equal(decisionBody.decisions[0].chosenProvider, null);
  assert.match(decisionBody.decisions[0].reason, /no configured provider/i);
  assert.equal((await fetch(`${baseUrl}/api/projects/${project.id}/routing-decisions`)).status, 401);
});

test("mock provider completes Product Discovery with validated output, usage, health, and read-back", async () => {
  const account = await register("provider-run@example.com");
  const saved = await fetch(`${baseUrl}/api/providers/openai-compatible/credential`, {
    method: "PUT",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: JSON.stringify({ apiKey: API_KEY, endpoint: upstreamUrl, model: "gods-test-model" })
  });
  assert.equal(saved.status, 200);

  const models = await fetch(`${baseUrl}/api/providers/openai-compatible/models`, { headers: authHeaders(account) });
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).models.map((model) => model.id), ["gods-test-model"]);
  const health = await fetch(`${baseUrl}/api/providers/openai-compatible/health`, {
    method: "POST",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: "{}"
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).health.ok, true);

  const { project, task } = await createApprovedProject(account, "Build a trucking app for drivers and vehicles.");
  upstreamAttempts = 0;
  const run = await fetch(`${baseUrl}/api/projects/${project.id}/tasks/${task.taskId}/run`, {
    method: "POST",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: "{}"
  });
  assert.equal(run.status, 200);
  const body = await run.json();
  assert.equal(body.task.status, "COMPLETED");
  assert.equal(body.task.result.status, "IMPLEMENTED_UNVERIFIED");
  assert.deepEqual(body.task.result.findings[0], discovery);
  assert.equal(upstreamAttempts, 1);
  assert.equal(seenAuthorization, "Bearer " + API_KEY);
  assert.equal(seenCompletionBody.response_format.json_schema.strict, true);
  assert.equal(JSON.stringify(body).includes(API_KEY), false);
  const request = application.store.persistence.database.prepare(`
    SELECT prompt_tokens AS promptTokens, completion_tokens AS completionTokens, status
    FROM model_requests WHERE project_id = ? AND task_id = ?
  `).get(project.id, task.taskId);
  assert.deepEqual({ ...request }, { promptTokens: 12, completionTokens: 34, status: "IMPLEMENTED_UNVERIFIED" });
  assert.equal(application.store.persistence.database.prepare(`
    SELECT COUNT(*) AS count FROM provider_audit
    WHERE owner_id = ? AND action = 'model-request'
  `).get(account.user.id).count, 1);
  const auditCount = application.store.persistence.database.prepare(`
    SELECT COUNT(*) AS count FROM provider_audit WHERE owner_id = ? AND action = 'health-check'
  `).get(account.user.id).count;
  assert.equal(auditCount, 1);
  const execution = await fetch(`${baseUrl}/api/projects/${project.id}/agent-executions`, { headers: authHeaders(account) });
  assert.equal(execution.status, 200);
  const discoveryRun = (await execution.json()).executions[0];
  assert.equal(discoveryRun.status, "COMPLETED");
  assert.equal(discoveryRun.modelProvider, "openai-compatible");
  assert.equal(discoveryRun.modelId, "gods-test-model");
});

test("OpenAI-compatible adapter maps auth, rate-limit, server, timeout, and invalid JSON responses", async () => {
  const adapter = new OpenAICompatibleAdapter({ allowLocal: true, sleep: async () => {} });
  const configuration = { apiKey: API_KEY, endpoint: upstreamUrl };
  const request = (timeoutMs = 1000, jsonSchema = null) => adapter.complete(configuration, {
    model: "gods-test-model",
    messages: [],
    jsonSchema,
    timeoutMs
  });

  upstreamMode = "completion-401";
  await assert.rejects(request(), (error) => error.code === "PROVIDER_AUTH_FAILED");
  upstreamMode = "rate-limit";
  upstreamAttempts = 0;
  await assert.rejects(request(), (error) => error.code === "PROVIDER_RATE_LIMITED");
  assert.equal(upstreamAttempts, 3);
  upstreamMode = "server-error";
  await assert.rejects(request(), (error) => error.code === "PROVIDER_UNAVAILABLE");
  upstreamMode = "completion-invalid-json";
  await assert.rejects(request(), (error) => error.code === "PROVIDER_INVALID_JSON");
  upstreamMode = "malformed-discovery";
  await assert.rejects(request(1000, PRODUCT_DISCOVERY_SCHEMA), (error) => error.code === "PROVIDER_INVALID_RESPONSE");
  upstreamMode = "timeout";
  await assert.rejects(request(30), (error) => error.code === "PROVIDER_TIMEOUT");
  upstreamMode = "ok";
});

test("model router deterministically selects a configured provider and records blocked decisions", async () => {
  const saved = [];
  const router = new ModelRouter({ recordModelRoutingDecision: async (decision) => saved.push(decision) });
  const selected = await router.choose({
    ownerId: "owner",
    projectId: "project",
    taskId: "task",
    inputs: { task_type: "product-discovery" },
    providers: [
      { providerId: "z-provider", model: "z-model", hasKey: true },
      { providerId: "a-provider", model: "a-model", hasKey: true }
    ]
  });
  assert.equal(selected.providerId, "a-provider");
  await assert.rejects(router.choose({
    ownerId: "owner",
    projectId: "project",
    taskId: "blocked-task",
    inputs: { task_type: "product-discovery" },
    providers: []
  }), (error) => error.code === "PROVIDER_BLOCKED");
  assert.equal(saved.length, 2);
  assert.equal(saved[1].providerId, null);
});

test("production server startup refuses to run without GODS_SECRET_KEY", () => {
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "-e",
    `require(${JSON.stringify(path.join(__dirname, "../server.js"))}).createServer({ dataDir: "/tmp/gods-no-secret-test" })`
  ], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", GODS_SECRET_KEY: "" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SECRET_KEY_MISSING|GODS_SECRET_KEY/);
});

test("workspace exposes encrypted provider settings and consent details", async () => {
  const html = await fetch(baseUrl).then((response) => response.text());
  assert.match(html, /Connect an AI provider/);
  assert.match(html, /provider-api-key/);
  assert.match(html, /Saving a key does not send project data/);
  const script = await fetch(`${baseUrl}/app.js`).then((response) => response.text());
  assert.match(script, /Run Product Discovery/);
  assert.match(script, /apiKey: data\.get\("apiKey"\)/);
});
