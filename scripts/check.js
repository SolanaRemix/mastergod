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
  JSON.parse(fs.readFileSync(path.join(root, "gods.blueprint.yaml"), "utf8"));
} catch (error) {
  console.error(`The project blueprint is not valid JSON/YAML-subset data: ${error.message}`);
  process.exitCode = 1;
}
