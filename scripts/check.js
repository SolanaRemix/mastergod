const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const directories = ["src", "public", "scripts", "test"];
const files = ["server.js"];
const typeScriptFiles = [];

function collectSources(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSources(relative);
    else if (entry.isFile() && relative.endsWith(".js")) files.push(relative);
    else if (entry.isFile() && relative.endsWith(".ts")) typeScriptFiles.push(relative);
  }
}

for (const directory of directories) collectSources(directory);

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const file of typeScriptFiles) {
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "-e",
    "require(process.argv[1])",
    path.join(root, file)
  ], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

try {
  const blueprint = JSON.parse(fs.readFileSync(path.join(root, "gods.blueprint.yaml"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const validStatuses = new Set([
    "VERIFIED",
    "IMPLEMENTED_UNVERIFIED",
    "PARTIALLY_IMPLEMENTED",
    "MISSING",
    "BLOCKED",
    "FAILED",
    "UNKNOWN",
    "NOT_APPLICABLE"
  ]);
  if (blueprint.project?.version !== manifest.version || blueprint.blueprintVersion !== manifest.version) {
    throw new Error("Blueprint and package versions must match.");
  }
  if (!Array.isArray(blueprint.requirements) || !Array.isArray(blueprint.release?.acceptanceGates)
    || blueprint.release.acceptanceGates.length !== 35) {
    throw new Error("The blueprint must contain requirements and all 35 V12/V13 acceptance gates.");
  }
  for (const requirement of blueprint.requirements) {
    if (!requirement.id || !validStatuses.has(requirement.status)) {
      throw new Error(`Requirement ${requirement.id || "(unknown)"} has an invalid status.`);
    }
  }
  for (const gate of blueprint.release.acceptanceGates) {
    if (!Number.isInteger(gate.id) || !gate.name || !validStatuses.has(gate.status)) {
      throw new Error(`Acceptance gate ${gate.id || "(unknown)"} is incomplete or has an invalid status.`);
    }
  }
} catch (error) {
  console.error(`The project blueprint is not valid JSON/YAML-subset data: ${error.message}`);
  process.exitCode = 1;
}
