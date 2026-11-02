const { createHash, randomUUID } = require("node:crypto");
const path = require("node:path");

const SAFE_ARTIFACT_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,180}$/;
const PROTECTED_ARTIFACT_PATHS = new Set(["package.json", "src/server.js", "src/specification.js"]);
const FEATURE_CATALOG = [
  { slug: "drivers", name: "Driver management", pattern: /\bdrivers?\b/i },
  { slug: "vehicles", name: "Vehicle management", pattern: /\bvehicles?\b|\bfleet\b|\btrucks?\b/i },
  { slug: "dispatch", name: "Dispatch and routing", pattern: /\bdispatch\b|\broutes?\b|\bdeliver(?:y|ies)\b/i },
  { slug: "loads", name: "Load tracking", pattern: /\bloads?\b|\bfreight\b|\bshipments?\b/i },
  { slug: "customers", name: "Customer management", pattern: /\bcustomers?\b|\bclients?\b/i },
  { slug: "invoices", name: "Invoicing and payments", pattern: /\binvoices?\b|\bpayments?\b|\bbilling\b/i },
  { slug: "maintenance", name: "Maintenance tracking", pattern: /\bmaintenance\b|\brepairs?\b|\bservice records?\b/i },
  { slug: "compliance", name: "Compliance records", pattern: /\bcompliance\b|\bdocuments?\b|\binspections?\b/i },
  { slug: "reports", name: "Reporting", pattern: /\breports?\b|\banalytics\b|\bmetrics\b/i },
  { slug: "admin", name: "Administration", pattern: /\badmins?\b|\badministrators?\b|\bmanage everything\b/i },
  { slug: "agents", name: "Agent orchestration", pattern: /\bagents?\b|\borchestrat(?:e|ion)\b|\bworkflows?\b/i },
  { slug: "models", name: "Model routing", pattern: /\bmodels?\b|\bproviders?\b|\bLLMs?\b|\bAI\b/i },
  { slug: "knowledge", name: "Knowledge base", pattern: /\bknowledge base\b|\bdocuments?\b|\bsearch\b/i },
  { slug: "chat", name: "Conversation interface", pattern: /\bchat\b|\bconversational\b|\bmessages?\b/i },
  { slug: "gameplay", name: "Game mechanics and controls", pattern: /\bgames?\b|\bgameplay\b|\bcontrols?\b/i },
  { slug: "levels", name: "Levels and progression", pattern: /\blevels?\b|\bprogression\b|\bquests?\b/i },
  { slug: "scores", name: "Scoring", pattern: /\bscores?\b|\bleaderboards?\b|\bachievements?\b/i },
  { slug: "assets", name: "Assets and media", pattern: /\bassets?\b|\bsprites?\b|\bcharacters?\b|\baudio\b|\bmusic\b/i },
  { slug: "accounts", name: "User accounts", pattern: /\busers?\b|\baccounts?\b|\bauthentication\b|\blogin\b/i },
  { slug: "bookings", name: "Bookings and scheduling", pattern: /\bbookings?\b|\bappointments?\b|\bscheduling\b|\bcalendar\b/i }
];

function sha256(contents) {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function validateArtifactPath(value) {
  if (
    typeof value !== "string"
    || !SAFE_ARTIFACT_PATH.test(value)
    || value.includes("\\")
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || path.posix.normalize(value) !== value
  ) {
    const error = new Error("Choose a safe project-relative file path.");
    error.status = 400;
    throw error;
  }
  if (value.split("/").some((segment) => [".git", "node_modules", ".env"].includes(segment))) {
    const error = new Error("System, dependency, and secret files are not managed as project artifacts.");
    error.status = 400;
    throw error;
  }
  return value;
}

function isProtectedArtifactPath(value) {
  return PROTECTED_ARTIFACT_PATHS.has(value);
}

function featureListForProject(project) {
  const prompt = project.requirements
    .filter((requirement) => requirement.decision === "APPROVED")
    .map((requirement) => requirement.text)
    .join(" ");
  const requestedFeatures = FEATURE_CATALOG.filter((feature) => feature.pattern.test(prompt));
  if (requestedFeatures.length) return requestedFeatures;
  return [
    { slug: "core-workflow", name: "Core application workflow" },
    { slug: "user-interface", name: "User interface" }
  ];
}

function literal(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function moduleSource(feature, requirementIds) {
  return `"use strict";

const feature = ${literal({ slug: feature.slug, name: feature.name, requirementIds })};

function createService() {
  const records = new Map();
  return Object.freeze({
    list() {
      return [...records.values()].map((record) => structuredClone(record));
    },
    get(id) {
      const record = records.get(id);
      return record ? structuredClone(record) : null;
    },
    create(record) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new TypeError("A record object is required.");
      }
      const id = require("node:crypto").randomUUID();
      const created = { id, ...structuredClone(record) };
      records.set(id, created);
      return structuredClone(created);
    },
    update(id, changes) {
      const current = records.get(id);
      if (!current) return null;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        throw new TypeError("A changes object is required.");
      }
      const updated = { ...current, ...structuredClone(changes), id };
      records.set(id, updated);
      return structuredClone(updated);
    },
    remove(id) {
      return records.delete(id);
    }
  });
}

module.exports = { feature, createService };
`;
}

function manifestSource(project, features) {
  const specification = {
    projectId: project.id,
    title: project.title,
    originalRequest: project.originalRequest,
    requirements: project.requirements.map(({ id, text, decision }) => ({ id, text, decision })),
    features: features.map(({ slug, name }) => ({ slug, name })),
    generation: {
      method: "local deterministic scaffold",
      providerExecution: "BLOCKED",
      persistence: "in-memory prototype only",
      authentication: "not implemented",
      productionStatus: "IMPLEMENTED_UNVERIFIED"
    }
  };
  return `"use strict";\n\nmodule.exports = ${literal(specification)};\n`;
}

function serverSource(features) {
  const moduleImports = features.map((feature, index) =>
    `const feature${index} = require("./features/${feature.slug}.js");`
  ).join("\n");
  const featureMap = features.map((feature, index) =>
    `  [feature${index}.feature.slug, { definition: feature${index}.feature, service: feature${index}.createService() }]`
  ).join(",\n");

  return `"use strict";

const http = require("node:http");
const specification = require("./specification.js");
${moduleImports}
const features = new Map([
${featureMap}
]);
const maximumBodyBytes = 64 * 1024;

function send(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBodyBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/health") {
      return send(response, 200, { status: "IMPLEMENTED_UNVERIFIED", projectId: specification.projectId });
    }
    if (request.method === "GET" && url.pathname === "/api/specification") {
      return send(response, 200, specification);
    }
    const route = url.pathname.match(/^\\/api\\/features\\/([a-z0-9-]+)(?:\\/records(?:\\/([a-f0-9-]+))?)?$/);
    if (!route || !features.has(route[1])) return send(response, 404, { error: "Feature route not found." });
    const { definition, service } = features.get(route[1]);
    if (request.method === "GET" && route[2] === undefined && route[0] === url.pathname) {
      return send(response, 200, { feature: definition });
    }
    if (request.method === "GET" && route[0].endsWith("/records")) return send(response, 200, { records: service.list() });
    if (route[2] && request.method === "GET") {
      const record = service.get(route[2]);
      return record ? send(response, 200, { record }) : send(response, 404, { error: "Record not found." });
    }
    if (request.method === "POST" && route[0].endsWith("/records")) {
      const record = service.create(await readJson(request));
      return send(response, 201, { record });
    }
    if (route[2] && request.method === "PATCH") {
      const record = service.update(route[2], await readJson(request));
      return record ? send(response, 200, { record }) : send(response, 404, { error: "Record not found." });
    }
    if (route[2] && request.method === "DELETE") {
      return service.remove(route[2])
        ? send(response, 200, { status: "deleted" })
        : send(response, 404, { error: "Record not found." });
    }
    return send(response, 405, { error: "Method not supported." });
  } catch (error) {
    return send(response, error.status || 500, { error: error.status ? error.message : "The request failed." });
  }
});

server.listen(Number(process.env.PORT) || 3001, process.env.HOST || "127.0.0.1", () => {
  console.log("Generated prototype listening on its local interface.");
});
`;
}

function generateProjectArtifacts(project, now = new Date().toISOString()) {
  const features = featureListForProject(project);
  const requirementIds = project.requirements
    .filter((requirement) => requirement.decision === "APPROVED")
    .map((requirement) => requirement.id);
  const files = [
    {
      path: "README.md",
      language: "markdown",
      contents: `# ${project.title}

## What this prototype was planned to do

${project.originalRequest}

## Request-specific modules

${features.map((feature) => `- \`${feature.slug}\`: ${feature.name}`).join("\n")}

## Run locally

Use Node.js ${process.versions.node.split(".")[0]} or later and run \`node src/server.js\`. The prototype binds to \`127.0.0.1\` by default.

## Verification and limitations

These files are a request-specific deterministic scaffold generated from the saved project requirements; no model provider or background agent executed. Feature records are held in memory and are lost when the process restarts. Authentication, durable database storage, production security review, deployment, and generated-project acceptance tests are not included. Do not expose this prototype to an untrusted network.
`,
      requirementIds
    },
    {
      path: "package.json",
      language: "json",
      contents: `${JSON.stringify({
  name: `gods-project-${project.id.slice(0, 12)}`,
  version: "0.1.0",
  private: true,
  description: `Request-specific prototype for ${project.title}`,
  scripts: { start: "node src/server.js" },
  engines: { node: ">=22.13.0" }
}, null, 2)}\n`,
      requirementIds
    },
    {
      path: "src/specification.js",
      language: "javascript",
      contents: manifestSource(project, features),
      requirementIds
    },
    {
      path: "src/server.js",
      language: "javascript",
      contents: serverSource(features),
      requirementIds
    },
    ...features.map((feature) => ({
      path: `src/features/${feature.slug}.js`,
      language: "javascript",
      contents: moduleSource(feature, requirementIds),
      requirementIds
    }))
  ];

  const taskId = `LOCAL-SCAFFOLD-${project.id}`;
  return files.map((file) => {
    const contents = file.contents;
    return {
      ...file,
      sizeBytes: Buffer.byteLength(contents, "utf8"),
      checksum: sha256(contents),
      status: "IMPLEMENTED_UNVERIFIED",
      responsibleAgent: "local-request-scaffolder",
      taskId,
      requirementIds: file.requirementIds,
      generatedAt: now,
      id: randomUUID()
    };
  });
}

module.exports = {
  featureListForProject,
  generateProjectArtifacts,
  isProtectedArtifactPath,
  sha256,
  validateArtifactPath
};
