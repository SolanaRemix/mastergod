const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { approveRequirements, createDraft, serializeBlueprint } = require("./src/blueprint");
const { agents } = require("./src/agents");
const { ProjectStore } = require("./src/store");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 64 * 1024;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
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

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && await serveStatic(response, url.pathname)) return;

      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, {
          status: "VERIFIED",
          application: "available",
          persistence: "local-file-store",
          authentication: "MISSING",
          aiProviders: "BLOCKED",
          productionReady: false
        });
      }

      if (request.method === "GET" && url.pathname === "/api/agents") {
        return sendJson(response, 200, { agents });
      }

      if (request.method === "GET" && url.pathname === "/api/projects") {
        return sendJson(response, 200, { projects: await store.list() });
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        const body = await readJson(request);
        if (typeof body.prompt !== "string" || body.prompt.trim().length < 10 || body.prompt.length > 10000) {
          return sendJson(response, 400, { error: "Describe the application in at least 10 characters (up to 10,000)." });
        }
        const project = await store.create(createDraft(body.prompt.trim()));
        return sendJson(response, 201, { project });
      }

      const projectRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})(?:\/(approve|blueprint))?$/);
      if (request.method === "GET" && projectRoute?.[2] !== "approve") {
        const project = await store.get(projectRoute[1]);
        if (!project) return sendJson(response, 404, { error: "Project not found." });
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
        if (!project) return sendJson(response, 404, { error: "Project not found." });
        if (project.status !== "DRAFT") return sendJson(response, 409, { error: "This project plan has already been approved." });
        const body = await readJson(request);
        try {
          approveRequirements(project, body.decisions);
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

  return { server, store };
}

if (require.main === module) {
  const { server, store } = createServer();
  store.initialize()
    .then(() => server.listen(Number(process.env.PORT) || 3000, process.env.HOST || "127.0.0.1", () => {
      console.log(`Master GODS is available at http://${server.address().address}:${server.address().port}`);
    }))
    .catch((error) => {
      console.error("Could not initialize project storage.", error.message);
      process.exitCode = 1;
    });
}

module.exports = { createServer };
