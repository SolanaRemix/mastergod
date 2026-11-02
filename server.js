const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { approveRequirements, createDraft, serializeBlueprint } = require("./src/blueprint");
const { agents } = require("./src/agents");
const { AuthService } = require("./src/auth");
const { createGameProject, generatePlayableHtml, refineGameSpecification } = require("./src/game-studio");
const { AuthStore, GameStore, ProjectStore } = require("./src/store");

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

async function readJson(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
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

function createServer({ dataDir = process.env.GODS_DATA_DIR || path.join(__dirname, "data") } = {}) {
  const store = new ProjectStore(dataDir);
  const gameStore = new GameStore(dataDir);
  const authStore = new AuthStore(dataDir);
  const auth = new AuthService(authStore);
  const secureCookies = process.env.NODE_ENV === "production";
  const sessionCookieName = secureCookies ? "__Host-gods_session" : "gods_session";
  const allowRegistration = createRateLimiter({ limit: 25, windowMs: 60 * 60 * 1000 });
  const allowLogin = createRateLimiter({ limit: 20, windowMs: 15 * 60 * 1000 });
  const allowGameCreation = createRateLimiter({ limit: 8, windowMs: 60 * 60 * 1000 });
  const allowGameChanges = createRateLimiter({ limit: 60, windowMs: 60 * 60 * 1000 });

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
          persistence: persistenceReady ? "sqlite" : "FAILED",
          authentication: "ENABLED",
          gameStudio: "IMPLEMENTED_UNVERIFIED",
          gameStudioEngine: "HTML5 Canvas 2D local template",
          aiProviders: "BLOCKED",
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

      if (request.method === "GET" && url.pathname === "/api/agents") {
        return sendJson(response, 200, { agents });
      }

      if (request.method === "GET" && url.pathname === "/api/games") {
        return sendJson(response, 200, { games: await gameStore.list(request.authenticatedUser.id) });
      }

      if (request.method === "POST" && url.pathname === "/api/games") {
        if (!allowGameCreation(request.authenticatedUser.id)) {
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
      if (error.status) return sendJson(response, error.status, { error: error.message });
      console.error(JSON.stringify({
        event: "request.failed",
        method: request.method,
        error: error.message
      }));
      return sendJson(response, 500, { error: "An unexpected server error occurred." });
    }
  });

return { server, store, gameStore, authStore };
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
