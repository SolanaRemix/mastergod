const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { validateArtifactPath } = require("./artifacts");

const MAX_PROJECT_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_FILES = 500;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: MAX_PROJECT_BYTES + 64 * 1024,
    ...options
  });
  if (result.error) throw new Error(`${command} is unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed to create or verify the project archive.`);
  return result.stdout;
}

async function createVerifiedProjectZip(files) {
  if (!Array.isArray(files) || files.length > MAX_PROJECT_FILES) {
    throw new Error(`Project ZIP supports at most ${MAX_PROJECT_FILES} files.`);
  }
  let totalBytes = 0;
  const checked = files.map((file) => {
    const artifactPath = validateArtifactPath(file.path);
    if (typeof file.contents !== "string") throw new Error("Project ZIP only supports stored text artifacts.");
    const size = Buffer.byteLength(file.contents, "utf8");
    totalBytes += size;
    if (totalBytes > MAX_PROJECT_BYTES) throw new Error("Project ZIP exceeds the 4 MiB uncompressed limit.");
    return { path: artifactPath, contents: file.contents };
  });
  if (new Set(checked.map((file) => file.path)).size !== checked.length) {
    throw new Error("Project ZIP cannot contain duplicate paths.");
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gods-project-zip-"));
  const archivePath = path.join(temporaryDirectory, "project.zip");
  try {
    for (const file of checked) {
      const outputPath = path.join(temporaryDirectory, ...file.path.split("/"));
      await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(outputPath, file.contents, { flag: "wx", mode: 0o600 });
    }

    if (checked.length) {
      run("zip", ["-q", "-X", archivePath, ...checked.map((file) => `./${file.path}`)], { cwd: temporaryDirectory });
    } else {
      const emptyZip = Buffer.alloc(22);
      emptyZip.writeUInt32LE(0x06054b50, 0);
      await fs.writeFile(archivePath, emptyZip, { mode: 0o600 });
    }
    run("unzip", ["-tqq", archivePath]);
    const listedPaths = run("unzip", ["-Z", "-1", archivePath])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((entry) => validateArtifactPath(entry.replace(/\/$/, "")));
    if (listedPaths.length !== checked.length
      || new Set(listedPaths).size !== checked.length
      || checked.some((file) => !listedPaths.includes(file.path))) {
      throw new Error("Project ZIP contents did not pass path and file-list verification.");
    }
    for (const file of checked) {
      const extracted = spawnSync("unzip", ["-p", archivePath, file.path], {
        encoding: "buffer",
        timeout: 15_000,
        maxBuffer: MAX_PROJECT_BYTES + 1
      });
      if (extracted.error || extracted.status !== 0
        || !Buffer.isBuffer(extracted.stdout)
        || !extracted.stdout.equals(Buffer.from(file.contents, "utf8"))) {
        throw new Error(`Project ZIP read-back verification failed for ${file.path}.`);
      }
    }
    return await fs.readFile(archivePath);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = { createVerifiedProjectZip, MAX_PROJECT_BYTES, MAX_PROJECT_FILES };
