const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { approveRequirements, createDraft, serializeBlueprint } = require("./src/blueprint");
const { agents } = require("./src/agents");
const { AuthService } = require("./src/auth");
const { AuthStore, ProjectStore } = require("./src/store");

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
  const authStore = new AuthStore(dataDir);
  const auth = new AuthService(authStore);
  const secureCookies = process.env.NODE_ENV === "production";
  const sessionCookieName = secureCookies ? "__Host-gods_session" : "gods_session";
  const allowRegistration = createRateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });
  const allowLogin = createRateLimiter({ limit: 20, windowMs: 15 * 60 * 1000 });

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

      if (request.method === "POST" && ["/api/auth/register", "/api/auth/login", "/api/auth/logout"].includes(url.pathname)) {
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

        let user;
        if (url.pathname.endsWith("/register")) {
          try {
            user = await auth.register(body.email, body.password);
          } catch (error) {
            return sendJson(response, error.message.includes("already exists") ? 409 : 400, { error: error.message });
          }
        } else {
          user = await auth.login(body.email, body.password);
          if (!user) return sendJson(response, 401, { error: "Email or password is incorrect." });
        }

        const session = await auth.createSession(user.id);
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

      if (request.method === "GET" && url.pathname === "/api/agents") {
        return sendJson(response, 200, { agents });
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

return { server, store, authStore };
}

if (require.main === module) {
const { server, store, authStore } = createServer();
Promise.all([store.initialize(), authStore.initialize()])
    .then(() => server.listen(Number(process.env.PORT) || 3000, process.env.HOST || "127.0.0.1", () => {
      console.log(`Master GODS is available at http://${server.address().address}:${server.address().port}`);
    }))
    .catch((error) => {
      console.error("Could not initialize project storage.", error.message);
      process.exitCode = 1;
    });
}

module.exports = { createServer };
