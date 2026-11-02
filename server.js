const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { version } = require("./package.json");
const { approveRequirements, createDraft, serializeBlueprint } = require("./src/blueprint");
const { agents } = require("./src/agents");
const { AuthService } = require("./src/auth");
const { createGameProject, generatePlayableHtml, refineGameSpecification } = require("./src/game-studio");
const { AuthStore, GameStore, ProjectStore } = require("./src/store");
const { AgentOrchestrator } = require("./src/services/AgentOrchestrator.ts");
const { ProjectGenerator } = require("./src/services/ProjectGenerator.ts");
const { createVerifiedProjectZip, readVerifiedProjectZip } = require("./src/project-archive");
const { createCoreAgentHandlers } = require("./src/core-agents");
const { inlineProjectAssets } = require("./src/project-preview");
const { verifyProjectArtifacts } = require("./src/services/StaticBuildService");
const { createProjectImplementationManifest } = require("./src/project-manifest");
const { ProviderError, ProviderService, assertProductionSecretKey, sanitizeError } = require("./src/providers");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 64 * 1024;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function getCookie(request, name) {
  const cookies = request.headers.cookie || "";
  for (const cookie of cookies.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    return cookie.slice(separator + 1).trim();
  }
  return null;
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin);
    return ["http:", "https:"].includes(parsedOrigin.protocol)
      && parsedOrigin.host === request.headers.host
      && !parsedOrigin.username
      && !parsedOrigin.password;
  } catch {
    return false;
  }
}

function makeSessionCookie(token, secure) {
  const name = secure ? "__Host-gods_session" : "gods_session";
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? "; Secure" : ""}`;
}

function makeClearSessionCookie(secure) {
  const name = secure ? "__Host-gods_session" : "gods_session";
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function validGameState(state) {
  return state
    && typeof state === "object"
    && !Array.isArray(state)
    && Number.isFinite(state.x)
    && state.x >= 18
    && state.x <= 782
    && Number.isFinite(state.y)
    && state.y >= 18
    && state.y <= 432
    && Number.isInteger(state.score)
    && state.score >= 0
    && state.score <= 1000000
    && Number.isFinite(state.orbX)
    && state.orbX >= 12
    && state.orbX <= 788
    && Number.isFinite(state.orbY)
    && state.orbY >= 12
    && state.orbY <= 438;
}

function gameForApi(game) {
  return {
    ...game,
    versions: game.versions.map(({ source, specification, ...version }) => version)
  };
}

function createRateLimiter({ limit, windowMs }) {
  const attempts = new Map();
  return (key) => {
    const now = Date.now();
    if (attempts.size > 10000) {
      for (const [candidate, entry] of attempts) {
        if (entry.resetAt <= now) attempts.delete(candidate);
      }
    }
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  };
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

async function serveStatic(response, pathname) {
  const files = {
    "/": "index.html",
    "/app.js": "app.js",
    "/markdown-renderer.js": "markdown-renderer.js",
    "/styles.css": "styles.css"
  };
  const file = files[pathname];
  if (!file) return false;

  const content = await fs.readFile(path.join(PUBLIC_DIR, file));
  response.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(file)],
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-cache"
  });
  response.end(content);
  return true;
}

function createServer({ dataDir = process.env.GODS_DATA_DIR || path.join(__dirname, "data"), providerOptions = {} } = {}) {
  assertProductionSecretKey();
  const store = new ProjectStore(dataDir);
  const gameStore = new GameStore(dataDir);
  const authStore = new AuthStore(dataDir);
  const auth = new AuthService(authStore);
  const providerService = new ProviderService(store, providerOptions);
  const orchestrator = new AgentOrchestrator(store);
  for (const [agentId, handler] of createCoreAgentHandlers(store, { providers: providerService })) {
    orchestrator.registerAgent(agentId, handler);
  }
  const projectGenerator = new ProjectGenerator(store, orchestrator);
  const secureCookies = process.env.NODE_ENV === "production";
  const sessionCookieName = secureCookies ? "__Host-gods_session" : "gods_session";
  const allowRegistration = createRateLimiter({ limit: 25, windowMs: 60 * 60 * 1000 });
  const allowLogin = createRateLimiter({ limit: 20, windowMs: 15 * 60 * 1000 });
  const allowGameCreation = createRateLimiter({ limit: 8, windowMs: 60 * 60 * 1000 });
  const allowGameChanges = createRateLimiter({ limit: 60, windowMs: 60 * 60 * 1000 });
  const allowProjectGeneration = createRateLimiter({ limit: 8, windowMs: 60 * 60 * 1000 });
  const allowArtifactChanges = createRateLimiter({ limit: 120, windowMs: 60 * 60 * 1000 });
  const allowProviderChanges = createRateLimiter({ limit: 30, windowMs: 60 * 60 * 1000 });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && await serveStatic(response, url.pathname)) return;
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        return response.end();
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        const persistenceReady = await store.ping();
        return sendJson(response, 200, {
          status: persistenceReady ? "VERIFIED" : "FAILED",
          application: "available",
          version,
          persistence: persistenceReady ? "sqlite" : "FAILED",
          authentication: "ENABLED",
          gameStudio: "IMPLEMENTED_UNVERIFIED",
          gameStudioEngine: "HTML5 Canvas 2D local template",
          aiProviders: "CONFIGURABLE",
          productionReady: false,
          productionBlockers: [
            "SQLite is local embedded storage; managed multi-instance database operations and backups are not configured.",
            "Authentication rate limits are process-local and are not shared across server instances.",
            "Email ownership verification, password reset, and explicit administrator provisioning are not configured.",
            "No AI provider or isolated agent execution worker is configured."
          ]
        });
      }

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const token = getCookie(request, sessionCookieName);
        const session = await auth.getSession(token);
        if (!session) return sendJson(response, 401, { error: "Sign in to continue." });
        return sendJson(response, 200, { user: session.user, expiresAt: session.expiresAt });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/summary") {
        const session = await auth.getSession(getCookie(request, sessionCookieName));
        if (!session) return sendJson(response, 401, { error: "Sign in to continue." });
        if (session.user.role !== "admin") return sendJson(response, 403, { error: "Administrator access is required." });
        return sendJson(response, 200, {
          status: "VERIFIED",
          summary: await store.getAdminSummary()
        });
      }

      if (request.method === "POST" && [
        "/api/auth/register",
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/request-password-reset",
        "/api/auth/reset-password"
      ].includes(url.pathname)) {
        if (!isSameOrigin(request)) return sendJson(response, 403, { error: "This request must come from this site." });
        const source = request.socket.remoteAddress || "unknown";
        const limiter = url.pathname.endsWith("/register") ? allowRegistration : allowLogin;
        if (url.pathname !== "/api/auth/logout" && !limiter(source)) {
          return sendJson(response, 429, { error: "Too many attempts. Please wait before trying again." }, { "retry-after": "900" });
        }

        if (url.pathname === "/api/auth/logout") {
          const token = getCookie(request, sessionCookieName);
          await auth.deleteSession(token);
          return sendJson(response, 200, { status: "signed_out" }, {
            "set-cookie": makeClearSessionCookie(secureCookies)
          });
        }

        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return sendJson(response, 400, { error: "Provide an email address and password." });
        }

        if (url.pathname === "/api/auth/request-password-reset") {
          return sendJson(response, 503, {
            status: "BLOCKED",
            error: "Password recovery is unavailable because email delivery is not configured."
          });
        }

        if (url.pathname === "/api/auth/reset-password") {
          if (typeof body.token !== "string" || typeof body.password !== "string") {
            return sendJson(response, 400, { error: "Provide a reset token and a new password." });
          }
          const reset = await auth.resetPassword(body.token, body.password);
          if (!reset) return sendJson(response, 400, { error: "This reset link is invalid or expired." });
          return sendJson(response, 200, { status: "password_updated" }, {
            "set-cookie": makeClearSessionCookie(secureCookies)
          });
        }

        let user;
        let session;
        if (url.pathname.endsWith("/register")) {
          try {
            user = await auth.register(body.email, body.password);
          } catch (error) {
            return sendJson(response, error.message.includes("already exists") ? 409 : 400, { error: error.message });
          }
          session = await auth.createSession(user.id);
        } else {
          const login = await auth.login(body.email, body.password);
          if (!login) return sendJson(response, 401, { error: "Email or password is incorrect." });
          user = login.user;
          session = login.session;
        }

        return sendJson(response, url.pathname.endsWith("/register") ? 201 : 200, {
          user,
          expiresAt: session.expiresAt
        }, { "set-cookie": makeSessionCookie(session.token, secureCookies) });
      }

      if (url.pathname.startsWith("/api/projects")) {
        if (!isSameOrigin(request) && request.method !== "GET") {
          return sendJson(response, 403, { error: "This request must come from this site." });
        }
        const session = await auth.getSession(getCookie(request, sessionCookieName));
        if (!session) return sendJson(response, 401, { error: "Sign in to manage project plans." });
        request.authenticatedUser = session.user;
      }

      if (url.pathname.startsWith("/api/games")) {
        if (!isSameOrigin(request) && request.method !== "GET") {
          return sendJson(response, 403, { error: "This request must come from this site." });
        }
        const session = await auth.getSession(getCookie(request, sessionCookieName));
        if (!session) return sendJson(response, 401, { error: "Sign in to manage games." });
        request.authenticatedUser = session.user;
      }

      if (url.pathname === "/api/providers" || url.pathname.startsWith("/api/providers/")) {
        if (request.method !== "GET" && (!request.headers.origin || !isSameOrigin(request))) {
          return sendJson(response, 403, { error: "This request must come from this site." });
        }
        const session = await auth.getSession(getCookie(request, sessionCookieName));
        if (!session) return sendJson(response, 401, { error: "Sign in to manage provider settings." });
        request.authenticatedUser = session.user;
      }

      if (request.method === "GET" && url.pathname === "/api/providers") {
        return sendJson(response, 200, { providers: await providerService.listProviders(request.authenticatedUser.id) });
      }

      const providerRoute = url.pathname.match(/^\/api\/providers\/([a-z0-9-]+)(?:\/(credential|health|models))?$/);
      if (providerRoute) {
        const providerId = providerRoute[1];
        const action = providerRoute[2];
        if (providerId !== "openai-compatible") return sendJson(response, 404, { error: "Provider not found." });
        if (request.method !== "GET" && !allowProviderChanges(request.authenticatedUser.id)) {
          return sendJson(response, 429, { error: "Provider settings activity limit reached. Try again later." }, { "retry-after": "3600" });
        }
        if (request.method === "PUT" && action === "credential") {
          const credential = await readJson(request);
          const saved = await providerService.saveCredential(request.authenticatedUser.id, credential);
          return sendJson(response, 200, { provider: saved, status: "IMPLEMENTED_UNVERIFIED" });
        }
        if (request.method === "DELETE" && action === "credential") {
          await readJson(request);
          const deleted = await providerService.deleteCredential(request.authenticatedUser.id);
          return sendJson(response, 200, {
            provider: { provider_id: providerId, hasKey: false, updated_at: null },
            deleted,
            status: "IMPLEMENTED_UNVERIFIED"
          });
        }
        if (request.method === "POST" && action === "health") {
          await readJson(request);
          const health = await providerService.healthCheck(request.authenticatedUser.id);
          return sendJson(response, 200, { health, status: health.ok ? "IMPLEMENTED_UNVERIFIED" : "BLOCKED" });
        }
        if (request.method === "GET" && action === "models") {
          const models = await providerService.listModels(request.authenticatedUser.id);
          return sendJson(response, 200, { models, status: "IMPLEMENTED_UNVERIFIED" });
        }
        return sendJson(response, 405, { error: "Provider operation is not supported." });
      }

      if (request.method === "GET" && url.pathname === "/api/agents") {
        return sendJson(response, 200, {
          agents,
          operationalAgents: await store.listCoreAgents(),
          status: "IMPLEMENTED_UNVERIFIED",
          note: "Local deterministic workers are available; Product Discovery requires a per-owner configured provider."
        });
      }

      if (request.method === "GET" && url.pathname === "/api/games") {
        return sendJson(response, 200, { games: await gameStore.list(request.authenticatedUser.id) });
      }

      if (request.method === "POST" && url.pathname === "/api/games") {
        if (!allowProjectGeneration(request.authenticatedUser.id)) {
          return sendJson(response, 429, { error: "Game creation limit reached. Try again later." }, { "retry-after": "3600" });
        }
        const body = await readJson(request);
        if (
          !body
          || typeof body !== "object"
          || Array.isArray(body)
          || typeof body.prompt !== "string"
          || body.prompt.trim().length < 10
          || body.prompt.length > 5000
        ) {
          return sendJson(response, 400, { error: "Describe a game in at least 10 characters (up to 5,000)." });
        }
        const game = createGameProject(body.prompt.trim(), request.authenticatedUser.id);
        await gameStore.create(game);
        return sendJson(response, 201, {
          game: gameForApi(game),
          status: game.status,
          limitations: game.specification.unsupportedRequests
        });
      }

      const gameRoute = url.pathname.match(/^\/api\/games\/([a-f0-9]{32})(?:\/(refine|rollback|save|preview))?$/);
      if (request.method === "GET" && gameRoute) {
        const game = await gameStore.get(gameRoute[1], request.authenticatedUser.id);
        if (!game) return sendJson(response, 404, { error: "Game not found." });
        if (gameRoute[2] === "save") {
          return sendJson(response, 200, { save: await gameStore.getSave(game.id, request.authenticatedUser.id) });
        }
        if (gameRoute[2] === "preview") {
          const requestedVersion = url.searchParams.has("version")
            ? Number(url.searchParams.get("version"))
            : game.latestVersion;
          if (!Number.isInteger(requestedVersion) || requestedVersion < 1) {
            return sendJson(response, 400, { error: "Choose a valid game version." });
          }
          const version = await gameStore.getVersion(game.id, request.authenticatedUser.id, requestedVersion);
          if (!version) return sendJson(response, 404, { error: "Game version not found." });
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "cache-control": "no-store"
          });
          return response.end(version.source);
        }
        return sendJson(response, 200, { game });
      }

      if (request.method === "POST" && gameRoute?.[2] === "refine") {
        if (!allowGameChanges(request.authenticatedUser.id)) {
          return sendJson(response, 429, { error: "Game change limit reached. Try again later." }, { "retry-after": "3600" });
        }
        const game = await gameStore.get(gameRoute[1], request.authenticatedUser.id);
        if (!game) return sendJson(response, 404, { error: "Game not found." });
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || typeof body.instruction !== "string" || body.instruction.trim().length < 3
          || body.instruction.length > 500) {
          return sendJson(response, 400, { error: "Describe one game change in 3 to 500 characters." });
        }
        let refinement;
        try {
          refinement = refineGameSpecification(game.specification, body.instruction);
        } catch (error) {
          return sendJson(response, 422, {
            status: "PARTIALLY_IMPLEMENTED",
            error: error.message
          });
        }
        const version = await gameStore.appendVersion(game.id, request.authenticatedUser.id, {
          specification: refinement.specification,
          source: generatePlayableHtml(refinement.specification),
          status: "IMPLEMENTED_UNVERIFIED",
          changeSummary: refinement.summary
        });
        if (!version) return sendJson(response, 404, { error: "Game not found." });
        return sendJson(response, 200, {
          game: gameForApi(await gameStore.get(game.id, request.authenticatedUser.id)),
          changeSummary: refinement.summary
        });
      }

      if (request.method === "POST" && gameRoute?.[2] === "rollback") {
        if (!allowGameChanges(request.authenticatedUser.id)) {
          return sendJson(response, 429, { error: "Game change limit reached. Try again later." }, { "retry-after": "3600" });
        }
        const game = await gameStore.get(gameRoute[1], request.authenticatedUser.id);
        if (!game) return sendJson(response, 404, { error: "Game not found." });
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || !Number.isInteger(body.version) || body.version < 1) {
          return sendJson(response, 400, { error: "Choose a valid version to restore." });
        }
        const previous = await gameStore.getVersion(game.id, request.authenticatedUser.id, body.version);
        if (!previous) return sendJson(response, 404, { error: "Game version not found." });
        const version = await gameStore.appendVersion(game.id, request.authenticatedUser.id, {
          specification: previous.specification,
          source: previous.source,
          status: "IMPLEMENTED_UNVERIFIED",
          changeSummary: `Restored the design from version ${previous.version} as a new version.`
        });
        if (!version) return sendJson(response, 404, { error: "Game not found." });
        return sendJson(response, 200, { game: gameForApi(await gameStore.get(game.id, request.authenticatedUser.id)) });
      }

      if (request.method === "POST" && gameRoute?.[2] === "save") {
        const game = await gameStore.get(gameRoute[1], request.authenticatedUser.id);
        if (!game) return sendJson(response, 404, { error: "Game not found." });
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || !validGameState(body.state)) {
          return sendJson(response, 400, { error: "The game state is invalid or outside the supported arena." });
        }
        const state = {
          x: body.state.x,
          y: body.state.y,
          score: body.state.score,
          orbX: body.state.orbX,
          orbY: body.state.orbY
        };
        await gameStore.save(game.id, request.authenticatedUser.id, state);
        return sendJson(response, 200, {
          save: await gameStore.getSave(game.id, request.authenticatedUser.id),
          status: "IMPLEMENTED_UNVERIFIED"
        });
      }

      if (request.method === "GET" && url.pathname === "/api/projects") {
        return sendJson(response, 200, { projects: await store.list(request.authenticatedUser.id) });
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        const body = await readJson(request);
        if (
          !body
          || typeof body !== "object"
          || Array.isArray(body)
          || typeof body.prompt !== "string"
          || body.prompt.trim().length < 10
          || body.prompt.length > 10000
        ) {
          return sendJson(response, 400, { error: "Describe the application in at least 10 characters (up to 10,000)." });
        }
        const project = createDraft(body.prompt.trim());
        project.ownerId = request.authenticatedUser.id;
        await store.create(project);
        return sendJson(response, 201, { project });
      }

      const taskRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/tasks(?:\/([a-zA-Z0-9_-]{1,128})(?:\/(events|run))?)?$/);
      if (taskRoute) {
        const projectId = taskRoute[1];
        const taskId = taskRoute[2];
        const taskAction = taskRoute[3];
        const ownerId = request.authenticatedUser.id;
        if (request.method !== "GET" && !allowArtifactChanges(ownerId)) {
          return sendJson(response, 429, { error: "Agent task activity limit reached. Try again later." }, { "retry-after": "3600" });
        }
        const project = await store.get(projectId);
        if (!project || project.ownerId !== ownerId) return sendJson(response, 404, { error: "Project not found." });
        if (request.method === "GET" && !taskId) {
          const tasks = await orchestrator.listTasks(projectId, ownerId);
          return sendJson(response, 200, { tasks: tasks || [], status: "VERIFIED" });
        }
        if (request.method === "GET" && taskId && taskAction === "events") {
          const events = await orchestrator.listEvents(projectId, ownerId, taskId);
          return events ? sendJson(response, 200, { events, status: "VERIFIED" })
            : sendJson(response, 404, { error: "Agent task not found." });
        }
        if (request.method === "POST" && taskId && taskAction === "run") {
          const task = await orchestrator.executeTask(projectId, ownerId, taskId);
          if (!task) return sendJson(response, 404, { error: "Agent task not found." });
          if (task.status === "BLOCKED") {
            const reason = task.blockedReason || "This task has no registered agent worker.";
            const providerBlocked = task.agentId === "requirements-intelligence";
            return sendJson(response, providerBlocked ? 503 : 409, {
              ...(providerBlocked ? { status: "BLOCKED", reason } : { error: reason }),
              task
            });
          }
          return sendJson(response, 200, { task });
        }
        return sendJson(response, 405, { error: "Agent task operation is not supported." });
      }

      const routingDecisionsRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/routing-decisions$/);
      if (request.method === "GET" && routingDecisionsRoute) {
        const projectId = routingDecisionsRoute[1];
        const ownerId = request.authenticatedUser.id;
        const project = await store.get(projectId);
        if (!project || project.ownerId !== ownerId) return sendJson(response, 404, { error: "Project not found." });
        return sendJson(response, 200, {
          decisions: await store.listModelRoutingDecisions(projectId, ownerId),
          status: "IMPLEMENTED_UNVERIFIED"
        });
      }

      const executionRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/execution$/);
      if (request.method === "GET" && executionRoute) {
        const execution = await store.getAgenticExecution(executionRoute[1], request.authenticatedUser.id);
        return execution
          ? sendJson(response, 200, { execution, status: "VERIFIED" })
          : sendJson(response, 404, { error: "Project execution not found." });
      }

      const agentExecutionsRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/agent-executions$/);
      if (request.method === "GET" && agentExecutionsRoute) {
        const executions = await store.listAgentExecutions(agentExecutionsRoute[1], request.authenticatedUser.id);
        return executions
          ? sendJson(response, 200, { executions, status: "VERIFIED" })
          : sendJson(response, 404, { error: "Project not found." });
      }

      const manifestRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/manifest$/);
      if (request.method === "GET" && manifestRoute) {
        const projectId = manifestRoute[1];
        const ownerId = request.authenticatedUser.id;
        const project = await store.get(projectId);
        if (!project || project.ownerId !== ownerId) return sendJson(response, 404, { error: "Project not found." });
        const [tasks, executions, artifacts, builds] = await Promise.all([
          store.listAgentTasks(projectId, ownerId),
          store.listAgentExecutions(projectId, ownerId),
          store.listArtifacts(projectId, ownerId),
          store.listBuilds(projectId, ownerId)
        ]);
        if (!tasks || !executions || !artifacts || !builds) {
          return sendJson(response, 404, { error: "Project evidence is unavailable." });
        }
        const manifest = createProjectImplementationManifest({ project, tasks, executions, artifacts, builds });
        if (url.searchParams.get("download") === "1") {
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="gods-${projectId}-implementation-manifest.json"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
          });
          return response.end(JSON.stringify(manifest, null, 2));
        }
        return sendJson(response, 200, { manifest, status: manifest.status });
      }

      const directAgentRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/agents\/([a-z0-9-]{2,64})\/execute$/);
      if (request.method === "POST" && directAgentRoute) {
        const ownerId = request.authenticatedUser.id;
        if (!allowArtifactChanges(ownerId)) {
          return sendJson(response, 429, { error: "Agent execution limit reached. Try again later." }, { "retry-after": "3600" });
        }
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return sendJson(response, 400, { error: "Agent execution requires a JSON object." });
        }
        const project = await store.get(directAgentRoute[1]);
        if (!project || project.ownerId !== ownerId) return sendJson(response, 404, { error: "Project not found." });
        if (project.status !== "APPROVED_PLAN") {
          return sendJson(response, 409, { error: "Approve this project's requirements before running a specialist." });
        }
        const result = await orchestrator.executeRegisteredAgent(directAgentRoute[1], ownerId, directAgentRoute[2], {
          projectId: directAgentRoute[1],
          title: project.title,
          originalRequest: project.originalRequest,
          blueprintVersion: project.blueprint?.blueprintVersion || "unknown",
          requirements: project.requirements
            .filter((requirement) => requirement.decision === "APPROVED")
            .map(({ id, text }) => ({ id, text })),
          projectType: "general"
        });
        return result
          ? sendJson(response, 200, { execution: result })
          : sendJson(response, 404, { error: "Operational specialist agent not found." });
      }

      const buildsRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/builds?$/);
      if (request.method === "GET" && buildsRoute) {
        const builds = await store.listBuilds(buildsRoute[1], request.authenticatedUser.id);
        return builds
          ? sendJson(response, 200, { builds, status: "VERIFIED" })
          : sendJson(response, 404, { error: "Project not found." });
      }
      if (request.method === "POST" && buildsRoute) {
        if (!allowArtifactChanges(request.authenticatedUser.id)) {
          return sendJson(response, 429, { error: "Build check limit reached. Try again later." }, { "retry-after": "3600" });
        }
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return sendJson(response, 400, { error: "Build checks require a JSON object." });
        }
        const tree = await store.listArtifacts(buildsRoute[1], request.authenticatedUser.id);
        if (!tree) return sendJson(response, 404, { error: "Project not found." });
        const artifacts = [];
        for (const entry of tree.files) {
          const artifact = await store.readArtifact(buildsRoute[1], request.authenticatedUser.id, entry.path);
          if (artifact) artifacts.push(artifact);
        }
        const report = verifyProjectArtifacts(artifacts);
        const build = await store.createBuild(buildsRoute[1], request.authenticatedUser.id, report);
        return build
          ? sendJson(response, 201, { build, status: report.status })
          : sendJson(response, 404, { error: "Project not found." });
      }

      const previewRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/preview$/);
      if (request.method === "GET" && previewRoute) {
        const projectId = previewRoute[1];
        const project = await store.get(projectId);
        if (!project || project.ownerId !== request.authenticatedUser.id) {
          return sendJson(response, 404, { error: "Project not found." });
        }
        const entryPath = url.searchParams.get("entry");
        if (!entryPath) return sendJson(response, 400, { error: "Choose an HTML project artifact to preview." });
        const entry = await store.readArtifact(projectId, request.authenticatedUser.id, entryPath);
        if (!entry) return sendJson(response, 404, { error: "HTML preview artifact not found." });
        let preview;
        try {
          preview = await inlineProjectAssets(entry.path, entry.contents,
            (artifactPath) => store.readArtifact(projectId, request.authenticatedUser.id, artifactPath));
        } catch (error) {
          return sendJson(response, error.status || 400, { error: error.message });
        }
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'self'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
          "x-gods-preview-artifacts": String(preview.loadedArtifacts)
        });
        return response.end(preview.html);
      }

      const projectGenerationRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/generate$/);
      if (request.method === "POST" && projectGenerationRoute) {
        if (!allowGameCreation(request.authenticatedUser.id)) {
          return sendJson(response, 429, { error: "Project generation limit reached. Try again later." }, { "retry-after": "3600" });
        }
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return sendJson(response, 400, { error: "Generation requires a JSON object." });
        }
        const generated = await projectGenerator.generate(projectGenerationRoute[1], request.authenticatedUser.id);
        return generated ? sendJson(response, 201, generated)
          : sendJson(response, 404, { error: "Project not found." });
      }

      const artifactRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/artifacts(?:\/(generate|file|files|upload|directories|history|audit|export|zip|zip-import|restore|rename|duplicate))?$/);
      if (artifactRoute) {
        const projectId = artifactRoute[1];
        const action = artifactRoute[2];
        const ownerId = request.authenticatedUser.id;
        if (request.method !== "GET" && !allowArtifactChanges(ownerId)) {
          return sendJson(response, 429, { error: "File activity limit reached. Try again later." }, { "retry-after": "3600" });
        }
        if (request.method === "POST" && action === "generate") {
          return sendJson(response, 410, {
            status: "BLOCKED",
            error: "Static scaffold generation has been retired. Use POST /api/projects/:id/generate to create a blueprint-derived task graph."
          });
        }
        if (request.method === "GET" && !action) {
          const tree = await store.listArtifacts(projectId, ownerId);
          return tree ? sendJson(response, 200, { ...tree, status: "VERIFIED" })
            : sendJson(response, 404, { error: "Project not found." });
        }
        if (request.method === "GET" && action === "file") {
          if (!url.searchParams.has("path")) return sendJson(response, 400, { error: "Choose a file path." });
          const artifact = await store.readArtifact(projectId, ownerId, url.searchParams.get("path"));
          if (!artifact) return sendJson(response, 404, { error: "File not found." });
          if (url.searchParams.get("download") === "1") {
            response.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${path.basename(artifact.path)}"`,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff"
            });
            return response.end(artifact.contents);
          }
          return sendJson(response, 200, { artifact });
        }
        if (request.method === "POST" && action === "files") {
          const body = await readJson(request, 300 * 1024);
          if (!body || typeof body.path !== "string" || typeof body.contents !== "string"
            || Buffer.byteLength(body.contents, "utf8") > 256 * 1024) {
            return sendJson(response, 400, { error: "Provide a project-relative path and text contents (up to 256 KiB)." });
          }
          const language = typeof body.language === "string" ? body.language : "text";
          const artifact = await store.createArtifact(projectId, ownerId, body.path, body.contents, language);
          return artifact ? sendJson(response, 201, { artifact, status: "VERIFIED" })
            : sendJson(response, 404, { error: "Project not found." });
        }
        if (request.method === "POST" && action === "upload") {
          const body = await readJson(request, 400 * 1024);
          if (!body || typeof body.path !== "string" || typeof body.contentsBase64 !== "string"
            || body.contentsBase64.length > 350 * 1024
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentsBase64)) {
            return sendJson(response, 400, { error: "Upload one UTF-8 text file with a safe project-relative path (maximum 256 KiB)." });
          }
          const bytes = Buffer.from(body.contentsBase64, "base64");
          if (bytes.length > 256 * 1024 || bytes.toString("base64") !== body.contentsBase64) {
            return sendJson(response, 400, { error: "Uploaded text file exceeds 256 KiB or is not valid base64." });
          }
          let contents;
          try {
            contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            return sendJson(response, 415, { error: "Only UTF-8 text files are supported; binary asset uploads are unavailable." });
          }
          if (contents.includes("\u0000")) {
            return sendJson(response, 415, { error: "Binary file contents are not supported by this text artifact store." });
          }
          const language = typeof body.language === "string" ? body.language : "text";
          const artifact = await store.createArtifact(projectId, ownerId, body.path, contents, language);
          return artifact ? sendJson(response, 201, { artifact, status: "VERIFIED" })
            : sendJson(response, 404, { error: "Project not found." });
        }
        if (request.method === "PUT" && action === "file") {
          const body = await readJson(request, 300 * 1024);
          if (!url.searchParams.has("path") || !body || typeof body.contents !== "string"
            || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1
            || Buffer.byteLength(body.contents, "utf8") > 256 * 1024) {
            return sendJson(response, 400, { error: "Provide a file path, contents, and the version you opened." });
          }
          const artifact = await store.writeArtifact(projectId, ownerId, url.searchParams.get("path"),
            body.contents, body.expectedVersion, "Saved by the project owner.");
          return artifact ? sendJson(response, 200, { artifact, status: "VERIFIED" })
            : sendJson(response, 404, { error: "File not found." });
        }
        if (request.method === "DELETE" && action === "file") {
          const version = Number(url.searchParams.get("version"));
          if (!url.searchParams.has("path") || !Number.isInteger(version) || version < 1) {
            return sendJson(response, 400, { error: "Provide the file path and current version." });
          }
          const deleted = await store.deleteArtifact(projectId, ownerId, url.searchParams.get("path"), version);
          return deleted ? sendJson(response, 200, { status: "VERIFIED", deleted: true })
            : sendJson(response, 404, { error: "File not found." });
        }
        if (request.method === "GET" && action === "history") {
          if (!url.searchParams.has("path")) return sendJson(response, 400, { error: "Choose a file path." });
          const history = await store.artifactHistory(projectId, ownerId, url.searchParams.get("path"));
          return history ? sendJson(response, 200, { history }) : sendJson(response, 404, { error: "Project or file not found." });
        }
        if (request.method === "POST" && action === "restore") {
          const body = await readJson(request);
          if (!body || typeof body.path !== "string" || !Number.isInteger(body.version)
            || body.version < 1 || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
            return sendJson(response, 400, { error: "Choose a file, saved version, and current version." });
          }
          const artifact = await store.restoreArtifact(projectId, ownerId, body.path, body.version, body.expectedVersion);
          return artifact ? sendJson(response, 200, { artifact, status: "VERIFIED" })
            : sendJson(response, 404, { error: "File or saved version not found." });
        }
        if (request.method === "POST" && action === "rename") {
          const body = await readJson(request);
          if (!body || typeof body.fromPath !== "string" || typeof body.toPath !== "string"
            || !["file", "directory"].includes(body.kind)) {
            return sendJson(response, 400, { error: "Provide a source path, destination path, and file or folder type." });
          }
          if (body.kind === "directory") {
            const renamed = await store.renameArtifactDirectory(projectId, ownerId, body.fromPath, body.toPath);
            return renamed ? sendJson(response, 200, { status: "VERIFIED" })
              : sendJson(response, 404, { error: "Folder not found." });
          }
          if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
            return sendJson(response, 400, { error: "Provide the file version you opened." });
          }
          const artifact = await store.renameArtifact(projectId, ownerId, body.fromPath, body.toPath, body.expectedVersion);
          return artifact ? sendJson(response, 200, { artifact, status: "VERIFIED" })
            : sendJson(response, 404, { error: "File not found." });
        }
        if (request.method === "POST" && action === "duplicate") {
          const body = await readJson(request);
          if (!body || typeof body.fromPath !== "string" || typeof body.toPath !== "string") {
            return sendJson(response, 400, { error: "Provide the source file and a new destination path." });
          }
          const artifact = await store.duplicateArtifact(projectId, ownerId, body.fromPath, body.toPath);
          return artifact ? sendJson(response, 201, { artifact, status: "VERIFIED" })
            : sendJson(response, 404, { error: "File not found." });
        }
        if (request.method === "POST" && action === "directories") {
          const body = await readJson(request);
          if (!body || typeof body.path !== "string") return sendJson(response, 400, { error: "Provide a folder path." });
          const directory = await store.createArtifactDirectory(projectId, ownerId, body.path);
          return directory ? sendJson(response, 201, { directory, status: "VERIFIED" })
            : sendJson(response, 404, { error: "Project not found." });
        }
        if (request.method === "PATCH" && action === "directories") {
          const body = await readJson(request);
          if (!body || typeof body.fromPath !== "string" || typeof body.toPath !== "string") {
            return sendJson(response, 400, { error: "Provide the current and new folder path." });
          }
          const renamed = await store.renameArtifactDirectory(projectId, ownerId, body.fromPath, body.toPath);
          return renamed ? sendJson(response, 200, { status: "VERIFIED" })
            : sendJson(response, 404, { error: "Folder not found." });
        }
        if (request.method === "DELETE" && action === "directories") {
          if (!url.searchParams.has("path")) return sendJson(response, 400, { error: "Choose a folder path." });
          const deleted = await store.deleteArtifactDirectory(projectId, ownerId, url.searchParams.get("path"));
          return deleted ? sendJson(response, 200, { status: "VERIFIED", deleted: true })
            : sendJson(response, 404, { error: "Folder not found." });
        }
        if (request.method === "GET" && action === "audit") {
          const audit = await store.artifactAudit(projectId, ownerId);
          return audit ? sendJson(response, 200, { audit }) : sendJson(response, 404, { error: "Project not found." });
        }
        if (request.method === "GET" && action === "export") {
          const tree = await store.listArtifacts(projectId, ownerId);
          if (!tree) return sendJson(response, 404, { error: "Project not found." });
          const files = [];
          let totalBytes = 0;
          for (const entry of tree.files) {
            const artifact = await store.readArtifact(projectId, ownerId, entry.path);
            totalBytes += artifact.sizeBytes;
            if (totalBytes > 4 * 1024 * 1024) return sendJson(response, 413, { error: "Project export exceeds the 4 MiB download limit." });
            files.push({ path: artifact.path, contents: artifact.contents, checksum: artifact.checksum });
          }
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="gods-project-${projectId}.json"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
          });
          return response.end(JSON.stringify({ projectId, files, directories: tree.directories }));
        }
        if (request.method === "GET" && action === "zip") {
          const tree = await store.listArtifacts(projectId, ownerId);
          if (!tree) return sendJson(response, 404, { error: "Project not found." });
          const files = [];
          for (const entry of tree.files) {
            const artifact = await store.readArtifact(projectId, ownerId, entry.path);
            if (!artifact) return sendJson(response, 409, { error: "Project changed while preparing the ZIP; retry the export." });
            files.push({ path: artifact.path, contents: artifact.contents });
          }
          const archive = await createVerifiedProjectZip(files);
          response.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="gods-project-${projectId}.zip"`,
            "content-length": archive.length,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
          });
          return response.end(archive);
        }
        if (request.method === "POST" && action === "zip-import") {
          const body = await readJson(request, 7 * 1024 * 1024);
          if (!body || typeof body.archiveBase64 !== "string"
            || body.archiveBase64.length > 6 * 1024 * 1024
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.archiveBase64)) {
            return sendJson(response, 400, { error: "Provide a base64-encoded ZIP archive within the upload limit." });
          }
          const archive = Buffer.from(body.archiveBase64, "base64");
          if (archive.toString("base64") !== body.archiveBase64) {
            return sendJson(response, 400, { error: "ZIP archive encoding is invalid." });
          }
          let files;
          try {
            files = await readVerifiedProjectZip(archive);
          } catch (error) {
            return sendJson(response, 400, { error: error.message });
          }
          if (!files.length) return sendJson(response, 400, { error: "ZIP archive contains no importable text files." });
          const imported = await store.importArtifacts(projectId, ownerId, files);
          return imported ? sendJson(response, 201, {
            status: "VERIFIED",
            imported: imported.map((artifact) => ({ path: artifact.path, version: artifact.version, checksum: artifact.checksum }))
          }) : sendJson(response, 404, { error: "Project not found." });
        }
        return sendJson(response, 405, { error: "File operation is not supported." });
      }

      const projectRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})(?:\/(approve|blueprint))?$/);
      if (request.method === "GET" && projectRoute && projectRoute[2] !== "approve") {
        const project = await store.get(projectRoute[1]);
        if (!project || project.ownerId !== request.authenticatedUser.id) {
          return sendJson(response, 404, { error: "Project not found." });
        }
        if (projectRoute[2] === "blueprint") {
          response.writeHead(200, {
            "content-type": "application/yaml; charset=utf-8",
            "content-disposition": `attachment; filename="gods.blueprint.yaml"`,
            "x-content-type-options": "nosniff"
          });
          return response.end(serializeBlueprint(project.blueprint));
        }
        return sendJson(response, 200, { project });
      }

      if (request.method === "POST" && projectRoute?.[2] === "approve") {
        const project = await store.get(projectRoute[1]);
        if (!project || project.ownerId !== request.authenticatedUser.id) {
          return sendJson(response, 404, { error: "Project not found." });
        }
        if (project.status !== "DRAFT") return sendJson(response, 409, { error: "This project plan has already been approved." });
        const body = await readJson(request);
        try {
          approveRequirements(project, body && typeof body === "object" ? body.decisions : undefined);
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
        await store.update(project);
        return sendJson(response, 200, { project });
      }

      return sendJson(response, 404, { error: "Route not found." });
    } catch (error) {
      if (error instanceof ProviderError) {
        const safe = sanitizeError(error);
        if (safe.code === "PROVIDER_BLOCKED" || safe.code === "SECRET_KEY_MISSING") {
          return sendJson(response, 503, { status: "BLOCKED", reason: safe.message, code: safe.code });
        }
        const status = ({
          SECRET_KEY_MISSING: 503,
          SECRET_KEY_INVALID: 503,
          INVALID_PROVIDER_URL: 400,
          INSECURE_PROVIDER_URL: 400,
          PROVIDER_HOST_NOT_SUPPORTED: 400,
          PRIVATE_PROVIDER_URL: 400,
          PROVIDER_DNS_FAILED: 502,
          PROVIDER_BLOCKED: 503,
          PROVIDER_AUTH_FAILED: 502,
          PROVIDER_RATE_LIMITED: 502,
          PROVIDER_UNAVAILABLE: 502,
          PROVIDER_TIMEOUT: 504,
          PROVIDER_NETWORK_ERROR: 502,
          PROVIDER_INVALID_RESPONSE: 502,
          PROVIDER_INVALID_JSON: 502,
          MODEL_NOT_FOUND: 502
        }[safe.code] || 502);
        return sendJson(response, status, { error: safe.message, code: safe.code });
      }
      const status = error.status || ({
        PROTECTED_ARTIFACT: 403,
        VERSION_CONFLICT: 409,
        PATH_CONFLICT: 409,
        ARTIFACTS_EXIST: 409,
        ARTIFACT_EXISTS: 409,
        PROJECT_NOT_APPROVED: 409,
        EXECUTION_GRAPH_EXISTS: 409,
        EXECUTION_GRAPH_CONFLICT: 409,
        INVALID_BLUEPRINT: 422
      }[error.code]);
      if (status) return sendJson(response, status, { error: error.message });
      console.error(JSON.stringify({
        event: "request.failed",
        method: request.method,
        error: error.message
      }));
      return sendJson(response, 500, { error: "An unexpected server error occurred." });
    }
  });

return { server, store, gameStore, authStore, orchestrator, projectGenerator, providerService };
}

if (require.main === module) {
const { server, store, gameStore, authStore } = createServer();
Promise.all([store.initialize(), gameStore.initialize(), authStore.initialize()])
    .then(() => server.listen(Number(process.env.PORT) || 3000, process.env.HOST || "127.0.0.1", () => {
      console.log(`Master GODS is available at http://${server.address().address}:${server.address().port}`);
    }))
    .catch((error) => {
      console.error("Could not initialize project storage.", error.message);
      process.exitCode = 1;
    });
}

module.exports = { createServer };
