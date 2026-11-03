const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { SPECIALISTS } = require("../src/specialists");
const { parseYaml, toYaml, blueprintToYaml, yamlToBlueprint, validateBlueprint } = require("../src/blueprint-model");
const { analyze, applyFixes, format, lint } = require("../src/code-review");
const { createServer } = require("../server");

let directory;
let app;
let server;
let baseUrl;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "gods-studio-"));
  app = createServer({ dataDir: directory });
  server = app.server;
  await Promise.all([app.store.initialize(), app.authStore.initialize()]);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  await app.store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

async function call(cookie, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { origin: baseUrl, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* streaming or non-JSON */ }
  return { status: response.status, json, text };
}

async function register(email) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password: "A-long-test-password-123!" })
  });
  const user = (await response.json()).user;
  return { user, cookie: response.headers.get("set-cookie").split(";")[0] };
}

async function makeAdmin(email) {
  const account = await register(email);
  const record = await app.authStore.findUserByEmail(email);
  assert.ok(await app.authStore.promoteAdmin(record));
  return account;
}

test("exposes all 21 specialist agents with full definitions", () => {
  assert.equal(SPECIALISTS.length, 21);
  const names = ["Master Orchestrator", "Architect Agent", "Product Agent", "UI/UX Agent", "Frontend Agent", "Backend Agent",
    "Database Agent", "API Agent", "AI Engineer Agent", "Research Agent", "Coding Agent", "Refactoring Agent", "Security Agent",
    "QA Agent", "Browser Agent", "DevOps Agent", "Git Agent", "Game Agent", "Blockchain Agent", "Documentation Agent",
    "Independent Reviewer Agent"];
  assert.deepEqual(SPECIALISTS.map((agent) => agent.name), names);
  for (const agent of SPECIALISTS) {
    assert.ok(agent.identity && agent.systemInstructions.length > 50 && agent.model && agent.tools.length && agent.permissionScopes.length);
  }
});

test("YAML subset round-trips blueprint models and rejects bad input", () => {
  const { model, errors } = validateBlueprint({
    app: { name: "Todo: App", version: "1.0.0", description: "# not a comment" },
    components: [{ name: "List" }],
    pages: [{ name: "Home", path: "/", components: ["List"] }],
    routes: [{ method: "post", path: "/api/tasks", handler: "create", auth: true }],
    dataModels: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }]
  });
  assert.deepEqual(errors, []);
  const yaml = blueprintToYaml(model);
  assert.deepEqual(yamlToBlueprint(yaml).model, model);
  assert.deepEqual(parseYaml(toYaml({ a: [1, "x y", { b: true }], c: {} })), { a: [1, "x y", { b: true }], c: {} });
  assert.ok(validateBlueprint({ app: { name: "x" }, pages: [{ name: "P", path: "bad", components: ["Nope"] }] }).errors.length >= 2);
  assert.throws(() => parseYaml("a: 1\na: 2"), /Duplicate/);
});

test("review, lint and format engines find and fix issues with justifications", () => {
  const source = "var a = 1;\nif (a == 2) { eval(x) }\nconst apiKey = \"sk-abcdefghijk\";\n";
  const ids = analyze(source, { language: "js" }).map((finding) => finding.ruleId);
  assert.ok(["REF-VAR", "REF-LOOSE-EQ", "SEC-EVAL", "SEC-SECRET"].every((id) => ids.includes(id)));
  const fixed = applyFixes(source, { language: "js" });
  assert.match(fixed.code, /let a = 1;/);
  assert.match(fixed.code, /a === 2/);
  assert.ok(fixed.applied.every((entry) => entry.justification));
  assert.ok(lint("function (", { language: "js" }).diagnostics.some((item) => item.severity === "error"));
  assert.ok(lint("def f(x)\n  return x", { language: "py" }).diagnostics.some((item) => /':'/.test(item.message)));
  assert.equal(format('{"a":1}', { language: "json" }).code, '{\n  "a": 1\n}\n');
});

test("collaboration enforces roles on files, chat, and git", async () => {
  const owner = await register("owner@example.com");
  const editor = await register("editor@example.com");
  const viewer = await register("viewer@example.com");
  const outsider = await register("outsider@example.com");

  const created = await call(owner.cookie, "POST", "/api/projects", { prompt: "Customers book appointments. Staff manage schedules." });
  assert.equal(created.status, 201);
  const projectId = created.json.project.id;
  const base = `/api/studio/projects/${projectId}`;

  assert.equal((await call(outsider.cookie, "GET", `${base}/access`)).status, 404);
  assert.equal((await call(owner.cookie, "POST", `${base}/collaborators`, { email: "editor@example.com", role: "editor" })).status, 201);
  assert.equal((await call(owner.cookie, "POST", `${base}/collaborators`, { email: "viewer@example.com", role: "viewer" })).status, 201);
  assert.equal((await call(owner.cookie, "POST", `${base}/collaborators`, { email: "nobody@example.com", role: "viewer" })).status, 404);
  assert.equal((await call(editor.cookie, "POST", `${base}/collaborators`, { email: "outsider@example.com", role: "viewer" })).status, 403);

  const create = await call(editor.cookie, "POST", `${base}/file`, { path: "src/app.js", contents: "var x = 1;\nif (x == 1) {}\n" });
  assert.equal(create.status, 201);
  assert.equal((await call(viewer.cookie, "POST", `${base}/file`, { path: "src/b.js", contents: "1" })).status, 403);
  assert.equal((await call(viewer.cookie, "GET", `${base}/file?path=src/app.js`)).status, 200);
  assert.equal((await call(outsider.cookie, "GET", `${base}/file?path=src/app.js`)).status, 404);

  const review = await call(viewer.cookie, "POST", `${base}/review`, {});
  assert.equal(review.status, 200);
  assert.ok(review.json.summary.total >= 2);
  assert.equal((await call(viewer.cookie, "POST", `${base}/review/apply`, { path: "src/app.js", expectedVersion: 1 })).status, 403);
  const applied = await call(editor.cookie, "POST", `${base}/review/apply`, { path: "src/app.js", expectedVersion: 1 });
  assert.equal(applied.status, 200);
  assert.ok(applied.json.applied.length >= 2);
  assert.match(applied.json.artifact.contents, /let x = 1;/);

  // Git: commit, branch, diverge, merge
  assert.equal((await call(editor.cookie, "POST", `${base}/git/commit`, { message: "initial" })).status, 201);
  assert.equal((await call(editor.cookie, "POST", `${base}/git/commit`, { message: "again" })).status, 409);
  assert.equal((await call(editor.cookie, "POST", `${base}/git/branches`, { name: "feature" })).status, 201);
  assert.equal((await call(editor.cookie, "POST", `${base}/git/checkout`, { branch: "feature" })).status, 403);
  assert.equal((await call(owner.cookie, "POST", `${base}/git/checkout`, { branch: "feature" })).status, 200);
  await call(owner.cookie, "POST", `${base}/file`, { path: "src/feature.js", contents: "export const f = 1;\n" });
  assert.equal((await call(owner.cookie, "POST", `${base}/git/commit`, { message: "feature work" })).status, 201);
  assert.equal((await call(owner.cookie, "POST", `${base}/git/checkout`, { branch: "main" })).status, 200);
  const mainFiles = await call(owner.cookie, "GET", `${base}/files`);
  assert.ok(!mainFiles.json.files.some((file) => file.path === "src/feature.js"));
  const compare = await call(viewer.cookie, "GET", `${base}/git/compare?base=main&head=feature`);
  assert.deepEqual(compare.json.changes.map((change) => [change.path, change.status]), [["src/feature.js", "added"]]);
  assert.equal((await call(owner.cookie, "POST", `${base}/git/merge`, { source: "feature" })).json.status, "merged");
  const afterMerge = await call(owner.cookie, "GET", `${base}/files`);
  assert.ok(afterMerge.json.files.some((file) => file.path === "src/feature.js"));
  const git = await call(viewer.cookie, "GET", `${base}/git`);
  assert.equal(git.json.current, "main");
  assert.deepEqual(git.json.dirty, []);

  // Blueprint editor <-> artifact
  const bp = await call(editor.cookie, "GET", `${base}/blueprint`);
  assert.equal(bp.json.exists, false);
  bp.json.model.modules.push({ name: "Billing", description: "Invoices" });
  const saved = await call(editor.cookie, "PUT", `${base}/blueprint`, { model: bp.json.model, expectedVersion: 0 });
  assert.equal(saved.status, 200);
  const file = await call(viewer.cookie, "GET", `${base}/file?path=gods.blueprint.yaml`);
  assert.match(file.json.artifact.contents, /Billing/);
  const edited = file.json.artifact.contents.replace("Billing", "Payments");
  const viaYaml = await call(editor.cookie, "PUT", `${base}/blueprint`, { yaml: edited, expectedVersion: saved.json.version });
  assert.equal(viaYaml.json.model.modules[0].name, "Payments");
  assert.equal((await call(editor.cookie, "PUT", `${base}/blueprint`, { yaml: "pages: [", expectedVersion: viaYaml.json.version })).status, 422);

  // Shared conversation history + streaming
  const conversation = await call(owner.cookie, "POST", "/api/studio/conversations", { title: "Plan", projectId });
  assert.equal(conversation.status, 201);
  const convoUrl = `/api/studio/conversations/${conversation.json.conversation.id}/messages`;
  const stream = await call(owner.cookie, "POST", convoUrl, { content: "Build me a simple To-Do list app", agentId: "auto" });
  assert.equal(stream.status, 200);
  for (const event of ["meta", "plan", "delta", "done"]) assert.match(stream.text, new RegExp(`event: ${event}`));
  assert.doesNotMatch(stream.text, /event: step/);
  assert.match(stream.text, /"executed":false/);
  const sequences = [...stream.text.matchAll(/"sequence":(\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
  assert.ok([...stream.text.matchAll(/^id: [a-f0-9-]+:\d+$/gm)].length >= 4);
  assert.match(stream.text, /"mode":"local-deterministic"/);
  assert.equal((await call(viewer.cookie, "POST", convoUrl, { content: "hello there friend" })).status, 403);
  const history = await call(viewer.cookie, "GET", convoUrl);
  assert.equal(history.status, 200);
  assert.deepEqual(history.json.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal((await call(outsider.cookie, "GET", convoUrl)).status, 404);
  const activity = await call(viewer.cookie, "GET", `${base}/activity`);
  assert.ok(activity.json.activity.length >= 5);
});

test("agent command center lets users customise and reset agents", async () => {
  const user = await register("agents@example.com");
  const list = await call(user.cookie, "GET", "/api/studio/agents");
  assert.equal(list.json.agents.length, 21);
  const agent = list.json.agents.find((entry) => entry.id === "security");
  assert.equal((await call(user.cookie, "PUT", "/api/studio/agents/security", { instructions: "short" })).status, 400);
  assert.equal((await call(user.cookie, "PUT", "/api/studio/agents/security", { tools: ["not-a-tool"] })).status, 400);
  assert.equal((await call(user.cookie, "PUT", "/api/studio/agents/security", { instructions: "You are a strict security reviewer who explains every finding.", enabled: false })).status, 200);
  const changed = (await call(user.cookie, "GET", "/api/studio/agents")).json.agents.find((entry) => entry.id === "security");
  assert.equal(changed.status, "disabled");
  assert.match(changed.systemInstructions, /strict security reviewer/);
  const conversation = await call(user.cookie, "POST", "/api/studio/conversations", {});
  const blocked = await call(user.cookie, "POST", `/api/studio/conversations/${conversation.json.conversation.id}/messages`, { content: "audit my code", agentId: "security" });
  assert.equal(blocked.status, 409);
  await call(user.cookie, "DELETE", "/api/studio/agents/security");
  const reset = (await call(user.cookie, "GET", "/api/studio/agents")).json.agents.find((entry) => entry.id === "security");
  assert.equal(reset.systemInstructions, agent.systemInstructions);
  const tools = await call(user.cookie, "POST", "/api/studio/suggest", { text: "write a python script and test it" });
  assert.ok(tools.json.tools.length >= 1);
});

test("admin dashboard is admin-only and controls users, settings, payments, and deployment checks", async () => {
  const admin = await makeAdmin("gxqstudio@gmail.com");
  const member = await register("member@example.com");
  assert.equal((await call(member.cookie, "GET", "/api/admin/overview")).status, 403);
  assert.equal((await call(null, "GET", "/api/admin/overview")).status, 401);
  const overview = await call(admin.cookie, "GET", "/api/admin/overview");
  assert.equal(overview.status, 200);
  assert.ok(overview.json.summary.users >= 2);

  const users = (await call(admin.cookie, "GET", "/api/admin/users")).json.users;
  const target = users.find((entry) => entry.email === "member@example.com");
  assert.equal((await call(admin.cookie, "POST", `/api/admin/users/${admin.user.id}/disable`, {})).status, 409);
  assert.equal((await call(admin.cookie, "POST", `/api/admin/users/${target.id}/disable`, { reason: "test" })).status, 200);
  assert.equal((await call(member.cookie, "GET", "/api/studio/dashboard")).status, 401);
  const login = await call(null, "POST", "/api/auth/login", { email: "member@example.com", password: "A-long-test-password-123!" });
  assert.equal(login.status, 401);
  await call(admin.cookie, "POST", `/api/admin/users/${target.id}/enable`, {});
  const relogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email: "member@example.com", password: "A-long-test-password-123!" })
  });
  assert.equal(relogin.status, 200);
  member.cookie = relogin.headers.get("set-cookie").split(";")[0];

  assert.equal((await call(admin.cookie, "PUT", "/api/admin/settings", { chatRatePerHour: 0 })).status, 400);
  assert.equal((await call(admin.cookie, "PUT", "/api/admin/settings", { registrationOpen: false, announcement: "Hello" })).status, 200);
  assert.equal((await call(null, "POST", "/api/auth/register", { email: "late@example.com", password: "A-long-test-password-123!" })).status, 403);
  assert.equal((await call(null, "GET", "/api/studio/public")).json.registrationOpen, false);
  await call(admin.cookie, "PUT", "/api/admin/settings", { registrationOpen: true });

  const payment = await call(admin.cookie, "POST", "/api/admin/payments", { email: "member@example.com", plan: "pro", amountCents: 1900, currency: "USD", status: "paid" });
  assert.equal(payment.status, 201);
  assert.equal((await call(admin.cookie, "GET", "/api/admin/payments")).json.totals.paidCents, 1900);
  assert.equal((await call(admin.cookie, "POST", `/api/admin/payments/${payment.json.id}/status`, { status: "refunded" })).status, 200);

  assert.equal((await call(admin.cookie, "PUT", "/api/admin/agents/qa", { model: "bad model!" })).status, 400);
  assert.equal((await call(admin.cookie, "PUT", "/api/admin/agents/qa", { model: "gpt-test" })).status, 200);
  assert.equal((await call(member.cookie, "GET", "/api/studio/agents")).json.agents.find((entry) => entry.id === "qa").model, "gpt-test");

  const run = await call(admin.cookie, "POST", "/api/admin/deployment/run", { action: "preflight" });
  assert.equal(run.status, 200);
  assert.equal(run.json.status, "BLOCKED");
  assert.equal((await call(admin.cookie, "POST", "/api/admin/deployment/run", { action: "rm -rf" })).status, 400);
  assert.ok((await call(admin.cookie, "GET", "/api/admin/audit")).json.audit.length >= 5);
  assert.equal((await call(admin.cookie, "GET", "/api/admin/api")).status, 200);
  assert.equal((await call(admin.cookie, "GET", "/api/admin/security")).status, 200);
});
