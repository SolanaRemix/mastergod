const { spawn } = require("node:child_process");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { ProviderError, sanitizeError } = require("./providers");
const { SPECIALISTS, SCOPES, TOOL_CATALOG, getSpecialist, mergeAgentConfig, suggestAgent, suggestTools } = require("./specialists");
const { analyze, applyFixes, format, lint, normalizeLanguage, summarize } = require("./code-review");
const { blueprintToYaml, defaultBlueprint, validateBlueprint, yamlToBlueprint } = require("./blueprint-model");
const { buildMessages, chunk, decompose, localReply } = require("./chat");
const { hasRole } = require("./studio-store");
const { validateArtifactPath } = require("./artifacts");
const { inlineProjectAssets } = require("./project-preview");
const { verifyProjectArtifacts } = require("./services/StaticBuildService");

const BLUEPRINT_PATH = "gods.blueprint.yaml";
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const MAX_FILE_BYTES = 256 * 1024;
const SCRIPTS_ROOT = path.join(__dirname, "..", "scripts");
const DEPLOY_ENV = ["GODS_DEPLOY_HOST", "GODS_DEPLOY_USER", "GODS_DEPLOY_KEY", "GODS_DEPLOY_KNOWN_HOSTS", "GODS_DEPLOY_PATH", "GODS_DEPLOY_HEALTH_URL"];

class StudioHub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.presence = new Map();
    this.running = new Map();
  }

  join(projectId, user) {
    const room = this.presence.get(projectId) || new Map();
    const entry = room.get(user.id) || { email: user.email, connections: 0 };
    entry.connections += 1;
    room.set(user.id, entry);
    this.presence.set(projectId, room);
    this.publish(projectId, { type: "presence", users: this.users(projectId) });
  }

  leave(projectId, user) {
    const room = this.presence.get(projectId);
    const entry = room?.get(user.id);
    if (!entry) return;
    entry.connections -= 1;
    if (entry.connections <= 0) room.delete(user.id);
    if (!room.size) this.presence.delete(projectId);
    this.publish(projectId, { type: "presence", users: this.users(projectId) });
  }

  users(projectId) {
    return [...(this.presence.get(projectId)?.values() || [])].map((entry) => entry.email);
  }

  publish(projectId, event) {
    this.emit(projectId, event);
  }

  begin(key) {
    this.running.set(key, (this.running.get(key) || 0) + 1);
  }

  end(key) {
    const next = (this.running.get(key) || 1) - 1;
    if (next <= 0) this.running.delete(key);
    else this.running.set(key, next);
  }
}

function createStudioRouter({ store, studio, auth, providerService, helpers, sessionCookieName }) {
  const { sendJson, readJson, getCookie, isSameOrigin, createRateLimiter } = helpers;
  const hub = new StudioHub();
  const allowTools = createRateLimiter({ limit: 600, windowMs: 60 * 60 * 1000 });
  const allowAdmin = createRateLimiter({ limit: 300, windowMs: 60 * 60 * 1000 });
  const allowDeployAction = createRateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });

  const fail = (response, status, error) => sendJson(response, status, { error });
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

  async function resolveAgents(user) {
    const [globalConfigs, userConfigs] = await Promise.all([
      studio.getAgentConfigs("global"), studio.getAgentConfigs(`user:${user.id}`)
    ]);
    return SPECIALISTS.map((agent) => {
      const withGlobal = mergeAgentConfig(agent, globalConfigs.get(agent.id));
      const merged = userConfigs.has(agent.id)
        ? mergeAgentConfig({ ...withGlobal, tools: withGlobal.tools, systemInstructions: withGlobal.systemInstructions }, userConfigs.get(agent.id))
        : withGlobal;
      return { ...merged, customized: merged.customized || withGlobal.customized, globallyCustomized: globalConfigs.has(agent.id) };
    });
  }

  function validateAgentConfig(agent, body) {
    if (!isObject(body)) return { error: "Provide a JSON object." };
    const config = {};
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== "string" || body.instructions.trim().length < 20 || body.instructions.length > 4000) {
        return { error: "Instructions must be between 20 and 4000 characters." };
      }
      config.instructions = body.instructions.trim();
    }
    if (body.model !== undefined) {
      if (typeof body.model !== "string" || (body.model !== "provider-default" && !MODEL_PATTERN.test(body.model))) {
        return { error: "Model must be 'provider-default' or a valid model identifier." };
      }
      config.model = body.model;
    }
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools) || body.tools.some((tool) => typeof tool !== "string" || !agent.tools.includes(tool))) {
        return { error: `Tools must be a subset of: ${agent.tools.join(", ")}.` };
      }
      config.tools = body.tools;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return { error: "enabled must be true or false." };
      config.enabled = body.enabled;
    }
    return { config };
  }

  function sse(response) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff"
    });
    const streamId = randomUUID();
    let sequence = 0;
    return (event, data) => {
      if (response.writableEnded) return;
      sequence += 1;
      const eventId = `${streamId}:${sequence}`;
      const payload = {
        ...data,
        eventId,
        sequence,
        timestamp: new Date().toISOString()
      };
      response.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
  }

  async function snapshot(projectId, ownerId) {
    const tree = await store.listArtifacts(projectId, ownerId);
    const files = {};
    let total = 0;
    for (const entry of tree?.files || []) {
      const artifact = await store.readArtifact(projectId, ownerId, entry.path);
      if (!artifact) continue;
      total += artifact.sizeBytes;
      if (total > 4 * 1024 * 1024) throw Object.assign(new Error("Project is too large to snapshot (4 MiB limit)."), { status: 413 });
      files[artifact.path] = { contents: artifact.contents, language: artifact.language };
    }
    return files;
  }

  async function applySnapshot(projectId, ownerId, target) {
    const tree = await store.listArtifacts(projectId, ownerId);
    const current = new Map((tree?.files || []).map((entry) => [entry.path, entry]));
    for (const [filePath, file] of Object.entries(target)) {
      const existing = current.get(filePath);
      if (!existing) {
        await store.createArtifact(projectId, ownerId, filePath, file.contents, file.language || "text");
      } else {
        const artifact = await store.readArtifact(projectId, ownerId, filePath);
        if (artifact.contents !== file.contents) {
          await store.writeArtifact(projectId, ownerId, filePath, file.contents, artifact.version, "Restored from project history.");
        }
      }
    }
    for (const [filePath, entry] of current) {
      if (target[filePath]) continue;
      try {
        await store.deleteArtifact(projectId, ownerId, filePath, entry.version);
      } catch (error) {
        if (error.code !== "PROTECTED_ARTIFACT") throw error;
      }
    }
  }

  const sameFiles = (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (a[key]?.contents !== b[key]?.contents) return false;
    return true;
  };

  function diffFiles(base, head) {
    const changes = [];
    for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
      if (!base[key]) changes.push({ path: key, status: "added", lines: head[key].contents.split("\n").length });
      else if (!head[key]) changes.push({ path: key, status: "removed", lines: base[key].contents.split("\n").length });
      else if (base[key].contents !== head[key].contents) {
        const before = base[key].contents.split("\n");
        const after = head[key].contents.split("\n");
        let common = 0;
        const set = new Map();
        for (const line of before) set.set(line, (set.get(line) || 0) + 1);
        for (const line of after) if (set.get(line) > 0) { common += 1; set.set(line, set.get(line) - 1); }
        changes.push({ path: key, status: "modified", added: after.length - common, removed: before.length - common });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function ancestors(projectId, startId) {
    const seen = new Set();
    const queue = startId ? [startId] : [];
    while (queue.length && seen.size < 5000) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const commit = await studio.getCommit(projectId, id);
      if (commit?.parentId) queue.push(commit.parentId);
      if (commit?.mergeParentId) queue.push(commit.mergeParentId);
    }
    return seen;
  }

  async function mergeBase(projectId, aId, bId) {
    const aSet = await ancestors(projectId, aId);
    const seen = new Set();
    const queue = bId ? [bId] : [];
    while (queue.length && seen.size < 5000) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      if (aSet.has(id)) return id;
      const commit = await studio.getCommit(projectId, id);
      if (commit?.parentId) queue.push(commit.parentId);
      if (commit?.mergeParentId) queue.push(commit.mergeParentId);
    }
    return null;
  }

  function threeWay(base, ours, theirs) {
    const merged = {};
    const conflicts = [];
    for (const key of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
      const b = base[key]?.contents;
      const o = ours[key]?.contents;
      const t = theirs[key]?.contents;
      let pick;
      if (o === t) pick = ours[key];
      else if (o === b) pick = theirs[key];
      else if (t === b) pick = ours[key];
      else {
        conflicts.push(key);
        continue;
      }
      if (pick) merged[key] = pick;
    }
    return { merged, conflicts };
  }

  async function handleProject(request, response, url, user, session) {
    const match = /^\/api\/studio\/projects\/([a-f0-9]{32})\/([a-z-]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
    if (!match) return false;
    const [, projectId, section, sub] = match;
    const access = await studio.projectAccess(projectId, user);
    if (!access) return fail(response, 404, "Project not found."), true;
    const { project, role } = access;
    const ownerId = project.ownerId;
    const method = request.method;
    const need = (minimum) => {
      if (hasRole(role, minimum)) return true;
      fail(response, 403, `Your ${role} role cannot do this; ${minimum} access is required.`);
      return false;
    };
    const record = async (kind, summary) => {
      const event = await studio.logActivity(projectId, user, kind, summary);
      hub.publish(projectId, { type: "activity", activity: event });
    };

    if (section === "access" && method === "GET") {
      sendJson(response, 200, { role, project: { id: project.id, title: project.title, status: project.status }, collaborators: await studio.listCollaborators(projectId) });
      return true;
    }

    if (section === "collaborators") {
      if (method === "GET") {
        sendJson(response, 200, { role, collaborators: await studio.listCollaborators(projectId), roles: ["viewer", "editor", "admin"] });
        return true;
      }
      if (!need("admin")) return true;
      if (method === "POST") {
        const body = await readJson(request);
        if (!isObject(body) || typeof body.email !== "string") return fail(response, 400, "Provide an email and role."), true;
        if (body.role === "admin" && role !== "owner") return fail(response, 403, "Only the owner can grant the admin role."), true;
        const invited = await studio.invite(projectId, ownerId, body.email, body.role, user.id);
        await record("collaboration", `${user.email} added ${invited.email} as ${invited.role}.`);
        sendJson(response, 201, { collaborator: invited });
        return true;
      }
      if (method === "DELETE" && sub) {
        const existing = (await studio.listCollaborators(projectId)).find((entry) => entry.userId === sub);
        if (existing?.role === "admin" && role !== "owner") return fail(response, 403, "Only the owner can remove an admin."), true;
        if (!await studio.removeCollaborator(projectId, sub)) return fail(response, 404, "Collaborator not found."), true;
        await record("collaboration", `${user.email} removed a collaborator.`);
        sendJson(response, 200, { status: "removed" });
        return true;
      }
    }

    if (section === "activity" && method === "GET") {
      sendJson(response, 200, { activity: await studio.listActivity(projectId), online: hub.users(projectId) });
      return true;
    }

    if (section === "stream" && method === "GET") {
      const send = sse(response);
      send("ready", { role, online: hub.users(projectId) });
      const listener = (event) => send(event.type, event);
      hub.on(projectId, listener);
      hub.join(projectId, user);
      const ping = setInterval(() => response.write(": ping\n\n"), 25000);
      const stopAt = setTimeout(() => response.end(), Math.max(1000, Date.parse(session.expiresAt) - Date.now()));
      request.on("close", () => {
        clearInterval(ping);
        clearTimeout(stopAt);
        hub.off(projectId, listener);
        hub.leave(projectId, user);
      });
      return true;
    }

    if (section === "files") {
      if (method === "GET") {
        const tree = await store.listArtifacts(projectId, ownerId);
        sendJson(response, 200, { ...tree, role });
        return true;
      }
    }

    if (section === "file") {
      const filePath = url.searchParams.get("path");
      if (method === "GET") {
        if (!filePath) return fail(response, 400, "Choose a file path."), true;
        const artifact = await store.readArtifact(projectId, ownerId, validateArtifactPath(filePath));
        if (!artifact) return fail(response, 404, "File not found."), true;
        sendJson(response, 200, { artifact, role });
        return true;
      }
      if (!need("editor")) return true;
      if (!allowTools(user.id)) return fail(response, 429, "File activity limit reached. Try again later."), true;
      if (method === "PUT") {
        const body = await readJson(request, MAX_FILE_BYTES + 4096);
        if (!filePath || !isObject(body) || typeof body.contents !== "string" || !Number.isInteger(body.expectedVersion)
          || Buffer.byteLength(body.contents) > MAX_FILE_BYTES) {
          return fail(response, 400, "Provide a path, contents (up to 256 KiB), and the version you opened."), true;
        }
        const artifact = await store.writeArtifact(projectId, ownerId, filePath, body.contents, body.expectedVersion, `Saved by ${user.email}.`);
        if (!artifact) return fail(response, 404, "File not found."), true;
        await record("file", `${user.email} saved ${artifact.path} (v${artifact.version}).`);
        sendJson(response, 200, { artifact });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request, MAX_FILE_BYTES + 4096);
        if (!isObject(body) || typeof body.path !== "string" || typeof body.contents !== "string" || Buffer.byteLength(body.contents) > MAX_FILE_BYTES) {
          return fail(response, 400, "Provide a safe project-relative path and text contents (up to 256 KiB)."), true;
        }
        const artifact = await store.createArtifact(projectId, ownerId, body.path, body.contents,
          typeof body.language === "string" ? body.language : body.path.split(".").pop() || "text");
        await record("file", `${user.email} created ${artifact.path}.`);
        sendJson(response, 201, { artifact });
        return true;
      }
      if (method === "DELETE") {
        const version = Number(url.searchParams.get("version"));
        if (!filePath || !Number.isInteger(version)) return fail(response, 400, "Provide the path and current version."), true;
        if (!await store.deleteArtifact(projectId, ownerId, filePath, version)) return fail(response, 404, "File not found."), true;
        await record("file", `${user.email} deleted ${filePath}.`);
        sendJson(response, 200, { deleted: true });
        return true;
      }
    }

    if (section === "preview" && method === "GET") {
      const entryPath = url.searchParams.get("entry");
      if (!entryPath) return fail(response, 400, "Choose an HTML file to preview."), true;
      const entry = await store.readArtifact(projectId, ownerId, validateArtifactPath(entryPath));
      if (!entry) return fail(response, 404, "HTML file not found."), true;
      const preview = await inlineProjectAssets(entry.path, entry.contents, (artifactPath) => store.readArtifact(projectId, ownerId, artifactPath));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'self'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store"
      });
      response.end(preview.html);
      return true;
    }

    if (section === "build" && method === "POST") {
      if (!need("editor")) return true;
      if (!allowTools(user.id)) return fail(response, 429, "Build check limit reached."), true;
      hub.publish(projectId, { type: "build", status: "running", by: user.email });
      const files = await snapshot(projectId, ownerId);
      const artifacts = [];
      for (const filePath of Object.keys(files)) artifacts.push(await store.readArtifact(projectId, ownerId, filePath));
      const report = verifyProjectArtifacts(artifacts);
      const build = await store.createBuild(projectId, ownerId, report);
      hub.publish(projectId, { type: "build", status: report.status, by: user.email });
      await record("build", `${user.email} ran a build check: ${report.status}.`);
      sendJson(response, 201, { build, status: report.status });
      return true;
    }

    if (section === "review") {
      if (!need(sub === "apply" ? "editor" : "viewer")) return true;
      if (!allowTools(user.id)) return fail(response, 429, "Review limit reached."), true;
      if (method === "POST" && !sub) {
        const body = await readJson(request);
        const tree = await store.listArtifacts(projectId, ownerId);
        const wanted = typeof body?.path === "string" ? [body.path] : tree.files.map((file) => file.path).slice(0, 200);
        const reports = [];
        for (const filePath of wanted) {
          const artifact = await store.readArtifact(projectId, ownerId, filePath);
          if (!artifact) continue;
          const findings = analyze(artifact.contents, { language: artifact.language, path: artifact.path });
          if (findings.length) reports.push({ path: artifact.path, version: artifact.version, summary: summarize(findings), findings: findings.slice(0, 200) });
        }
        const all = reports.flatMap((entry) => entry.findings);
        await record("review", `${user.email} ran code review: ${all.length} finding(s).`);
        sendJson(response, 200, {
          agents: ["refactoring", "security"],
          summary: summarize(all),
          reports,
          note: "Findings come from deterministic static rules; they are suggestions, not proof of exploitability. Automatic fixes are limited to low-risk, behaviour-preserving edits and are applied only on request."
        });
        return true;
      }
      if (method === "POST" && sub === "apply") {
        const body = await readJson(request);
        if (!isObject(body) || typeof body.path !== "string" || !Number.isInteger(body.expectedVersion)
          || (body.ruleIds !== undefined && (!Array.isArray(body.ruleIds) || body.ruleIds.some((id) => typeof id !== "string")))) {
          return fail(response, 400, "Provide a path, expectedVersion, and optional ruleIds."), true;
        }
        const artifact = await store.readArtifact(projectId, ownerId, body.path);
        if (!artifact) return fail(response, 404, "File not found."), true;
        const result = applyFixes(artifact.contents, { language: artifact.language, path: artifact.path, ruleIds: body.ruleIds || null });
        if (!result.applied.length) {
          sendJson(response, 200, { applied: [], artifact, message: "No automatic fixes were applicable." });
          return true;
        }
        const written = await store.writeArtifact(projectId, ownerId, body.path, result.code, body.expectedVersion,
          `Applied ${result.applied.length} reviewed fix(es) by ${user.email}.`);
        await record("review", `${user.email} applied ${result.applied.length} automatic fix(es) to ${body.path}.`);
        sendJson(response, 200, { applied: result.applied, artifact: written });
        return true;
      }
    }

    if (section === "blueprint") {
      if (method === "GET") {
        const artifact = await store.readArtifact(projectId, ownerId, BLUEPRINT_PATH);
        if (!artifact) {
          const model = defaultBlueprint(project.title || "My App");
          sendJson(response, 200, { exists: false, version: 0, yaml: blueprintToYaml(model), model, errors: [], role });
          return true;
        }
        try {
          const { model, errors } = yamlToBlueprint(artifact.contents);
          sendJson(response, 200, { exists: true, version: artifact.version, yaml: artifact.contents, model, errors, role });
        } catch (error) {
          sendJson(response, 200, { exists: true, version: artifact.version, yaml: artifact.contents, model: null, errors: [error.message], role });
        }
        return true;
      }
      if (method === "PUT") {
        if (!need("editor")) return true;
        const body = await readJson(request, MAX_FILE_BYTES + 4096);
        if (!isObject(body) || !Number.isInteger(body.expectedVersion)) return fail(response, 400, "Provide yaml or model, and expectedVersion."), true;
        let model;
        let errors;
        if (typeof body.yaml === "string") ({ model, errors } = yamlToBlueprint(body.yaml));
        else if (isObject(body.model)) ({ model, errors } = validateBlueprint(body.model));
        else return fail(response, 400, "Provide yaml or model."), true;
        if (errors.length) return sendJson(response, 422, { error: "The blueprint has validation errors.", errors }), true;
        const yaml = blueprintToYaml(model);
        const artifact = body.expectedVersion === 0
          ? await store.createArtifact(projectId, ownerId, BLUEPRINT_PATH, yaml, "yaml")
          : await store.writeArtifact(projectId, ownerId, BLUEPRINT_PATH, yaml, body.expectedVersion, `Blueprint edited by ${user.email}.`);
        await record("blueprint", `${user.email} updated ${BLUEPRINT_PATH}.`);
        sendJson(response, 200, { exists: true, version: artifact.version, yaml, model, errors: [] });
        return true;
      }
    }

    if (section === "git") {
      if (method === "GET" && !sub) {
        const branches = await studio.listBranches(projectId, user.email);
        const current = branches.find((branch) => branch.isCurrent) || branches[0];
        const head = current.headId ? await studio.getCommit(projectId, current.headId) : null;
        const working = await snapshot(projectId, ownerId);
        sendJson(response, 200, {
          role, branches, current: current.name, commits: await studio.listCommits(projectId),
          dirty: head ? diffFiles(head.files, working) : diffFiles({}, working)
        });
        return true;
      }
      if (method === "GET" && sub === "compare") {
        const base = await studio.getBranch(projectId, url.searchParams.get("base") || "");
        const head = await studio.getBranch(projectId, url.searchParams.get("head") || "");
        if (!base || !head) return fail(response, 404, "Branch not found."), true;
        const baseCommit = base.headId ? await studio.getCommit(projectId, base.headId) : null;
        const headCommit = head.headId ? await studio.getCommit(projectId, head.headId) : null;
        const changes = diffFiles(baseCommit?.files || {}, headCommit?.files || {});
        const filePath = url.searchParams.get("path");
        sendJson(response, 200, {
          changes,
          ...(filePath ? { before: baseCommit?.files[filePath]?.contents ?? null, after: headCommit?.files[filePath]?.contents ?? null } : {})
        });
        return true;
      }
      if (!need("editor")) return true;
      if (!allowTools(user.id)) return fail(response, 429, "Git activity limit reached."), true;
      const body = method === "POST" ? await readJson(request) : {};
      if (method === "POST" && sub === "commit") {
        const message = typeof body?.message === "string" ? body.message.trim().slice(0, 200) : "";
        if (!message) return fail(response, 400, "Write a commit message."), true;
        const current = await studio.currentBranch(projectId, user.email);
        const files = await snapshot(projectId, ownerId);
        const head = current.headId ? await studio.getCommit(projectId, current.headId) : null;
        if (head && sameFiles(head.files, files)) return fail(response, 409, "Nothing to commit; the working files match the branch head."), true;
        const commit = await studio.createCommit(projectId, { branch: current.name, parentId: current.headId, message, authorEmail: user.email, files });
        await record("git", `${user.email} committed to ${current.name}: ${message}`);
        sendJson(response, 201, { commit });
        return true;
      }
      if (method === "POST" && sub === "branches") {
        if (typeof body?.name !== "string" || !BRANCH_PATTERN.test(body.name) || body.name.includes("..")) {
          return fail(response, 400, "Branch names use letters, digits, '.', '_', '-', '/' (max 64)."), true;
        }
        const from = typeof body.from === "string" ? body.from : (await studio.currentBranch(projectId, user.email)).name;
        await studio.createBranch(projectId, body.name, from, user.email);
        await record("git", `${user.email} created branch ${body.name} from ${from}.`);
        sendJson(response, 201, { branch: body.name });
        return true;
      }
      if (method === "POST" && sub === "checkout") {
        if (!need("admin")) return true;
        const target = await studio.getBranch(projectId, String(body?.branch || ""));
        if (!target) return fail(response, 404, "Branch not found."), true;
        const current = await studio.currentBranch(projectId, user.email);
        const head = current.headId ? await studio.getCommit(projectId, current.headId) : null;
        const working = await snapshot(projectId, ownerId);
        if (target.name !== current.name && (head ? !sameFiles(head.files, working) : Object.keys(working).length > 0) && !body.discard) {
          return fail(response, 409, "You have uncommitted changes. Commit them first, or confirm discarding them."), true;
        }
        const commit = target.headId ? await studio.getCommit(projectId, target.headId) : null;
        await applySnapshot(projectId, ownerId, commit?.files || {});
        await studio.setCurrentBranch(projectId, target.name);
        await record("git", `${user.email} switched to branch ${target.name}.`);
        sendJson(response, 200, { current: target.name });
        return true;
      }
      if (method === "POST" && sub === "merge") {
        if (!need("admin")) return true;
        const current = await studio.currentBranch(projectId, user.email);
        const source = await studio.getBranch(projectId, String(body?.source || ""));
        if (!source) return fail(response, 404, "Source branch not found."), true;
        if (source.name === current.name) return fail(response, 409, "Choose a different branch to merge."), true;
        const headCommit = current.headId ? await studio.getCommit(projectId, current.headId) : null;
        const working = await snapshot(projectId, ownerId);
        if (headCommit ? !sameFiles(headCommit.files, working) : Object.keys(working).length) {
          return fail(response, 409, "Commit or discard working changes before merging."), true;
        }
        if (!source.headId) return fail(response, 409, "The source branch has no commits."), true;
        const sourceCommit = await studio.getCommit(projectId, source.headId);
        const baseId = await mergeBase(projectId, current.headId, source.headId);
        if (baseId === source.headId) {
          sendJson(response, 200, { status: "up-to-date" });
          return true;
        }
        let commit;
        if (!current.headId || baseId === current.headId) {
          commit = await studio.createCommit(projectId, {
            branch: current.name, parentId: current.headId, mergeParentId: source.headId,
            message: `Fast-forward merge of ${source.name}`, authorEmail: user.email, files: sourceCommit.files
          });
          await applySnapshot(projectId, ownerId, sourceCommit.files);
        } else {
          const base = baseId ? (await studio.getCommit(projectId, baseId)).files : {};
          const { merged, conflicts } = threeWay(base, headCommit.files, sourceCommit.files);
          if (conflicts.length) {
            return sendJson(response, 409, { error: "Merge conflicts must be resolved manually.", conflicts }), true;
          }
          commit = await studio.createCommit(projectId, {
            branch: current.name, parentId: current.headId, mergeParentId: source.headId,
            message: `Merge ${source.name} into ${current.name}`, authorEmail: user.email, files: merged
          });
          await applySnapshot(projectId, ownerId, merged);
        }
        await record("git", `${user.email} merged ${source.name} into ${current.name}.`);
        sendJson(response, 200, { status: "merged", commit });
        return true;
      }
    }
    return false;
  }

  async function handleChat(request, response, url, user) {
    const settings = await studio.getSettings();
    const list = url.pathname === "/api/studio/conversations";
    if (list && request.method === "GET") {
      sendJson(response, 200, { conversations: await studio.listConversations(user) });
      return true;
    }
    if (list && request.method === "POST") {
      const body = await readJson(request);
      let projectId = null;
      if (typeof body?.projectId === "string" && body.projectId) {
        const access = await studio.projectAccess(body.projectId, user);
        if (!access || !hasRole(access.role, "editor")) return fail(response, 403, "You need editor access to chat in that project."), true;
        projectId = body.projectId;
      }
      const conversation = await studio.createConversation(user, { title: body?.title, projectId });
      sendJson(response, 201, { conversation });
      return true;
    }
    const match = /^\/api\/studio\/conversations\/([a-f0-9]{32})(?:\/(messages))?$/.exec(url.pathname);
    if (!match) return false;
    const conversation = await studio.getConversation(match[1], user);
    if (!conversation) return fail(response, 404, "Conversation not found."), true;
    if (!match[2]) {
      if (request.method === "DELETE") {
        if (conversation.role !== "owner") return fail(response, 403, "Only the conversation owner can delete it."), true;
        await studio.deleteConversation(conversation.id, user.id);
        sendJson(response, 200, { deleted: true });
        return true;
      }
      return false;
    }
    if (request.method === "GET") {
      sendJson(response, 200, { conversation, messages: await studio.listMessages(conversation.id) });
      return true;
    }
    if (request.method !== "POST") return false;
    if (!hasRole(conversation.role, "editor")) return fail(response, 403, "Viewers can read but not post to this conversation."), true;
    if (settings.maintenanceMode && user.role !== "admin") return fail(response, 503, "The studio is in maintenance mode."), true;
    const used = await studio.countMessagesSince(user.id, new Date(Date.now() - 3600000).toISOString());
    if (used >= Number(settings.chatRatePerHour)) return fail(response, 429, "Hourly message limit reached."), true;

    const body = await readJson(request, 1024 * 1024);
    if (!isObject(body) || typeof body.content !== "string" || !body.content.trim() || body.content.length > 10000) {
      return fail(response, 400, "Write a message of up to 10,000 characters."), true;
    }
    const attachments = [];
    if (body.attachments !== undefined) {
      if (!Array.isArray(body.attachments) || body.attachments.length > 5) return fail(response, 400, "Attach at most 5 files."), true;
      for (const file of body.attachments) {
        if (!isObject(file) || typeof file.name !== "string" || !file.name || file.name.length > 160
          || (file.content !== undefined && (typeof file.content !== "string" || file.content.length > 100000))) {
          return fail(response, 400, "Each attachment needs a name and text content up to 100,000 characters."), true;
        }
        attachments.push({
          name: file.name.replace(/[^\w.\- ]/g, "_"), type: typeof file.type === "string" ? file.type.slice(0, 100) : "",
          size: Number.isFinite(file.size) ? file.size : 0, content: file.content
        });
      }
    }
    const agents = await resolveAgents(user);
    let agent = body.agentId && body.agentId !== "auto" ? agents.find((entry) => entry.id === body.agentId) : null;
    if (body.agentId && body.agentId !== "auto" && !agent) return fail(response, 400, "Unknown agent."), true;
    if (!agent) agent = agents.find((entry) => entry.id === suggestAgent(body.content).id);
    if (!agent.enabled) return fail(response, 409, `${agent.name} is disabled. Enable it in the Agent Command Center.`), true;
    let model = typeof body.model === "string" && body.model ? body.model : agent.model;
    if (model !== "local" && model !== "provider-default" && model !== "auto" && !MODEL_PATTERN.test(model)) {
      return fail(response, 400, "Unknown model."), true;
    }

    const history = await studio.listMessages(conversation.id, 40);
    const userMessageId = await studio.addMessage(conversation.id, {
      authorId: user.id, authorEmail: user.email, role: "user", content: body.content.trim(), attachments
    });
    const useProvider = model !== "local" && settings.allowProviderChat && await providerService.hasConfiguration(user.id);
    const projectId = conversation.projectId;
    const send = sse(response);
    const abort = new AbortController();
    let finished = false;
    response.on("close", () => { if (!finished) abort.abort(); });
    const publish = (event) => projectId && hub.publish(projectId, { conversationId: conversation.id, ...event });
    const runKey = `${user.id}:${agent.id}`;
    if (useProvider) hub.begin(runKey);

    const steps = decompose(body.content, agent);
    send("meta", { conversationId: conversation.id, userMessageId, agent: { id: agent.id, name: agent.name }, mode: useProvider ? "provider" : "local-deterministic", model: useProvider ? (model === "provider-default" || model === "auto" ? "provider-default" : model) : "local" });
    send("plan", {
      status: "suggested",
      executed: false,
      steps: steps.map((step) => ({ ...step, status: "proposed" }))
    });
    if (useProvider) publish({ type: "agent-start", agent: agent.name, by: user.email });
    if (projectId) await studio.logActivity(projectId, user, "chat", `${user.email} asked ${agent.name}.`).then((event) => hub.publish(projectId, { type: "activity", activity: event }));
    publish({ type: "message", messageId: userMessageId });

    let text = "";
    let status = "complete";
    try {
      if (useProvider) {
        const messages = buildMessages({ agent, history, prompt: body.content.trim(), attachments });
        const providerModel = model === "provider-default" || model === "auto" ? undefined : model;
        for await (const delta of providerService.streamChat(user.id, { model: providerModel, messages, signal: abort.signal })) {
          text += delta;
          send("delta", { text: delta });
        }
      } else {
        for (const piece of chunk(localReply({ prompt: body.content.trim(), agent, attachments }))) {
          if (abort.signal.aborted) throw new Error("aborted");
          text += piece;
          send("delta", { text: piece });
        }
      }
    } catch (error) {
      status = abort.signal.aborted ? "cancelled" : "failed";
      if (status === "failed") {
        const safe = error instanceof ProviderError ? sanitizeError(error) : { message: "The response could not be generated.", code: "GENERATION_FAILED" };
        send("error", { message: safe.message, code: safe.code });
      }
    } finally {
      finished = true;
      if (useProvider) hub.end(runKey);
    }
    if (text) {
      const messageId = await studio.addMessage(conversation.id, { role: "assistant", agentId: agent.id, content: text + (status === "complete" ? "" : `\n\n_(${status})_`) });
      send("done", { messageId, status });
      publish({ type: "message", messageId });
    } else send("done", { status });
    if (useProvider) publish({ type: "agent-done", agent: agent.name, status });
    response.end();
    return true;
  }

  async function handleAdmin(request, response, url, user) {
    if (user.role !== "admin") return fail(response, 403, "Administrator access is required."), true;
    if (!allowAdmin(user.id)) return fail(response, 429, "Admin activity limit reached."), true;
    const method = request.method;
    const pathname = url.pathname;
    if (method === "GET" && pathname === "/api/admin/overview") {
      const [summary, extra, payments] = await Promise.all([store.getAdminSummary(), studio.overview(), studio.paymentTotals()]);
      sendJson(response, 200, { summary: { ...summary, ...extra }, payments, settings: await studio.getSettings() });
      return true;
    }
    if (method === "GET" && pathname === "/api/admin/users") {
      sendJson(response, 200, { users: await studio.listUsers() });
      return true;
    }
    const userAction = /^\/api\/admin\/users\/([0-9a-f-]{36})\/(disable|enable|revoke-sessions|delete)$/.exec(pathname);
    if (method === "POST" && userAction) {
      const target = await studio.getUser(userAction[1]);
      if (!target) return fail(response, 404, "User not found."), true;
      if (target.id === user.id || target.role === "admin") return fail(response, 409, "Administrator accounts cannot be changed from the dashboard."), true;
      const action = userAction[2];
      if (action === "disable") {
        const body = await readJson(request).catch(() => ({}));
        await studio.setUserDisabled(target.id, true, body?.reason);
      } else if (action === "enable") await studio.setUserDisabled(target.id, false);
      else if (action === "revoke-sessions") await studio.revokeSessions(target.id);
      else if (action === "delete") {
        const body = await readJson(request).catch(() => ({}));
        if (body?.confirmEmail !== target.email) return fail(response, 400, "Type the user's email to confirm deletion."), true;
        await studio.deleteUser(target.id);
      }
      await studio.audit(user, `user.${action}`, target.email);
      sendJson(response, 200, { status: "ok" });
      return true;
    }
    if (pathname === "/api/admin/settings") {
      if (method === "GET") return sendJson(response, 200, { settings: await studio.getSettings() }), true;
      if (method === "PUT") {
        const body = await readJson(request);
        const changes = {};
        const rules = {
          registrationOpen: (v) => typeof v === "boolean",
          maintenanceMode: (v) => typeof v === "boolean",
          allowProviderChat: (v) => typeof v === "boolean",
          announcement: (v) => typeof v === "string" && v.length <= 300,
          chatRatePerHour: (v) => Number.isInteger(v) && v >= 1 && v <= 10000,
          maxCollaboratorsPerProject: (v) => Number.isInteger(v) && v >= 1 && v <= 200
        };
        for (const [key, value] of Object.entries(isObject(body) ? body : {})) {
          if (!rules[key]?.(value)) return fail(response, 400, `Invalid setting: ${key}.`), true;
          changes[key] = value;
        }
        if (!Object.keys(changes).length) return fail(response, 400, "No valid settings supplied."), true;
        const settings = await studio.updateSettings(changes, user.id);
        await studio.audit(user, "settings.update", null, changes);
        sendJson(response, 200, { settings });
        return true;
      }
    }
    if (method === "GET" && pathname === "/api/admin/audit") {
      sendJson(response, 200, { audit: await studio.listAudit() });
      return true;
    }
    if (pathname === "/api/admin/payments") {
      if (method === "GET") {
        sendJson(response, 200, {
          payments: await studio.listPayments(), totals: await studio.paymentTotals(),
          processor: { status: "NOT_CONFIGURED", note: "No payment processor is integrated. Entries are manual ledger records; no card data is collected or charged." }
        });
        return true;
      }
      if (method === "POST") {
        const body = await readJson(request);
        const target = isObject(body) && typeof body.email === "string" ? await store.persistence.database
          .prepare("SELECT id, email FROM users WHERE email = ? COLLATE NOCASE").get(body.email.trim()) : null;
        if (!target) return fail(response, 404, "No user has that email."), true;
        if (typeof body.plan !== "string" || !/^[A-Za-z0-9 _-]{1,32}$/.test(body.plan)
          || !Number.isInteger(body.amountCents) || body.amountCents < 0 || body.amountCents > 100000000
          || !/^[A-Z]{3}$/.test(body.currency || "USD") || !["paid", "pending"].includes(body.status || "paid")) {
          return fail(response, 400, "Provide a plan, integer amountCents, 3-letter currency, and status paid or pending."), true;
        }
        const id = await studio.recordPayment(target.id, { plan: body.plan, amountCents: body.amountCents, currency: body.currency || "USD", status: body.status || "paid", note: typeof body.note === "string" ? body.note.slice(0, 200) : null }, user.id);
        await studio.audit(user, "payment.record", target.email, { id, plan: body.plan, amountCents: body.amountCents });
        sendJson(response, 201, { id });
        return true;
      }
    }
    const paymentStatus = /^\/api\/admin\/payments\/([0-9a-f-]{36})\/status$/.exec(pathname);
    if (method === "POST" && paymentStatus) {
      const body = await readJson(request);
      if (!["paid", "pending", "refunded"].includes(body?.status)) return fail(response, 400, "Invalid status."), true;
      if (!await studio.setPaymentStatus(paymentStatus[1], body.status)) return fail(response, 404, "Payment not found."), true;
      await studio.audit(user, "payment.status", paymentStatus[1], { status: body.status });
      sendJson(response, 200, { status: "ok" });
      return true;
    }
    if (method === "GET" && pathname === "/api/admin/api") {
      sendJson(response, 200, {
        usage: await studio.apiUsage(),
        endpoints: ["/api/health", "/api/studio/*", "/api/projects/*", "/api/games/*", "/api/providers/*", "/api/admin/*"],
        limits: { chatRatePerHour: (await studio.getSettings()).chatRatePerHour, bodyLimitBytes: 65536, chatBodyLimitBytes: 1048576 }
      });
      return true;
    }
    if (pathname === "/api/admin/agents" && method === "GET") {
      const configs = await studio.getAgentConfigs("global");
      sendJson(response, 200, {
        agents: SPECIALISTS.map((agent) => mergeAgentConfig(agent, configs.get(agent.id))),
        scopes: SCOPES, tools: TOOL_CATALOG.map(({ id, label }) => ({ id, label }))
      });
      return true;
    }
    const adminAgent = /^\/api\/admin\/agents\/([a-z-]{2,40})$/.exec(pathname);
    if (adminAgent && ["PUT", "DELETE"].includes(method)) {
      const agent = getSpecialist(adminAgent[1]);
      if (!agent) return fail(response, 404, "Agent not found."), true;
      if (method === "DELETE") {
        await studio.resetAgentConfig("global", agent.id);
        await studio.audit(user, "agent.reset", agent.id);
        return sendJson(response, 200, { status: "reset" }), true;
      }
      const { config, error } = validateAgentConfig(agent, await readJson(request));
      if (error) return fail(response, 400, error), true;
      const existing = (await studio.getAgentConfigs("global")).get(agent.id) || {};
      await studio.saveAgentConfig("global", agent.id, { ...existing, ...config }, user.id);
      await studio.audit(user, "agent.update", agent.id, Object.keys(config));
      sendJson(response, 200, { status: "saved" });
      return true;
    }
    if (method === "GET" && pathname === "/api/admin/deployment") {
      sendJson(response, 200, {
        environment: DEPLOY_ENV.map((name) => ({ name, configured: Boolean(process.env[name]) })),
        productionMode: process.env.NODE_ENV === "production",
        secretKeyConfigured: Boolean(process.env.GODS_SECRET_KEY),
        actions: ["check", "preflight"],
        scripts: ["scripts/check.js", "scripts/build.js", "scripts/deploy-release.sh", "scripts/provision-admin.js"],
        note: "Only read-only checks run from the dashboard. Releasing to a host remains a CLI operation: scripts/deploy-release.sh."
      });
      return true;
    }
    if (method === "POST" && pathname === "/api/admin/deployment/run") {
      const body = await readJson(request);
      const actions = {
        check: [process.execPath, [path.join(SCRIPTS_ROOT, "check.js")]],
        preflight: ["bash", [path.join(SCRIPTS_ROOT, "deploy-release.sh"), "preflight"]]
      };
      if (!isObject(body) || !actions[body.action]) return fail(response, 400, "Choose check or preflight."), true;
      if (!allowDeployAction(user.id)) return fail(response, 429, "Deployment check limit reached."), true;
      const [command, args] = actions[body.action];
      const result = await new Promise((resolve) => {
        const child = spawn(command, args, { cwd: path.join(__dirname, ".."), env: process.env, timeout: 120000 });
        let output = "";
        const collect = (data) => { if (output.length < 20000) output += data; };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("error", () => resolve({ code: -1, output: "Could not start the check." }));
        child.on("close", (code) => resolve({ code, output }));
      });
      const redacted = result.output.split(process.env.GODS_SECRET_KEY || "\u0000").join("[redacted]");
      await studio.audit(user, `deployment.${body.action}`, null, { exitCode: result.code });
      sendJson(response, 200, { action: body.action, exitCode: result.code, status: result.code === 0 ? "PASSED" : result.code === 2 ? "BLOCKED" : "FAILED", output: redacted.slice(-8000) });
      return true;
    }
    if (method === "GET" && pathname === "/api/admin/security") {
      const summary = await store.getAdminSummary();
      sendJson(response, 200, {
        posture: [
          { check: "Passwords hashed with scrypt", status: "ENABLED" },
          { check: "HttpOnly SameSite=Strict session cookies", status: "ENABLED" },
          { check: "Secure __Host- cookies", status: process.env.NODE_ENV === "production" ? "ENABLED" : "DEV_MODE" },
          { check: "Provider key encryption (GODS_SECRET_KEY)", status: process.env.GODS_SECRET_KEY ? "CONFIGURED" : "MISSING" },
          { check: "Content-Security-Policy on app pages", status: "ENABLED" },
          { check: "Registration open", status: (await studio.getSettings()).registrationOpen ? "OPEN" : "CLOSED" }
        ],
        activeSessions: summary.activeSessions
      });
      return true;
    }
    if (method === "POST" && pathname === "/api/admin/security/revoke-all-sessions") {
      const count = await studio.revokeSessions();
      await studio.audit(user, "security.revoke-all-sessions", null, { count });
      sendJson(response, 200, { revoked: count, note: "You will need to sign in again." });
      return true;
    }
    return false;
  }

  return async function route(request, response, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/studio") && !pathname.startsWith("/api/admin/")) return false;
    if (request.method === "GET" && pathname === "/api/studio/public") {
      const settings = await studio.getSettings();
      sendJson(response, 200, { registrationOpen: settings.registrationOpen, maintenanceMode: settings.maintenanceMode, announcement: settings.announcement });
      return true;
    }
    if (request.method !== "GET" && !isSameOrigin(request)) return fail(response, 403, "This request must come from this site."), true;
    const session = await auth.getSession(getCookie(request, sessionCookieName));
    if (!session) return fail(response, 401, "Sign in to continue."), true;
    const user = session.user;
    if (pathname.startsWith("/api/admin/")) return handleAdmin(request, response, url, user);
    const method = request.method;

    if (method === "GET" && pathname === "/api/studio/dashboard") {
      sendJson(response, 200, { dashboard: await studio.userDashboard(user), settings: { announcement: (await studio.getSettings()).announcement } });
      return true;
    }
    if (method === "GET" && pathname === "/api/studio/projects") {
      const owned = (await store.list(user.id)).map((project) => ({ id: project.id, title: project.title, status: project.status, role: "owner" }));
      sendJson(response, 200, { projects: [...owned, ...await studio.sharedProjects(user.id)] });
      return true;
    }
    if (method === "GET" && pathname === "/api/studio/agents") {
      const agents = await resolveAgents(user);
      const providerReady = await providerService.hasConfiguration(user.id);
      sendJson(response, 200, {
        providerConfigured: providerReady,
        scopes: SCOPES,
        agents: agents.map((agent) => ({
          ...agent,
          status: !agent.enabled ? "disabled" : hub.running.get(`${user.id}:${agent.id}`) ? "working"
            : agent.permissionScopes.includes("provider:invoke") && !providerReady ? "local-only" : "ready"
        }))
      });
      return true;
    }
    const agentRoute = /^\/api\/studio\/agents\/([a-z-]{2,40})$/.exec(pathname);
    if (agentRoute && ["PUT", "DELETE"].includes(method)) {
      const agent = getSpecialist(agentRoute[1]);
      if (!agent) return fail(response, 404, "Agent not found."), true;
      if (method === "DELETE") {
        await studio.resetAgentConfig(`user:${user.id}`, agent.id);
        return sendJson(response, 200, { status: "reset" }), true;
      }
      const { config, error } = validateAgentConfig(agent, await readJson(request));
      if (error) return fail(response, 400, error), true;
      const existing = (await studio.getAgentConfigs(`user:${user.id}`)).get(agent.id) || {};
      await studio.saveAgentConfig(`user:${user.id}`, agent.id, { ...existing, ...config }, user.id);
      sendJson(response, 200, { status: "saved" });
      return true;
    }
    if (method === "GET" && pathname === "/api/studio/models") {
      let providerModel = null;
      if (await providerService.hasConfiguration(user.id)) providerModel = (await providerService.configuration(user.id)).model;
      sendJson(response, 200, {
        models: [
          { id: "auto", label: "Auto (provider default)" },
          ...(providerModel ? [{ id: providerModel, label: providerModel }] : []),
          { id: "local", label: "Local deterministic (no provider)" }
        ]
      });
      return true;
    }
    if (method === "POST" && pathname === "/api/studio/suggest") {
      const body = await readJson(request);
      const text = typeof body?.text === "string" ? body.text.slice(0, 2000) : "";
      const history = Array.isArray(body?.history) ? body.history.filter((item) => typeof item === "string").slice(-3).map((item) => item.slice(0, 500)) : [];
      const agent = suggestAgent(text);
      sendJson(response, 200, { tools: text.trim().length >= 4 ? suggestTools(text, history) : [], agent: { id: agent.id, name: agent.name } });
      return true;
    }
    if (pathname.startsWith("/api/studio/tools/") && method === "POST") {
      if (!allowTools(user.id)) return fail(response, 429, "Tool limit reached. Try again later."), true;
      const body = await readJson(request, MAX_FILE_BYTES + 4096);
      if (!isObject(body) || typeof body.code !== "string" || body.code.length > MAX_FILE_BYTES) {
        return fail(response, 400, "Provide code up to 256 KiB."), true;
      }
      const options = { language: body.language, path: typeof body.path === "string" ? body.path : "" };
      const tool = pathname.slice("/api/studio/tools/".length);
      if (tool === "lint") return sendJson(response, 200, lint(body.code, options)), true;
      if (tool === "format") return sendJson(response, 200, format(body.code, options)), true;
      if (tool === "review") {
        const findings = analyze(body.code, options);
        return sendJson(response, 200, { language: normalizeLanguage(options.language, options.path), summary: summarize(findings), findings }), true;
      }
      if (tool === "fix") {
        const result = applyFixes(body.code, { ...options, ruleIds: Array.isArray(body.ruleIds) ? body.ruleIds : null });
        return sendJson(response, 200, result), true;
      }
      return false;
    }
    if (method === "POST" && pathname === "/api/studio/blueprint/parse") {
      const body = await readJson(request, MAX_FILE_BYTES + 4096);
      if (typeof body?.yaml !== "string") return fail(response, 400, "Provide yaml."), true;
      try {
        sendJson(response, 200, yamlToBlueprint(body.yaml));
      } catch (error) {
        sendJson(response, 200, { model: null, errors: [error.message] });
      }
      return true;
    }
    if (method === "POST" && pathname === "/api/studio/blueprint/serialize") {
      const body = await readJson(request, MAX_FILE_BYTES + 4096);
      const { model, errors } = validateBlueprint(body?.model);
      sendJson(response, 200, { yaml: blueprintToYaml(model), model, errors });
      return true;
    }
    if (await handleChat(request, response, url, user)) return true;
    if (await handleProject(request, response, url, user, session)) return true;
    return fail(response, 404, "Route not found."), true;
  };
}

module.exports = { createStudioRouter };
