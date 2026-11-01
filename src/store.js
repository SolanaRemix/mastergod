const fs = require("node:fs/promises");
const path = require("node:path");

class ProjectStore {
  constructor(root) {
    this.root = root;
  }

  async initialize() {
    await fs.mkdir(path.join(this.root, "projects"), { recursive: true, mode: 0o700 });
  }

  directoryFor(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid project ID.");
    return path.join(this.root, "projects", id);
  }

  async create(project) {
    const directory = this.directoryFor(project.id);
    await fs.mkdir(directory, { mode: 0o700 });
    await this.writeFile(path.join(directory, "project.json"), project);
    await this.writeFile(path.join(directory, "gods.blueprint.yaml"), project.blueprint);
    return project;
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.directoryFor(id), "project.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async list() {
    const directory = path.join(this.root, "projects");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const projects = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name))
      .map((entry) => this.get(entry.name)));
    return projects.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async update(project) {
    const directory = this.directoryFor(project.id);
    await this.writeFile(path.join(directory, "project.json"), project);
    await this.writeFile(path.join(directory, "gods.blueprint.yaml"), project.blueprint);
    return project;
  }

  async writeFile(destination, value) {
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fs.rename(temporary, destination);
  }
}

module.exports = { ProjectStore };
