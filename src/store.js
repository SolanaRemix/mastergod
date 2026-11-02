const fs = require("node:fs/promises");
const { chmodSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const stores = new Map();

function parseJsonFile(file) {
  return fs.readFile(file, "utf8")
    .then((contents) => JSON.parse(contents))
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
}

class PersistenceStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.databasePath = path.join(this.root, "gods.sqlite");
    this.database = null;
    this.initialization = null;
  }

  initialize() {
    if (!this.initialization) this.initialization = this.open();
    return this.initialization;
  }

  async open() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    chmodSync(this.databasePath, 0o600);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 32),
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_owner_created_at ON projects(owner_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    await this.importLegacyFiles();
    return this;
  }

  async importLegacyFiles() {
    const alreadyMigrated = this.database.prepare("SELECT 1 FROM migrations WHERE version = 1").get();
    if (alreadyMigrated) return;

    const legacyAuth = await parseJsonFile(path.join(this.root, "auth.json"));
    const projectsDirectory = path.join(this.root, "projects");
    let legacyProjects = [];
    try {
      const entries = await fs.readdir(projectsDirectory, { withFileTypes: true });
      legacyProjects = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name))
        .map(async (entry) => parseJsonFile(path.join(projectsDirectory, entry.name, "project.json"))));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    this.transaction(() => {
      const insertUser = this.database.prepare(`
        INSERT OR IGNORE INTO users (id, email, role, salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const user of legacyAuth?.users || []) {
        if (
          typeof user.id !== "string"
          || typeof user.email !== "string"
          || typeof user.salt !== "string"
          || typeof user.passwordHash !== "string"
          || typeof user.createdAt !== "string"
        ) continue;
        insertUser.run(user.id, user.email, "user", user.salt, user.passwordHash, user.createdAt);
      }

      const insertSession = this.database.prepare(`
        INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const session of legacyAuth?.sessions || []) {
        if (
          typeof session.tokenHash !== "string"
          || typeof session.userId !== "string"
          || typeof session.expiresAt !== "string"
          || typeof session.createdAt !== "string"
          || !this.database.prepare("SELECT 1 FROM users WHERE id = ?").get(session.userId)
        ) continue;
        insertSession.run(session.tokenHash, session.userId, session.expiresAt, session.createdAt);
      }

      const insertProject = this.database.prepare(`
        INSERT OR IGNORE INTO projects (id, owner_id, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const project of legacyProjects.filter(Boolean)) {
        if (
          typeof project.id !== "string"
          || !/^[a-f0-9]{32}$/.test(project.id)
          || typeof project.ownerId !== "string"
          || typeof project.createdAt !== "string"
          || typeof project.updatedAt !== "string"
          || !this.database.prepare("SELECT 1 FROM users WHERE id = ?").get(project.ownerId)
        ) continue;
        insertProject.run(
          project.id,
          project.ownerId,
          JSON.stringify(project),
          project.createdAt,
          project.updatedAt
        );
      }
      this.database.prepare("INSERT INTO migrations (version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
    });
  }

  transaction(operation) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async createUser(user) {
    await this.initialize();
    try {
      this.database.prepare(`
        INSERT INTO users (id, email, role, salt, password_hash, created_at)
        VALUES (?, ?, 'user', ?, ?, ?)
      `).run(user.id, user.email, user.salt, user.passwordHash, user.createdAt);
      return user;
    } catch (error) {
      if (error.message.includes("UNIQUE constraint failed: users.email")) return null;
      throw error;
    }
  }

  async findUserByEmail(email) {
    await this.initialize();
    return this.database.prepare(`
      SELECT id, email, role, salt, password_hash AS passwordHash, created_at AS createdAt
      FROM users WHERE email = ? COLLATE NOCASE
    `).get(email) || null;
  }

  async findUserById(id) {
    await this.initialize();
    return this.database.prepare(`
      SELECT id, email, role, salt, password_hash AS passwordHash, created_at AS createdAt
      FROM users WHERE id = ?
    `).get(id) || null;
  }

  async createSession(session) {
    await this.initialize();
    this.transaction(() => {
      this.database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
      this.database.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(session.tokenHash, session.userId, session.expiresAt, session.createdAt);
    });
  }

  async findSession(tokenHash) {
    await this.initialize();
    return this.database.prepare(`
      SELECT token_hash AS tokenHash, user_id AS userId, expires_at AS expiresAt, created_at AS createdAt
      FROM sessions WHERE token_hash = ?
    `).get(tokenHash) || null;
  }

  async deleteSession(tokenHash) {
    await this.initialize();
    this.database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  async createProject(project) {
    await this.initialize();
    this.database.prepare(`
      INSERT INTO projects (id, owner_id, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      project.id,
      project.ownerId,
      JSON.stringify(project),
      project.createdAt,
      project.updatedAt
    );
    return project;
  }

  async getProject(id) {
    await this.initialize();
    const row = this.database.prepare("SELECT payload FROM projects WHERE id = ?").get(id);
    return row ? JSON.parse(row.payload) : null;
  }

  async listProjects(ownerId) {
    await this.initialize();
    return this.database.prepare(`
      SELECT payload FROM projects WHERE owner_id = ? ORDER BY created_at DESC
    `).all(ownerId).map((row) => JSON.parse(row.payload));
  }

  async updateProject(project) {
    await this.initialize();
    const result = this.database.prepare(`
      UPDATE projects
      SET payload = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `).run(JSON.stringify(project), project.updatedAt, project.id, project.ownerId);
    if (Number(result.changes) !== 1) throw new Error("Project not found or ownership changed.");
    return project;
  }

  async ping() {
    await this.initialize();
    return this.database.prepare("SELECT 1 AS ready").get().ready === 1;
  }

  async close() {
    if (this.database) this.database.close();
    this.database = null;
    this.initialization = null;
  }
}

function getPersistence(root) {
  const resolvedRoot = path.resolve(root);
  if (!stores.has(resolvedRoot)) stores.set(resolvedRoot, new PersistenceStore(resolvedRoot));
  return stores.get(resolvedRoot);
}

class AuthStore {
  constructor(root) {
    this.persistence = getPersistence(root);
  }

  initialize() { return this.persistence.initialize(); }
  createUser(user) { return this.persistence.createUser(user); }
  findUserByEmail(email) { return this.persistence.findUserByEmail(email); }
  findUserById(id) { return this.persistence.findUserById(id); }
  createSession(session) { return this.persistence.createSession(session); }
  findSession(tokenHash) { return this.persistence.findSession(tokenHash); }
  deleteSession(tokenHash) { return this.persistence.deleteSession(tokenHash); }
}

class ProjectStore {
  constructor(root) {
    this.persistence = getPersistence(root);
  }

  initialize() { return this.persistence.initialize(); }
  ping() { return this.persistence.ping(); }
  close() { return this.persistence.close(); }
  create(project) { return this.persistence.createProject(project); }
  get(id) { return this.persistence.getProject(id); }
  list(ownerId) { return this.persistence.listProjects(ownerId); }
  update(project) { return this.persistence.updateProject(project); }
}

module.exports = { AuthStore, PersistenceStore, ProjectStore };
