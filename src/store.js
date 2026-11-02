const fs = require("node:fs/promises");
const { chmodSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const { isProtectedArtifactPath, validateArtifactPath } = require("./artifacts");

const stores = new Map();
const EXECUTION_STATUSES = new Set([
  "planning",
  "awaiting_approval",
  "executing",
  "integrating",
  "testing",
  "completed",
  "failed",
  "blocked"
]);

function assertAgenticExecution(execution, projectId, generationId, tasks) {
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (!isObject(execution)
    || execution.requestId !== generationId
    || execution.projectId !== projectId
    || typeof execution.originalPrompt !== "string"
    || !execution.originalPrompt.trim()
    || execution.originalPrompt.length > 10_000
    || typeof execution.blueprintVersion !== "string"
    || !EXECUTION_STATUSES.has(execution.status)) {
    throw new Error("Execution snapshot is invalid or does not match its task graph.");
  }
  for (const field of ["requirements", "selectedAgents", "createdAgents", "modelAssignments", "taskGraph", "artifacts", "approvals", "testResults", "capabilityGaps"]) {
    if (!Array.isArray(execution[field])) throw new Error(`Execution snapshot field ${field} must be an array.`);
  }
  if (execution.requirements.length < 1 || execution.requirements.length > 200
    || execution.requirements.some((requirement) => !isObject(requirement)
      || typeof requirement.id !== "string" || typeof requirement.text !== "string" || !requirement.text.trim())) {
    throw new Error("Execution snapshot requirements are invalid.");
  }
  if (execution.selectedAgents.some((agent) => !isObject(agent)
    || typeof agent.agentId !== "string" || typeof agent.capability !== "string")) {
    throw new Error("Execution snapshot agent assignments are invalid.");
  }
  const graphIds = new Set(execution.taskGraph.map((task) => task?.taskId));
  if (execution.taskGraph.length !== tasks.length
    || graphIds.size !== tasks.length
    || tasks.some((task) => !graphIds.has(task.taskId))
    || execution.taskGraph.some((task) => !isObject(task)
      || typeof task.agentId !== "string"
      || !Array.isArray(task.requirementIds)
      || !Array.isArray(task.dependencies))) {
    throw new Error("Execution snapshot task graph does not match the persisted task records.");
  }
  if (execution.capabilityGaps.some((gap) => !isObject(gap)
    || typeof gap.capability !== "string"
    || typeof gap.status !== "string"
    || typeof gap.reason !== "string")) {
    throw new Error("Execution snapshot capability gaps are invalid.");
  }
}

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
    chmodSync(this.root, 0o700);
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
      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS password_resets_expires_at ON password_resets(expires_at);
      CREATE TABLE IF NOT EXISTS game_projects (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 32),
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        original_prompt TEXT NOT NULL,
        specification TEXT NOT NULL CHECK (json_valid(specification)),
        status TEXT NOT NULL,
        latest_version INTEGER NOT NULL CHECK (latest_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS game_projects_owner_updated_at
        ON game_projects(owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS game_versions (
        game_id TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        specification TEXT NOT NULL CHECK (json_valid(specification)),
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        change_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (game_id, version)
      );
      CREATE TABLE IF NOT EXISTS game_saves (
        game_id TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (json_valid(state)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (game_id, owner_id)
      );
      CREATE TABLE IF NOT EXISTS project_artifacts (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        contents TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        checksum TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL,
        responsible_agent TEXT NOT NULL,
        task_id TEXT NOT NULL,
        requirement_ids TEXT NOT NULL CHECK (json_valid(requirement_ids)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      CREATE INDEX IF NOT EXISTS project_artifacts_owner
        ON project_artifacts(owner_id, project_id, path);
      CREATE TABLE IF NOT EXISTS project_artifact_versions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        contents TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        checksum TEXT NOT NULL,
        status TEXT NOT NULL,
        change_summary TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, path, version)
      );
      CREATE TABLE IF NOT EXISTS project_artifact_directories (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      CREATE TABLE IF NOT EXISTS project_artifact_audit (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        path TEXT NOT NULL,
        details TEXT NOT NULL CHECK (json_valid(details)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_artifact_audit_project
        ON project_artifact_audit(project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS agent_tasks (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        project_type TEXT NOT NULL,
        title TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        dependencies TEXT NOT NULL CHECK (json_valid(dependencies)),
        input TEXT NOT NULL CHECK (json_valid(input)),
        timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds > 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        status TEXT NOT NULL CHECK (status IN ('BLOCKED', 'QUEUED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED')),
        blocked_reason TEXT,
        error TEXT CHECK (error IS NULL OR json_valid(error)),
        result TEXT CHECK (result IS NULL OR json_valid(result)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS agent_tasks_owner_project
        ON agent_tasks(owner_id, project_id, created_at);
      CREATE INDEX IF NOT EXISTS agent_tasks_project_status
        ON agent_tasks(project_id, status);
      CREATE TABLE IF NOT EXISTS agent_task_events (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL CHECK (to_state IN ('BLOCKED', 'QUEUED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED')),
        attempt INTEGER NOT NULL CHECK (attempt >= 0),
        details TEXT NOT NULL CHECK (json_valid(details)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id, task_id) REFERENCES agent_tasks(project_id, task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS agent_task_events_project_task
        ON agent_task_events(owner_id, project_id, task_id, created_at);
      CREATE TABLE IF NOT EXISTS agentic_executions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        generation_id TEXT NOT NULL,
        execution TEXT NOT NULL CHECK (json_valid(execution)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, generation_id)
      );
      CREATE INDEX IF NOT EXISTS agentic_executions_owner_project
        ON agentic_executions(owner_id, project_id, updated_at DESC);
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
      if (this.database.prepare("SELECT 1 FROM migrations WHERE version = 1").get()) return;

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

  async createSessionIfPasswordMatches(user, session) {
    await this.initialize();
    return this.transaction(() => {
      const current = this.database.prepare(`
        SELECT salt, password_hash AS passwordHash FROM users WHERE id = ?
      `).get(user.id);
      if (!current || current.salt !== user.salt || current.passwordHash !== user.passwordHash) return false;

      this.database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
      this.database.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(session.tokenHash, session.userId, session.expiresAt, session.createdAt);
      return true;
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

  async createPasswordReset(reset) {
    await this.initialize();
    this.transaction(() => {
      this.database.prepare("DELETE FROM password_resets WHERE expires_at <= ?").run(new Date().toISOString());
      this.database.prepare("DELETE FROM password_resets WHERE user_id = ?").run(reset.userId);
      this.database.prepare(`
        INSERT INTO password_resets (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(reset.tokenHash, reset.userId, reset.expiresAt, reset.createdAt);
    });
  }

  async consumePasswordReset(tokenHash, credentials) {
    await this.initialize();
    return this.transaction(() => {
      const reset = this.database.prepare(`
        SELECT user_id AS userId, expires_at AS expiresAt
        FROM password_resets WHERE token_hash = ?
      `).get(tokenHash);
      if (!reset || Date.parse(reset.expiresAt) <= Date.now()) {
        this.database.prepare("DELETE FROM password_resets WHERE token_hash = ?").run(tokenHash);
        return false;
      }

      const result = this.database.prepare(`
        UPDATE users SET salt = ?, password_hash = ? WHERE id = ?
      `).run(credentials.salt, credentials.passwordHash, reset.userId);
      if (Number(result.changes) !== 1) return false;
      this.database.prepare("DELETE FROM password_resets WHERE user_id = ?").run(reset.userId);
      this.database.prepare("DELETE FROM sessions WHERE user_id = ?").run(reset.userId);
      return true;
    });
  }

  async promoteAdmin(user) {
    await this.initialize();
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE users SET role = 'admin'
        WHERE id = ? AND email = ? COLLATE NOCASE
          AND salt = ? AND password_hash = ?
      `).run(user.id, user.email, user.salt, user.passwordHash);
      return Number(result.changes) === 1;
    });
  }

  async getAdminSummary() {
    await this.initialize();
    return {
      users: this.database.prepare("SELECT COUNT(*) AS count FROM users").get().count,
      projects: this.database.prepare("SELECT COUNT(*) AS count FROM projects").get().count,
      activeSessions: this.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?")
        .get(new Date().toISOString()).count,
      passwordResetTokens: this.database.prepare("SELECT COUNT(*) AS count FROM password_resets WHERE expires_at > ?")
        .get(new Date().toISOString()).count
    };
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

  recordArtifactAudit(projectId, ownerId, action, artifactPath, details, createdAt = new Date().toISOString()) {
    this.database.prepare(`
      INSERT INTO project_artifact_audit (id, project_id, owner_id, action, path, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), projectId, ownerId, action, artifactPath, JSON.stringify(details), createdAt);
  }

  insertArtifactVersion(projectId, artifactPath, version, artifact, ownerId, changeSummary, createdAt) {
    this.database.prepare(`
      INSERT INTO project_artifact_versions (
        project_id, path, version, contents, size_bytes, checksum, status, change_summary, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      artifactPath,
      version,
      artifact.contents,
      artifact.sizeBytes,
      artifact.checksum,
      artifact.status,
      changeSummary,
      ownerId,
      createdAt
    );
  }

  insertArtifactDirectories(projectId, ownerId, artifactPath, createdAt) {
    const segments = artifactPath.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      const directory = segments.slice(0, index).join("/");
      this.database.prepare(`
        INSERT OR IGNORE INTO project_artifact_directories (project_id, owner_id, path, created_at)
        VALUES (?, ?, ?, ?)
      `).run(projectId, ownerId, directory, createdAt);
    }
  }

  assertArtifactPathAvailable(projectId, artifactPath, ignoredFilePath = null) {
    const segments = artifactPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      const parentFile = this.database.prepare(`
        SELECT path FROM project_artifacts WHERE project_id = ? AND path = ?
      `).get(projectId, parent);
      if (parentFile && parentFile.path !== ignoredFilePath) {
        const error = new Error("A file already occupies a parent folder path.");
        error.code = "PATH_CONFLICT";
        throw error;
      }
    }
    const exactFile = this.database.prepare(`
      SELECT path FROM project_artifacts WHERE project_id = ? AND path = ?
    `).get(projectId, artifactPath);
    if ((exactFile && exactFile.path !== ignoredFilePath)
      || this.database.prepare(`
        SELECT 1 FROM project_artifact_directories WHERE project_id = ? AND path = ?
      `).get(projectId, artifactPath)) {
      const error = new Error("A file or folder already exists at that path.");
      error.code = "PATH_CONFLICT";
      throw error;
    }
    const nestedEntry = this.database.prepare(`
      SELECT path FROM project_artifacts WHERE project_id = ?
        AND substr(path, 1, length(?) + 1) = ? || '/'
      UNION ALL
      SELECT path FROM project_artifact_directories WHERE project_id = ?
        AND substr(path, 1, length(?) + 1) = ? || '/'
      LIMIT 1
    `).get(projectId, artifactPath, artifactPath, projectId, artifactPath, artifactPath);
    if (nestedEntry) {
      const error = new Error("A file cannot occupy a path that already contains a folder.");
      error.code = "PATH_CONFLICT";
      throw error;
    }
  }

  async createProjectArtifacts(projectId, ownerId, artifacts) {
    await this.initialize();
    return this.transaction(() => {
      const project = this.database.prepare(`
        SELECT payload FROM projects WHERE id = ? AND owner_id = ?
      `).get(projectId, ownerId);
      if (!project) return null;
      const metadata = JSON.parse(project.payload);
      if (metadata.status !== "APPROVED_PLAN") {
        const error = new Error("Approve project requirements before creating request-specific files.");
        error.code = "PROJECT_NOT_APPROVED";
        throw error;
      }
      if (this.database.prepare(`
        SELECT 1 FROM project_artifacts WHERE project_id = ? AND owner_id = ? LIMIT 1
      `).get(projectId, ownerId)) {
        const error = new Error("This project already has generated files. Use file operations to continue editing.");
        error.code = "ARTIFACTS_EXIST";
        throw error;
      }
      const insert = this.database.prepare(`
        INSERT INTO project_artifacts (
          project_id, owner_id, path, language, contents, size_bytes, checksum, version,
          status, responsible_agent, task_id, requirement_ids, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of artifacts) {
        const artifactPath = validateArtifactPath(artifact.path);
        const createdAt = artifact.generatedAt || new Date().toISOString();
        insert.run(
          projectId,
          ownerId,
          artifactPath,
          artifact.language,
          artifact.contents,
          artifact.sizeBytes,
          artifact.checksum,
          artifact.status,
          artifact.responsibleAgent,
          artifact.taskId,
          JSON.stringify(artifact.requirementIds),
          createdAt,
          createdAt
        );
        this.insertArtifactVersion(projectId, artifactPath, 1, artifact, ownerId, "Generated from approved project requirements.", createdAt);
        this.insertArtifactDirectories(projectId, ownerId, artifactPath, createdAt);
      }
      this.recordArtifactAudit(projectId, ownerId, "generated", "", {
        fileCount: artifacts.length,
        taskId: artifacts[0]?.taskId || null,
        method: "local deterministic request-specific scaffold"
      });
      const readBack = this.listProjectArtifactsSync(projectId, ownerId);
      if (readBack.length !== artifacts.length
        || artifacts.some((artifact) => !readBack.some((saved) =>
          saved.path === artifact.path && saved.checksum === artifact.checksum && saved.version === 1
        ))) {
        throw new Error("Generated artifacts did not pass database read-back verification.");
      }
      return readBack;
    });
  }

  listProjectArtifactsSync(projectId, ownerId) {
    return this.database.prepare(`
      SELECT path, language, size_bytes AS sizeBytes, checksum, version, status,
        responsible_agent AS responsibleAgent, task_id AS taskId,
        requirement_ids AS requirementIds, created_at AS createdAt, updated_at AS updatedAt
      FROM project_artifacts WHERE project_id = ? AND owner_id = ? ORDER BY path
    `).all(projectId, ownerId).map((artifact) => ({
      ...artifact,
      requirementIds: JSON.parse(artifact.requirementIds)
    }));
  }

  async listProjectArtifacts(projectId, ownerId) {
    await this.initialize();
    const project = this.database.prepare(`
      SELECT 1 FROM projects WHERE id = ? AND owner_id = ?
    `).get(projectId, ownerId);
    if (!project) return null;
    return {
      files: this.listProjectArtifactsSync(projectId, ownerId),
      directories: this.database.prepare(`
        SELECT path FROM project_artifact_directories
        WHERE project_id = ? AND owner_id = ? ORDER BY path
      `).all(projectId, ownerId).map(({ path: directoryPath }) => directoryPath)
    };
  }

  async createProjectDirectory(projectId, ownerId, directoryPath) {
    await this.initialize();
    directoryPath = validateArtifactPath(directoryPath);
    const now = new Date().toISOString();
    return this.transaction(() => {
      if (!this.database.prepare(`
        SELECT 1 FROM projects WHERE id = ? AND owner_id = ?
      `).get(projectId, ownerId)) return null;
      const segments = directoryPath.split("/");
      for (let index = 1; index <= segments.length; index += 1) {
        const directory = segments.slice(0, index).join("/");
        if (this.database.prepare(`
          SELECT 1 FROM project_artifacts WHERE project_id = ? AND path = ?
        `).get(projectId, directory)) {
          const error = new Error("A file already occupies this folder path.");
          error.code = "PATH_CONFLICT";
          throw error;
        }
        if (this.database.prepare(`
          SELECT 1 FROM project_artifact_directories WHERE project_id = ? AND path = ?
        `).get(projectId, directory)) continue;
        this.database.prepare(`
          INSERT INTO project_artifact_directories (project_id, owner_id, path, created_at)
          VALUES (?, ?, ?, ?)
        `).run(projectId, ownerId, directory, now);
      }
      this.recordArtifactAudit(projectId, ownerId, "directory-created", directoryPath, {}, now);
      if (!this.database.prepare(`
        SELECT 1 FROM project_artifact_directories WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, directoryPath)) {
        throw new Error("Created folder did not pass database read-back verification.");
      }
      return directoryPath;
    });
  }

  async renameProjectDirectory(projectId, ownerId, fromPath, toPath) {
    await this.initialize();
    fromPath = validateArtifactPath(fromPath);
    toPath = validateArtifactPath(toPath);
    if (toPath === fromPath || toPath.startsWith(`${fromPath}/`)) {
      throw new Error("A folder cannot be moved into itself.");
    }
    const now = new Date().toISOString();
    return this.transaction(() => {
      if (!this.database.prepare(`
        SELECT 1 FROM project_artifact_directories
        WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, fromPath)) return false;
      const dirs = this.database.prepare(`
        SELECT path FROM project_artifact_directories
        WHERE project_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
      `).all(projectId, fromPath, fromPath, fromPath).map(({ path: directory }) => directory);
      const files = this.database.prepare(`
        SELECT path FROM project_artifacts
        WHERE project_id = ? AND (substr(path, 1, length(?) + 1) = ? || '/')
      `).all(projectId, fromPath, fromPath).map(({ path: file }) => file);
      if (files.some(isProtectedArtifactPath)) {
        const error = new Error("This folder contains a required project file and cannot be renamed.");
        error.code = "PROTECTED_ARTIFACT";
        throw error;
      }
      const destinationFor = (oldPath) => `${toPath}${oldPath.slice(fromPath.length)}`;
      const movedDirectories = new Set(dirs);
      const movedFiles = new Set(files);
      const targetParents = toPath.split("/").slice(0, -1);
      for (let index = 1; index <= targetParents.length; index += 1) {
        const parent = targetParents.slice(0, index).join("/");
        const parentFile = this.database.prepare(`
          SELECT path FROM project_artifacts WHERE project_id = ? AND path = ?
        `).get(projectId, parent);
        if (parentFile && !movedFiles.has(parentFile.path)) {
          const error = new Error("A file already occupies a parent folder path.");
          error.code = "PATH_CONFLICT";
          throw error;
        }
      }
      for (const target of dirs.map(destinationFor)) {
        if (this.database.prepare(`
          SELECT 1 FROM project_artifact_directories WHERE project_id = ? AND path = ?
        `).get(projectId, target) && !movedDirectories.has(target)) {
          const error = new Error("A folder already exists at the destination.");
          error.code = "PATH_CONFLICT";
          throw error;
        }
        if (this.database.prepare(`
          SELECT 1 FROM project_artifacts WHERE project_id = ? AND path = ?
        `).get(projectId, target) && !movedFiles.has(target)) {
          const error = new Error("A file already exists at the destination.");
          error.code = "PATH_CONFLICT";
          throw error;
        }
      }
      for (const target of files.map(destinationFor)) {
        if (this.database.prepare(`
          SELECT 1 FROM project_artifacts WHERE project_id = ? AND path = ?
        `).get(projectId, target) && !movedFiles.has(target)) {
          const error = new Error("A file already exists at the destination.");
          error.code = "PATH_CONFLICT";
          throw error;
        }
      }
      const changes = [
        ...dirs.map((oldPath) => ({ table: "project_artifact_directories", oldPath, newPath: destinationFor(oldPath) })),
        ...files.map((oldPath) => ({ table: "project_artifacts", oldPath, newPath: destinationFor(oldPath) }))
      ];
      const versions = files.flatMap((oldPath) => {
        const history = this.database.prepare(`
          SELECT version FROM project_artifact_versions WHERE project_id = ? AND path = ?
        `).all(projectId, oldPath);
        return history.map((entry) => ({
          table: "project_artifact_versions",
          oldPath,
          version: entry.version,
          newPath: destinationFor(oldPath)
        }));
      });
      for (const [index, change] of changes.entries()) {
        const temporary = `.__move_${randomUUID().replaceAll("-", "")}_${index}`;
        this.database.prepare(`UPDATE ${change.table} SET path = ? WHERE project_id = ? AND path = ?`)
          .run(temporary, projectId, change.oldPath);
        change.temporary = temporary;
      }
      for (const [index, change] of versions.entries()) {
        const temporary = `.__move_${randomUUID().replaceAll("-", "")}_${index}`;
        this.database.prepare(`
          UPDATE project_artifact_versions SET path = ?
          WHERE project_id = ? AND path = ? AND version = ?
        `).run(temporary, projectId, change.oldPath, change.version);
        change.temporary = temporary;
      }
      for (const change of changes) {
        this.database.prepare(`UPDATE ${change.table} SET path = ? WHERE project_id = ? AND path = ?`)
          .run(change.newPath, projectId, change.temporary);
      }
      for (const change of versions) {
        this.database.prepare(`
          UPDATE project_artifact_versions SET path = ?
          WHERE project_id = ? AND path = ? AND version = ?
        `).run(change.newPath, projectId, change.temporary, change.version);
      }
      const parentSegments = toPath.split("/").slice(0, -1);
      for (let index = 1; index <= parentSegments.length; index += 1) {
        const directory = parentSegments.slice(0, index).join("/");
        this.database.prepare(`
          INSERT OR IGNORE INTO project_artifact_directories (project_id, owner_id, path, created_at)
          VALUES (?, ?, ?, ?)
        `).run(projectId, ownerId, directory, now);
      }
      this.recordArtifactAudit(projectId, ownerId, "directory-renamed", toPath, {
        fromPath,
        toPath,
        movedFiles: files.length
      }, now);
      if (!this.database.prepare(`
        SELECT 1 FROM project_artifact_directories WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, toPath)
        || this.database.prepare(`
          SELECT COUNT(*) AS count FROM project_artifacts
          WHERE project_id = ? AND substr(path, 1, length(?) + 1) = ? || '/'
        `).get(projectId, toPath, toPath).count !== files.length) {
        throw new Error("Renamed folder contents did not pass database read-back verification.");
      }
      return true;
    });
  }

  async deleteProjectDirectory(projectId, ownerId, directoryPath) {
    await this.initialize();
    directoryPath = validateArtifactPath(directoryPath);
    return this.transaction(() => {
      if (!this.database.prepare(`
        SELECT 1 FROM project_artifact_directories
        WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, directoryPath)) return false;
      const files = this.database.prepare(`
        SELECT path, version, checksum FROM project_artifacts
        WHERE project_id = ? AND (substr(path, 1, length(?) + 1) = ? || '/')
      `).all(projectId, directoryPath, directoryPath);
      if (files.some((file) => isProtectedArtifactPath(file.path))) {
        const error = new Error("This folder contains a required project file and cannot be deleted.");
        error.code = "PROTECTED_ARTIFACT";
        throw error;
      }
      this.recordArtifactAudit(projectId, ownerId, "directory-deleted", directoryPath, {
        removedFiles: files.length
      });
      for (const file of files) {
        this.database.prepare(`
          DELETE FROM project_artifact_versions WHERE project_id = ? AND path = ?
        `).run(projectId, file.path);
        this.database.prepare(`
          DELETE FROM project_artifacts WHERE project_id = ? AND owner_id = ? AND path = ?
        `).run(projectId, ownerId, file.path);
        this.recordArtifactAudit(projectId, ownerId, "deleted", file.path, {
          version: file.version,
          checksum: file.checksum,
          removedBy: directoryPath
        });
      }
      this.database.prepare(`
        DELETE FROM project_artifact_directories
        WHERE project_id = ? AND owner_id = ?
          AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
      `).run(projectId, ownerId, directoryPath, directoryPath, directoryPath);
      if (this.database.prepare(`
        SELECT 1 FROM project_artifact_directories
        WHERE project_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
      `).get(projectId, directoryPath, directoryPath, directoryPath)
        || this.database.prepare(`
          SELECT 1 FROM project_artifacts
          WHERE project_id = ? AND substr(path, 1, length(?) + 1) = ? || '/'
        `).get(projectId, directoryPath, directoryPath)
        || this.database.prepare(`
          SELECT 1 FROM project_artifact_versions
          WHERE project_id = ? AND substr(path, 1, length(?) + 1) = ? || '/'
        `).get(projectId, directoryPath, directoryPath)) {
        throw new Error("Deleted folder contents did not pass database read-back verification.");
      }
      return true;
    });
  }

  async readProjectArtifact(projectId, ownerId, artifactPath) {
    await this.initialize();
    artifactPath = validateArtifactPath(artifactPath);
    const artifact = this.database.prepare(`
      SELECT path, language, contents, size_bytes AS sizeBytes, checksum, version, status,
        responsible_agent AS responsibleAgent, task_id AS taskId,
        requirement_ids AS requirementIds, created_at AS createdAt, updated_at AS updatedAt
      FROM project_artifacts WHERE project_id = ? AND owner_id = ? AND path = ?
    `).get(projectId, ownerId, artifactPath);
    if (!artifact) return null;
    return { ...artifact, requirementIds: JSON.parse(artifact.requirementIds) };
  }

  async writeProjectArtifact(projectId, ownerId, artifactPath, contents, expectedVersion, changeSummary = "Edited file contents.") {
    await this.initialize();
    artifactPath = validateArtifactPath(artifactPath);
    if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > 256 * 1024) {
      throw new Error("File contents must be text no larger than 256 KiB.");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("Provide the file version you are editing.");
    }
    const { sha256 } = require("./artifacts");
    const now = new Date().toISOString();
    return this.transaction(() => {
      const current = this.database.prepare(`
        SELECT * FROM project_artifacts WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, artifactPath);
      if (!current) return null;
      if (current.version !== expectedVersion) {
        const error = new Error("This file changed since you opened it. Reload before saving.");
        error.code = "VERSION_CONFLICT";
        throw error;
      }
      const next = {
        contents,
        sizeBytes: Buffer.byteLength(contents, "utf8"),
        checksum: sha256(contents),
        status: "IMPLEMENTED_UNVERIFIED"
      };
      const nextVersion = current.version + 1;
      this.database.prepare(`
        UPDATE project_artifacts SET contents = ?, size_bytes = ?, checksum = ?, version = ?,
          status = ?, updated_at = ?
        WHERE project_id = ? AND owner_id = ? AND path = ? AND version = ?
      `).run(next.contents, next.sizeBytes, next.checksum, nextVersion, next.status, now,
        projectId, ownerId, artifactPath, expectedVersion);
      this.insertArtifactVersion(projectId, artifactPath, nextVersion, next, ownerId, changeSummary, now);
      this.recordArtifactAudit(projectId, ownerId, "updated", artifactPath, {
        version: nextVersion,
        checksum: next.checksum
      }, now);
      const readBack = this.database.prepare(`
        SELECT contents, checksum, version FROM project_artifacts
        WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, artifactPath);
      if (readBack.contents !== contents || readBack.checksum !== next.checksum || readBack.version !== nextVersion) {
        throw new Error("Saved artifact did not pass database read-back verification.");
      }
      return this.readProjectArtifactSync(projectId, ownerId, artifactPath);
    });
  }

  async createProjectArtifact(projectId, ownerId, artifactPath, contents, language) {
    await this.initialize();
    artifactPath = validateArtifactPath(artifactPath);
    if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > 256 * 1024) {
      throw new Error("File contents must be text no larger than 256 KiB.");
    }
    if (typeof language !== "string" || !/^[a-z0-9+#.-]{1,24}$/i.test(language)) {
      throw new Error("Choose a supported file language label.");
    }
    const { sha256 } = require("./artifacts");
    const now = new Date().toISOString();
    return this.transaction(() => {
      const project = this.database.prepare(`
        SELECT payload FROM projects WHERE id = ? AND owner_id = ?
      `).get(projectId, ownerId);
      if (!project) return null;
      this.assertArtifactPathAvailable(projectId, artifactPath);
      const segments = artifactPath.split("/");
      const directories = segments.slice(0, -1);
      for (let index = 1; index <= directories.length; index += 1) {
        const directory = directories.slice(0, index).join("/");
        if (this.database.prepare(`
          SELECT 1 FROM project_artifact_directories WHERE project_id = ? AND path = ?
        `).get(projectId, directory)) continue;
        this.database.prepare(`
          INSERT INTO project_artifact_directories (project_id, owner_id, path, created_at)
          VALUES (?, ?, ?, ?)
        `).run(projectId, ownerId, directory, now);
      }
      const projectData = JSON.parse(project.payload);
      const requirementIds = projectData.requirements
        .filter((requirement) => requirement.decision === "APPROVED")
        .map((requirement) => requirement.id);
      const taskId = `USER-EDIT-${randomUUID()}`;
      const artifact = {
        contents,
        sizeBytes: Buffer.byteLength(contents, "utf8"),
        checksum: sha256(contents),
        status: "IMPLEMENTED_UNVERIFIED"
      };
      this.database.prepare(`
        INSERT INTO project_artifacts (
          project_id, owner_id, path, language, contents, size_bytes, checksum, version,
          status, responsible_agent, task_id, requirement_ids, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'project-owner', ?, ?, ?, ?)
      `).run(projectId, ownerId, artifactPath, language, artifact.contents, artifact.sizeBytes,
        artifact.checksum, artifact.status, taskId, JSON.stringify(requirementIds), now, now);
      this.insertArtifactVersion(projectId, artifactPath, 1, artifact, ownerId, "Created by the project owner.", now);
      this.insertArtifactDirectories(projectId, ownerId, artifactPath, now);
      this.recordArtifactAudit(projectId, ownerId, "created", artifactPath, {
        version: 1,
        checksum: artifact.checksum
      }, now);
      const readBack = this.database.prepare(`
        SELECT contents, checksum, version FROM project_artifacts
        WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, artifactPath);
      if (readBack.contents !== contents || readBack.checksum !== artifact.checksum || readBack.version !== 1) {
        throw new Error("Created artifact did not pass database read-back verification.");
      }
      return this.readProjectArtifactSync(projectId, ownerId, artifactPath);
    });
  }

  readProjectArtifactSync(projectId, ownerId, artifactPath) {
    const artifact = this.database.prepare(`
      SELECT path, language, contents, size_bytes AS sizeBytes, checksum, version, status,
        responsible_agent AS responsibleAgent, task_id AS taskId,
        requirement_ids AS requirementIds, created_at AS createdAt, updated_at AS updatedAt
      FROM project_artifacts WHERE project_id = ? AND owner_id = ? AND path = ?
    `).get(projectId, ownerId, artifactPath);
    return artifact ? { ...artifact, requirementIds: JSON.parse(artifact.requirementIds) } : null;
  }

  async renameProjectArtifact(projectId, ownerId, fromPath, toPath, expectedVersion) {
    await this.initialize();
    fromPath = validateArtifactPath(fromPath);
    toPath = validateArtifactPath(toPath);
    if (fromPath === toPath || toPath.startsWith(`${fromPath}/`)) {
      throw new Error("Choose a different destination outside this file.");
    }
    const now = new Date().toISOString();
    return this.transaction(() => {
      const artifact = this.database.prepare(`
        SELECT * FROM project_artifacts WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, fromPath);
      if (!artifact) return null;
      if (isProtectedArtifactPath(fromPath)) {
        const error = new Error("This required project file cannot be renamed.");
        error.code = "PROTECTED_ARTIFACT";
        throw error;
      }
      if (artifact.version !== expectedVersion) {
        const error = new Error("This file changed since you opened it. Reload before renaming.");
        error.code = "VERSION_CONFLICT";
        throw error;
      }
      this.assertArtifactPathAvailable(projectId, toPath, fromPath);
      this.database.prepare(`
        UPDATE project_artifacts SET path = ?, updated_at = ?
        WHERE project_id = ? AND owner_id = ? AND path = ?
      `).run(toPath, now, projectId, ownerId, fromPath);
      this.database.prepare(`
        UPDATE project_artifact_versions SET path = ?
        WHERE project_id = ? AND path = ?
      `).run(toPath, projectId, fromPath);
      const folder = toPath.split("/").slice(0, -1);
      for (let index = 1; index <= folder.length; index += 1) {
        const directory = folder.slice(0, index).join("/");
        this.database.prepare(`
          INSERT OR IGNORE INTO project_artifact_directories (project_id, owner_id, path, created_at)
          VALUES (?, ?, ?, ?)
        `).run(projectId, ownerId, directory, now);
      }
      this.recordArtifactAudit(projectId, ownerId, "renamed", toPath, { fromPath, toPath }, now);
      const readBack = this.readProjectArtifactSync(projectId, ownerId, toPath);
      if (!readBack || readBack.contents !== artifact.contents || readBack.version !== artifact.version) {
        throw new Error("Renamed artifact did not pass database read-back verification.");
      }
      const historyReadBack = this.database.prepare(`
        SELECT COUNT(*) AS count FROM project_artifact_versions WHERE project_id = ? AND path = ?
      `).get(projectId, toPath);
      if (historyReadBack.count < artifact.version) throw new Error("Renamed artifact history did not pass read-back verification.");
      return readBack;
    });
  }

  async duplicateProjectArtifact(projectId, ownerId, sourcePath, targetPath) {
    await this.initialize();
    sourcePath = validateArtifactPath(sourcePath);
    targetPath = validateArtifactPath(targetPath);
    const now = new Date().toISOString();
    return this.transaction(() => {
      const source = this.database.prepare(`
        SELECT * FROM project_artifacts WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, sourcePath);
      if (!source) return null;
      this.assertArtifactPathAvailable(projectId, targetPath);
      this.database.prepare(`
        INSERT INTO project_artifacts (
          project_id, owner_id, path, language, contents, size_bytes, checksum, version,
          status, responsible_agent, task_id, requirement_ids, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(projectId, ownerId, targetPath, source.language, source.contents, source.size_bytes,
        source.checksum, "IMPLEMENTED_UNVERIFIED", source.responsible_agent, source.task_id,
        source.requirement_ids, now, now);
      const duplicate = {
        contents: source.contents,
        sizeBytes: source.size_bytes,
        checksum: source.checksum,
        status: "IMPLEMENTED_UNVERIFIED"
      };
      this.insertArtifactVersion(projectId, targetPath, 1, duplicate, ownerId,
        `Duplicated from ${sourcePath}.`, now);
      this.recordArtifactAudit(projectId, ownerId, "duplicated", targetPath, { sourcePath, targetPath }, now);
      const readBack = this.readProjectArtifactSync(projectId, ownerId, targetPath);
      if (!readBack || readBack.contents !== source.contents || readBack.checksum !== source.checksum) {
        throw new Error("Duplicated artifact did not pass database read-back verification.");
      }
      return readBack;
    });
  }

  async deleteProjectArtifact(projectId, ownerId, artifactPath, expectedVersion) {
    await this.initialize();
    artifactPath = validateArtifactPath(artifactPath);
    return this.transaction(() => {
      const current = this.database.prepare(`
        SELECT version, checksum FROM project_artifacts
        WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, artifactPath);
      if (!current) return false;
      if (isProtectedArtifactPath(artifactPath)) {
        const error = new Error("This required project file cannot be deleted.");
        error.code = "PROTECTED_ARTIFACT";
        throw error;
      }
      if (current.version !== expectedVersion) {
        const error = new Error("This file changed since you opened it. Reload before deleting.");
        error.code = "VERSION_CONFLICT";
        throw error;
      }
      this.recordArtifactAudit(projectId, ownerId, "deleted", artifactPath, {
        version: current.version,
        checksum: current.checksum
      });
      this.database.prepare(`
        DELETE FROM project_artifact_versions WHERE project_id = ? AND path = ?
      `).run(projectId, artifactPath);
      this.database.prepare(`
        DELETE FROM project_artifacts WHERE project_id = ? AND owner_id = ? AND path = ?
      `).run(projectId, ownerId, artifactPath);
      if (this.database.prepare(`
        SELECT 1 FROM project_artifacts WHERE project_id = ? AND path = ?
      `).get(projectId, artifactPath) || this.database.prepare(`
        SELECT 1 FROM project_artifact_versions WHERE project_id = ? AND path = ?
      `).get(projectId, artifactPath)) {
        throw new Error("Deleted artifact did not pass database read-back verification.");
      }
      return true;
    });
  }

  async getProjectArtifactHistory(projectId, ownerId, artifactPath) {
    await this.initialize();
    artifactPath = validateArtifactPath(artifactPath);
    const project = this.database.prepare(`
      SELECT 1 FROM projects WHERE id = ? AND owner_id = ?
    `).get(projectId, ownerId);
    if (!project) return null;
    return this.database.prepare(`
      SELECT version, contents, size_bytes AS sizeBytes, checksum, status,
        change_summary AS changeSummary, actor_id AS actorId, created_at AS createdAt
      FROM project_artifact_versions
      WHERE project_id = ? AND path = ? ORDER BY version DESC
    `).all(projectId, artifactPath);
  }

  async restoreProjectArtifact(projectId, ownerId, artifactPath, sourceVersion, expectedVersion) {
    await this.initialize();
    artifactPath = validateArtifactPath(artifactPath);
    const now = new Date().toISOString();
    return this.transaction(() => {
      const current = this.database.prepare(`
        SELECT version FROM project_artifacts WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, artifactPath);
      if (!current) return null;
      if (current.version !== expectedVersion) {
        const error = new Error("This file changed since you opened it. Reload before restoring.");
        error.code = "VERSION_CONFLICT";
        throw error;
      }

      const previous = this.database.prepare(`
        SELECT contents, size_bytes AS sizeBytes, checksum, status
        FROM project_artifact_versions
        WHERE project_id = ? AND path = ? AND version = ?
      `).get(projectId, artifactPath, sourceVersion);
      if (!previous) return null;
      const nextVersion = current.version + 1;
      this.database.prepare(`
        UPDATE project_artifacts SET contents = ?, size_bytes = ?, checksum = ?, version = ?,
          status = 'IMPLEMENTED_UNVERIFIED', updated_at = ?
        WHERE project_id = ? AND owner_id = ? AND path = ?
      `).run(previous.contents, previous.sizeBytes, previous.checksum, nextVersion, now,
        projectId, ownerId, artifactPath);
      this.insertArtifactVersion(projectId, artifactPath, nextVersion,
        { ...previous, status: "IMPLEMENTED_UNVERIFIED" }, ownerId,
        `Restored version ${sourceVersion}.`, now);
      this.recordArtifactAudit(projectId, ownerId, "restored", artifactPath, {
        sourceVersion,
        version: nextVersion,
        checksum: previous.checksum
      }, now);
      const readBack = this.database.prepare(`
        SELECT contents, checksum FROM project_artifacts
        WHERE project_id = ? AND owner_id = ? AND path = ?
      `).get(projectId, ownerId, artifactPath);
      if (readBack.contents !== previous.contents || readBack.checksum !== previous.checksum) {
        throw new Error("Restored artifact did not pass database read-back verification.");
      }
      return this.readProjectArtifactSync(projectId, ownerId, artifactPath);
    });
  }

  async listProjectArtifactAudit(projectId, ownerId) {
    await this.initialize();
    const project = this.database.prepare(`
      SELECT 1 FROM projects WHERE id = ? AND owner_id = ?
    `).get(projectId, ownerId);
    if (!project) return null;
    return this.database.prepare(`
      SELECT action, path, details, created_at AS createdAt
      FROM project_artifact_audit
      WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC
    `).all(projectId, ownerId).map((event) => ({ ...event, details: JSON.parse(event.details) }));
  }

  agentTaskFromRow(row) {
    if (!row) return null;
    return {
      taskId: row.taskId,
      projectId: row.projectId,
      ownerId: row.ownerId,
      generationId: row.generationId,
      projectType: row.projectType,
      title: row.title,
      agentId: row.agentId,
      dependencies: JSON.parse(row.dependencies),
      input: JSON.parse(row.input),
      timeoutSeconds: row.timeoutSeconds,
      maxAttempts: row.maxAttempts,
      attempt: row.attempt,
      status: row.status,
      blockedReason: row.blockedReason,
      error: row.error ? JSON.parse(row.error) : null,
      result: row.result ? JSON.parse(row.result) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  async createAgentTasks(projectId, ownerId, tasks, execution = null) {
    await this.initialize();
    return this.transaction(() => {
      if (!this.database.prepare(`
        SELECT 1 FROM projects WHERE id = ? AND owner_id = ?
      `).get(projectId, ownerId)) return null;
      if (!Array.isArray(tasks) || !tasks.length) {
        throw new Error("An execution graph must contain at least one task.");
      }
      const generationId = tasks[0].generationId;
      const existing = this.database.prepare(`
        SELECT DISTINCT generation_id FROM agent_tasks WHERE project_id = ? AND owner_id = ?
      `).all(projectId, ownerId);
      if (existing.some((entry) => entry.generation_id !== generationId)) {
        const error = new Error("This project already has a different execution graph.");
        error.code = "EXECUTION_GRAPH_EXISTS";
        throw error;
      }
      const insert = this.database.prepare(`
        INSERT OR IGNORE INTO agent_tasks (
          project_id, owner_id, task_id, generation_id, project_type, title, agent_id,
          dependencies, input, timeout_seconds, max_attempts, attempt, status,
          blocked_reason, error, result, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `);
      for (const task of tasks) {
        if (task.projectId !== projectId || task.ownerId !== ownerId || task.generationId !== generationId) {
          throw new Error("Execution graph contains inconsistent project ownership or generation identifiers.");
        }
        const inserted = insert.run(
          projectId,
          ownerId,
          task.taskId,
          task.generationId,
          task.projectType,
          task.title,
          task.agentId,
          JSON.stringify(task.dependencies),
          JSON.stringify(task.input),
          task.timeoutSeconds,
          task.maxAttempts,
          task.attempt,
          task.status,
          task.blockedReason,
          task.createdAt,
          task.updatedAt
        );
        if (Number(inserted.changes) === 1) {
          this.database.prepare(`
            INSERT INTO agent_task_events (id, project_id, owner_id, task_id, from_state, to_state, attempt, details, created_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            projectId,
            ownerId,
            task.taskId,
            task.status,
            task.attempt,
            JSON.stringify({ reason: "task-created", agentId: task.agentId, generationId }),
            task.createdAt
          );
        }
      }
      const readBack = this.database.prepare(`
        SELECT COUNT(*) AS count FROM agent_tasks WHERE project_id = ? AND owner_id = ? AND generation_id = ?
      `).get(projectId, ownerId, generationId);
      if (readBack.count !== tasks.length) {
        const error = new Error("Execution graph did not pass database read-back verification.");
        error.code = "EXECUTION_GRAPH_CONFLICT";
        throw error;
      }
      if (execution) {
        assertAgenticExecution(execution, projectId, generationId, tasks);
        const now = new Date().toISOString();
        this.database.prepare(`
          INSERT OR IGNORE INTO agentic_executions (project_id, owner_id, generation_id, execution, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(projectId, ownerId, generationId, JSON.stringify(execution), now, now);
        const snapshot = this.database.prepare(`
          SELECT execution FROM agentic_executions
          WHERE project_id = ? AND owner_id = ? AND generation_id = ?
        `).get(projectId, ownerId, generationId);
        if (!snapshot || JSON.parse(snapshot.execution).requestId !== generationId) {
          const error = new Error("Execution snapshot did not pass database read-back verification.");
          error.code = "EXECUTION_SNAPSHOT_CONFLICT";
          throw error;
        }
      }
      return this.listAgentTasksSync(projectId, ownerId);
    });
  }

  async getAgenticExecution(projectId, ownerId) {
    await this.initialize();
    if (!this.database.prepare(`
      SELECT 1 FROM projects WHERE id = ? AND owner_id = ?
    `).get(projectId, ownerId)) return null;
    const row = this.database.prepare(`
      SELECT execution FROM agentic_executions
      WHERE project_id = ? AND owner_id = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(projectId, ownerId);
    return row ? JSON.parse(row.execution) : null;
  }

  listAgentTasksSync(projectId, ownerId) {
    return this.database.prepare(`
      SELECT task_id AS taskId, project_id AS projectId, owner_id AS ownerId,
        generation_id AS generationId, project_type AS projectType, title,
        agent_id AS agentId, dependencies, input, timeout_seconds AS timeoutSeconds,
        max_attempts AS maxAttempts, attempt, status, blocked_reason AS blockedReason,
        error, result, created_at AS createdAt, updated_at AS updatedAt
      FROM agent_tasks
      WHERE project_id = ? AND owner_id = ?
      ORDER BY created_at, task_id
    `).all(projectId, ownerId).map((row) => this.agentTaskFromRow(row));
  }

  async listAgentTasks(projectId, ownerId) {
    await this.initialize();
    if (!this.database.prepare(`
      SELECT 1 FROM projects WHERE id = ? AND owner_id = ?
    `).get(projectId, ownerId)) return null;
    return this.listAgentTasksSync(projectId, ownerId);
  }

  async getAgentTask(projectId, ownerId, taskId) {
    await this.initialize();
    const row = this.database.prepare(`
      SELECT task_id AS taskId, project_id AS projectId, owner_id AS ownerId,
        generation_id AS generationId, project_type AS projectType, title,
        agent_id AS agentId, dependencies, input, timeout_seconds AS timeoutSeconds,
        max_attempts AS maxAttempts, attempt, status, blocked_reason AS blockedReason,
        error, result, created_at AS createdAt, updated_at AS updatedAt
      FROM agent_tasks WHERE project_id = ? AND owner_id = ? AND task_id = ?
    `).get(projectId, ownerId, taskId);
    return this.agentTaskFromRow(row);
  }

  async transitionAgentTask(projectId, ownerId, taskId, expectedState, nextState, update, details) {
    await this.initialize();
    return this.transaction(() => {
      const current = this.database.prepare(`
        SELECT status, attempt FROM agent_tasks
        WHERE project_id = ? AND owner_id = ? AND task_id = ?
      `).get(projectId, ownerId, taskId);
      if (!current || current.status !== expectedState) return null;
      const allowedFields = new Set(["attempt", "blockedReason", "error", "result", "updatedAt"]);
      if (Object.keys(update).some((field) => !allowedFields.has(field))) {
        throw new Error("Agent task transition contains an unsupported field.");
      }
      const attempt = update.attempt ?? current.attempt;
      const blockedReason = update.blockedReason ?? null;
      const error = update.error ? JSON.stringify(update.error) : null;
      const result = update.result ? JSON.stringify(update.result) : null;
      const updatedAt = update.updatedAt || new Date().toISOString();
      const changed = this.database.prepare(`
        UPDATE agent_tasks SET status = ?, attempt = ?, blocked_reason = ?, error = ?, result = ?, updated_at = ?
        WHERE project_id = ? AND owner_id = ? AND task_id = ? AND status = ?
      `).run(nextState, attempt, blockedReason, error, result, updatedAt,
        projectId, ownerId, taskId, expectedState);
      if (Number(changed.changes) !== 1) return null;
      this.database.prepare(`
        INSERT INTO agent_task_events (id, project_id, owner_id, task_id, from_state, to_state, attempt, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), projectId, ownerId, taskId, expectedState, nextState, attempt,
        JSON.stringify(details), updatedAt);
      const readBack = this.database.prepare(`
        SELECT status, attempt, blocked_reason AS blockedReason, error, result
        FROM agent_tasks WHERE project_id = ? AND owner_id = ? AND task_id = ?
      `).get(projectId, ownerId, taskId);
      if (readBack.status !== nextState || readBack.attempt !== attempt) {
        throw new Error("Agent task state did not pass database read-back verification.");
      }
      return this.agentTaskFromRow(this.database.prepare(`
        SELECT task_id AS taskId, project_id AS projectId, owner_id AS ownerId,
          generation_id AS generationId, project_type AS projectType, title,
          agent_id AS agentId, dependencies, input, timeout_seconds AS timeoutSeconds,
          max_attempts AS maxAttempts, attempt, status, blocked_reason AS blockedReason,
          error, result, created_at AS createdAt, updated_at AS updatedAt
        FROM agent_tasks WHERE project_id = ? AND owner_id = ? AND task_id = ?
      `).get(projectId, ownerId, taskId));
    });
  }

  async listAgentTaskEvents(projectId, ownerId, taskId) {
    await this.initialize();
    if (!this.database.prepare(`
      SELECT 1 FROM agent_tasks WHERE project_id = ? AND owner_id = ? AND task_id = ?
    `).get(projectId, ownerId, taskId)) return null;
    return this.database.prepare(`
      SELECT from_state AS fromState, to_state AS toState, attempt, details, created_at AS createdAt
      FROM agent_task_events
      WHERE project_id = ? AND owner_id = ? AND task_id = ?
      ORDER BY created_at, rowid
    `).all(projectId, ownerId, taskId).map((event) => ({
      ...event,
      details: JSON.parse(event.details)
    }));
  }

  async createGameProject(game) {
    await this.initialize();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO game_projects (
          id, owner_id, title, original_prompt, specification, status, latest_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        game.id,
        game.ownerId,
        game.title,
        game.originalPrompt,
        JSON.stringify(game.specification),
        game.status,
        game.latestVersion,
        game.createdAt,
        game.updatedAt
      );
      const version = game.versions[0];
      this.database.prepare(`
        INSERT INTO game_versions (
          game_id, version, specification, source, status, change_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        game.id,
        version.version,
        JSON.stringify(version.specification),
        version.source,
        version.status,
        version.changeSummary,
        version.createdAt
      );
    });
    return game;
  }

  async listGameProjects(ownerId) {
    await this.initialize();
    return this.database.prepare(`
      SELECT id, title, status, latest_version AS latestVersion, created_at AS createdAt, updated_at AS updatedAt
      FROM game_projects WHERE owner_id = ? ORDER BY updated_at DESC
    `).all(ownerId);
  }

  async getGameProject(id, ownerId) {
    await this.initialize();
    const row = this.database.prepare(`
      SELECT id, owner_id AS ownerId, title, original_prompt AS originalPrompt,
        specification, status, latest_version AS latestVersion,
        created_at AS createdAt, updated_at AS updatedAt
      FROM game_projects WHERE id = ? AND owner_id = ?
    `).get(id, ownerId);
    if (!row) return null;
    const versions = this.database.prepare(`
      SELECT version, status, change_summary AS changeSummary, created_at AS createdAt
      FROM game_versions WHERE game_id = ? ORDER BY version
    `).all(id);
    return {
      ...row,
      specification: JSON.parse(row.specification),
      versions
    };
  }

  async getGameVersion(id, ownerId, versionNumber) {
    await this.initialize();
    const row = this.database.prepare(`
      SELECT versions.version, versions.specification, versions.source, versions.status,
        versions.change_summary AS changeSummary, versions.created_at AS createdAt
      FROM game_versions AS versions
      JOIN game_projects AS games ON games.id = versions.game_id
      WHERE games.id = ? AND games.owner_id = ? AND versions.version = ?
    `).get(id, ownerId, versionNumber);
    if (!row) return null;
    return { ...row, specification: JSON.parse(row.specification) };
  }

  async appendGameVersion(id, ownerId, versionData) {
    await this.initialize();
    return this.transaction(() => {
      const game = this.database.prepare(`
        SELECT latest_version AS latestVersion
        FROM game_projects WHERE id = ? AND owner_id = ?
      `).get(id, ownerId);
      if (!game) return null;
      const version = game.latestVersion + 1;
      const createdAt = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO game_versions (
          game_id, version, specification, source, status, change_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        version,
        JSON.stringify(versionData.specification),
        versionData.source,
        versionData.status,
        versionData.changeSummary,
        createdAt
      );
      this.database.prepare(`
        UPDATE game_projects SET title = ?, specification = ?, status = ?,
          latest_version = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?
      `).run(
        versionData.specification.name,
        JSON.stringify(versionData.specification),
        versionData.status,
        version,
        createdAt,
        id,
        ownerId
      );
      return version;
    });
  }

  async getGameSave(id, ownerId) {
    await this.initialize();
    const row = this.database.prepare(`
      SELECT saves.state, saves.updated_at AS updatedAt
      FROM game_saves AS saves
      JOIN game_projects AS games ON games.id = saves.game_id
      WHERE games.id = ? AND games.owner_id = ? AND saves.owner_id = ?
    `).get(id, ownerId, ownerId);
    return row ? { state: JSON.parse(row.state), updatedAt: row.updatedAt } : null;
  }

  async saveGameState(id, ownerId, state) {
    await this.initialize();
    return this.transaction(() => {
      const game = this.database.prepare(`
        SELECT 1 FROM game_projects WHERE id = ? AND owner_id = ?
      `).get(id, ownerId);
      if (!game) return false;
      this.database.prepare(`
        INSERT INTO game_saves (game_id, owner_id, state, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(game_id, owner_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
      `).run(id, ownerId, JSON.stringify(state), new Date().toISOString());
      return true;
    });
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
  createSessionIfPasswordMatches(user, session) {
    return this.persistence.createSessionIfPasswordMatches(user, session);
  }
  findSession(tokenHash) { return this.persistence.findSession(tokenHash); }
  deleteSession(tokenHash) { return this.persistence.deleteSession(tokenHash); }
  createPasswordReset(reset) { return this.persistence.createPasswordReset(reset); }
  consumePasswordReset(tokenHash, credentials) { return this.persistence.consumePasswordReset(tokenHash, credentials); }
  promoteAdmin(user) { return this.persistence.promoteAdmin(user); }
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
  getAdminSummary() { return this.persistence.getAdminSummary(); }
  generateArtifacts(id, ownerId, artifacts) { return this.persistence.createProjectArtifacts(id, ownerId, artifacts); }
  listArtifacts(id, ownerId) { return this.persistence.listProjectArtifacts(id, ownerId); }
  createArtifact(id, ownerId, artifactPath, contents, language) {
    return this.persistence.createProjectArtifact(id, ownerId, artifactPath, contents, language);
  }
  readArtifact(id, ownerId, artifactPath) { return this.persistence.readProjectArtifact(id, ownerId, artifactPath); }
  writeArtifact(id, ownerId, artifactPath, contents, version, summary) {
    return this.persistence.writeProjectArtifact(id, ownerId, artifactPath, contents, version, summary);
  }
  renameArtifact(id, ownerId, fromPath, toPath, version) {
    return this.persistence.renameProjectArtifact(id, ownerId, fromPath, toPath, version);
  }
  duplicateArtifact(id, ownerId, sourcePath, targetPath) {
    return this.persistence.duplicateProjectArtifact(id, ownerId, sourcePath, targetPath);
  }
  deleteArtifact(id, ownerId, artifactPath, version) {
    return this.persistence.deleteProjectArtifact(id, ownerId, artifactPath, version);
  }
  artifactHistory(id, ownerId, artifactPath) {
    return this.persistence.getProjectArtifactHistory(id, ownerId, artifactPath);
  }
  restoreArtifact(id, ownerId, artifactPath, sourceVersion, expectedVersion) {
    return this.persistence.restoreProjectArtifact(id, ownerId, artifactPath, sourceVersion, expectedVersion);
  }
  artifactAudit(id, ownerId) { return this.persistence.listProjectArtifactAudit(id, ownerId); }
  createArtifactDirectory(id, ownerId, directoryPath) {
    return this.persistence.createProjectDirectory(id, ownerId, directoryPath);
  }
  renameArtifactDirectory(id, ownerId, fromPath, toPath) {
    return this.persistence.renameProjectDirectory(id, ownerId, fromPath, toPath);
  }
  deleteArtifactDirectory(id, ownerId, directoryPath) {
    return this.persistence.deleteProjectDirectory(id, ownerId, directoryPath);
  }
  createAgentTasks(id, ownerId, tasks, execution) { return this.persistence.createAgentTasks(id, ownerId, tasks, execution); }
  getAgenticExecution(id, ownerId) { return this.persistence.getAgenticExecution(id, ownerId); }
  listAgentTasks(id, ownerId) { return this.persistence.listAgentTasks(id, ownerId); }
  getAgentTask(id, ownerId, taskId) { return this.persistence.getAgentTask(id, ownerId, taskId); }
  transitionAgentTask(id, ownerId, taskId, expected, next, update, details) {
    return this.persistence.transitionAgentTask(id, ownerId, taskId, expected, next, update, details);
  }
  listAgentTaskEvents(id, ownerId, taskId) {
    return this.persistence.listAgentTaskEvents(id, ownerId, taskId);
  }
}

class GameStore {
  constructor(root) {
    this.persistence = getPersistence(root);
  }

  initialize() { return this.persistence.initialize(); }
  create(game) { return this.persistence.createGameProject(game); }
  list(ownerId) { return this.persistence.listGameProjects(ownerId); }
  get(id, ownerId) { return this.persistence.getGameProject(id, ownerId); }
  getVersion(id, ownerId, version) { return this.persistence.getGameVersion(id, ownerId, version); }
  appendVersion(id, ownerId, versionData) {
    return this.persistence.appendGameVersion(id, ownerId, versionData);
  }
  getSave(id, ownerId) { return this.persistence.getGameSave(id, ownerId); }
  save(id, ownerId, state) { return this.persistence.saveGameState(id, ownerId, state); }
}

module.exports = { AuthStore, GameStore, PersistenceStore, ProjectStore };
