const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function build() {
  const root = path.join(__dirname, "..");
  const manifest = require(path.join(root, "package.json"));
  const revision = process.env.GITHUB_SHA || "local";
  if (!/^(?:[a-f0-9]{7,64}|local)$/i.test(revision)) {
    throw new Error("Build revision must be a Git SHA.");
  }

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "master-gods-release-"));
  const outputDirectory = path.join(root, "dist");
  const archive = path.join(outputDirectory, `master-gods-${manifest.version}-${revision.slice(0, 12)}.tar.gz`);
  const files = [
    "README.md",
    "LICENSE",
    "package.json",
    "server.js",
    "gods.blueprint.yaml",
    "docs",
    "src",
    "public",
    path.join("scripts", "provision-admin.js")
  ];

  try {
    await fs.mkdir(outputDirectory, { recursive: true });
    for (const file of files) {
      const source = path.join(root, file);
      try {
        await fs.access(source);
      } catch (error) {
        if (error.code === "ENOENT" && file === "LICENSE") continue;
        throw new Error(`Release input is missing: ${file}`);
      }
      await fs.cp(source, path.join(stage, file), { recursive: true });
    }

    execFileSync("tar", ["-czf", archive, "-C", stage, "."], { stdio: "inherit" });
    console.log(`Created ${path.relative(root, archive)}`);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

build().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
