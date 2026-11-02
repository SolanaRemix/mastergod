const { createHash } = require("node:crypto");
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

module.exports = {
  featureListForProject,
  isProtectedArtifactPath,
  sha256,
  validateArtifactPath
};
