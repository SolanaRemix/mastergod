const fs = require("node:fs/promises");
const path = require("node:path");

class AuthStore {
  constructor(root) {
    this.root = root;
    this.statePath = path.join(root, "auth.json");
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await fs.access(this.statePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save({ users: [], sessions: [] });
    }
  }

  async read() {
    return JSON.parse(await fs.readFile(this.statePath, "utf8"));
  }

  async save(state) {
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fs.rename(temporary, this.statePath);
  }

  async update(operation) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const state = await this.read();
      const result = await operation(state);
      await this.save(state);
      return result;
    } finally {
      release();
    }
  }

  async createUser(user) {
    return this.update((state) => {
      if (state.users.some((existing) => existing.email === user.email)) return null;
      state.users.push(user);
      return user;
    });
  }

  async findUserByEmail(email) {
    const state = await this.read();
    return state.users.find((user) => user.email === email) || null;
  }

  async findUserById(id) {
    const state = await this.read();
    return state.users.find((user) => user.id === id) || null;
  }

  async createSession(session) {
    await this.update((state) => {
      const now = Date.now();
      state.sessions = state.sessions.filter((existing) => Date.parse(existing.expiresAt) > now);
      state.sessions.push(session);
    });
  }

  async findSession(tokenHash) {
    const state = await this.read();
    return state.sessions.find((session) => session.tokenHash === tokenHash) || null;
  }

  async deleteSession(tokenHash) {
    await this.update((state) => {
      state.sessions = state.sessions.filter((session) => session.tokenHash !== tokenHash);
    });
  }
}

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

  async list(ownerId) {
    const directory = path.join(this.root, "projects");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const projects = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name))
      .map((entry) => this.get(entry.name)));
    return projects
      .filter((project) => project && project.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

module.exports = { AuthStore, ProjectStore };
