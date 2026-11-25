const { randomUUID, randomBytes } = require("node:crypto");

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 };
const COLLAB_ROLES = ["viewer", "editor", "admin"];
const DEFAULT_SETTINGS = Object.freeze({
  registrationOpen: true,
  maintenanceMode: false,
  announcement: "",
  chatRatePerHour: 120,
  maxCollaboratorsPerProject: 20,
  allowProviderChat: true
});

function hasRole(role, minimum) {
  return (ROLE_RANK[role] || 0) >= ROLE_RANK[minimum];
}

class StudioStore {
  constructor(store) {
    this.store = store;
    this.ready = null;
  }

  get db() {
    return this.store.persistence.database;
  }

  initialize() {
    if (!this.ready) {
      this.ready = this.store.initialize().then(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS project_collaborators (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
            invited_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (project_id, user_id)
          );
          CREATE INDEX IF NOT EXISTS collaborators_user ON project_collaborators(user_id);
          CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY NOT NULL,
            owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(owner_id, updated_at DESC);
          CREATE INDEX IF NOT EXISTS conversations_project ON conversations(project_id);
          CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            author_id TEXT,
            author_email TEXT,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
            agent_id TEXT,
            content TEXT NOT NULL,
            attachments TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS chat_messages_conversation ON chat_messages(conversation_id, id);
          CREATE TABLE IF NOT EXISTS project_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            actor_id TEXT,
            actor_email TEXT,
            kind TEXT NOT NULL,
            summary TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS project_activity_project ON project_activity(project_id, id DESC);
          CREATE TABLE IF NOT EXISTS agent_configs (
            scope TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            instructions TEXT,
            model TEXT,
            tools TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            updated_by TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (scope, agent_id)
          );
          CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL CHECK (json_valid(value)),
            updated_by TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS admin_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id TEXT NOT NULL,
            actor_email TEXT NOT NULL,
            action TEXT NOT NULL,
            target TEXT,
            details TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS user_status (
            user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            disabled INTEGER NOT NULL DEFAULT 0,
            reason TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            plan TEXT NOT NULL,
            amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 100000000),
            currency TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('paid', 'pending', 'refunded')),
            note TEXT,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS project_commits (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            branch TEXT NOT NULL,
            parent_id TEXT,
            merge_parent_id TEXT,
            message TEXT NOT NULL,
            author_email TEXT NOT NULL,
            files TEXT NOT NULL CHECK (json_valid(files)),
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS project_commits_project ON project_commits(project_id, created_at DESC);
          CREATE TABLE IF NOT EXISTS project_branches (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            head_id TEXT,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            is_current INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (project_id, name)
          );
        `);
      });
    }
    return this.ready;
  }

  // ---- access ----------------------------------------------------------
  async projectAccess(projectId, user) {
    await this.initialize();
    const project = await this.store.get(projectId);
    if (!project) return null;
    if (project.ownerId === user.id) return { project, role: "owner" };
    const row = this.db.prepare("SELECT role FROM project_collaborators WHERE project_id = ? AND user_id = ?").get(projectId, user.id);
    return row ? { project, role: row.role } : null;
  }

  async sharedProjects(userId) {
    await this.initialize();
    const rows = this.db.prepare(`
      SELECT c.project_id AS id, c.role, p.payload FROM project_collaborators c
      JOIN projects p ON p.id = c.project_id WHERE c.user_id = ? ORDER BY c.created_at DESC
    `).all(userId);
    return rows.map((row) => {
      const project = JSON.parse(row.payload);
      return { id: row.id, title: project.title, status: project.status, role: row.role, ownerId: project.ownerId };
    });
  }

  async listCollaborators(projectId) {
    await this.initialize();
    return this.db.prepare(`
      SELECT c.user_id AS userId, u.email, c.role, c.created_at AS createdAt
      FROM project_collaborators c JOIN users u ON u.id = c.user_id
      WHERE c.project_id = ? ORDER BY c.created_at
    `).all(projectId);
  }

  async invite(projectId, ownerId, email, role, invitedBy) {
    await this.initialize();
    if (!COLLAB_ROLES.includes(role)) throw Object.assign(new Error("Choose viewer, editor, or admin."), { status: 400 });
    const user = this.db.prepare("SELECT id, email FROM users WHERE email = ? COLLATE NOCASE").get(String(email).trim());
    if (!user) throw Object.assign(new Error("No account exists for that email. Ask them to register first."), { status: 404 });
    if (user.id === ownerId) throw Object.assign(new Error("The owner already has full access."), { status: 409 });
    const disabled = this.db.prepare("SELECT disabled FROM user_status WHERE user_id = ?").get(user.id);
    if (disabled?.disabled) throw Object.assign(new Error("That account is unavailable."), { status: 409 });
    const limit = Number((await this.getSettings()).maxCollaboratorsPerProject) || 20;
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM project_collaborators WHERE project_id = ?").get(projectId).n;
    const existing = this.db.prepare("SELECT 1 FROM project_collaborators WHERE project_id = ? AND user_id = ?").get(projectId, user.id);
    if (!existing && count >= limit) throw Object.assign(new Error(`This project already has ${limit} collaborators.`), { status: 409 });
    this.db.prepare(`
      INSERT INTO project_collaborators (project_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role
    `).run(projectId, user.id, role, invitedBy, new Date().toISOString());
    return { userId: user.id, email: user.email, role };
  }

  async removeCollaborator(projectId, userId) {
    await this.initialize();
    return Number(this.db.prepare("DELETE FROM project_collaborators WHERE project_id = ? AND user_id = ?").run(projectId, userId).changes) === 1;
  }

  // ---- activity --------------------------------------------------------
  async logActivity(projectId, user, kind, summary) {
    await this.initialize();
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO project_activity (project_id, actor_id, actor_email, kind, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(projectId, user?.id || null, user?.email || "system", kind, String(summary).slice(0, 500), createdAt);
    return { id: Number(result.lastInsertRowid), projectId, actor: user?.email || "system", kind, summary: String(summary).slice(0, 500), createdAt };
  }

  async listActivity(projectId, limit = 50) {
    await this.initialize();
    return this.db.prepare(`
      SELECT id, actor_email AS actor, kind, summary, created_at AS createdAt
      FROM project_activity WHERE project_id = ? ORDER BY id DESC LIMIT ?
    `).all(projectId, limit);
  }

  // ---- conversations ---------------------------------------------------
  async createConversation(user, { title, projectId = null }) {
    await this.initialize();
    const id = randomUUID().replaceAll("-", "");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conversations (id, owner_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, user.id, projectId, String(title || "New conversation").slice(0, 120), now, now);
    return { id, title: String(title || "New conversation").slice(0, 120), projectId, ownerId: user.id, createdAt: now, updatedAt: now };
  }

  async getConversation(id, user) {
    await this.initialize();
    const row = this.db.prepare(`
      SELECT id, owner_id AS ownerId, project_id AS projectId, title, created_at AS createdAt, updated_at AS updatedAt
      FROM conversations WHERE id = ?
    `).get(id);
    if (!row) return null;
    if (row.ownerId === user.id) return { ...row, role: "owner" };
    if (!row.projectId) return null;
    const access = await this.projectAccess(row.projectId, user);
    return access ? { ...row, role: access.role } : null;
  }

  async listConversations(user) {
    await this.initialize();
    return this.db.prepare(`
      SELECT c.id, c.title, c.project_id AS projectId, c.updated_at AS updatedAt, c.owner_id = ? AS mine
      FROM conversations c
      WHERE c.owner_id = ? OR c.project_id IN (SELECT project_id FROM project_collaborators WHERE user_id = ?)
      ORDER BY c.updated_at DESC LIMIT 100
    `).all(user.id, user.id, user.id).map((row) => ({ ...row, mine: Boolean(row.mine) }));
  }

  async deleteConversation(id, ownerId) {
    await this.initialize();
    return Number(this.db.prepare("DELETE FROM conversations WHERE id = ? AND owner_id = ?").run(id, ownerId).changes) === 1;
  }

  async addMessage(conversationId, message) {
    await this.initialize();
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO chat_messages (conversation_id, author_id, author_email, role, agent_id, content, attachments, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conversationId, message.authorId || null, message.authorEmail || null, message.role, message.agentId || null,
      message.content, JSON.stringify(message.attachments || []), createdAt);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(createdAt, conversationId);
    return Number(result.lastInsertRowid);
  }

  async listMessages(conversationId, limit = 200) {
    await this.initialize();
    return this.db.prepare(`
      SELECT id, role, author_email AS author, agent_id AS agentId, content, attachments, created_at AS createdAt
      FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
    `).all(conversationId, limit).reverse().map((row) => ({
      ...row,
      attachments: JSON.parse(row.attachments).map(({ name, size, type }) => ({ name, size, type }))
    }));
  }

  async countMessagesSince(userId, sinceIso) {
    await this.initialize();
    return this.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE author_id = ? AND role = 'user' AND created_at > ?").get(userId, sinceIso).n;
  }

  // ---- agent configuration ---------------------------------------------
  async getAgentConfigs(scope) {
    await this.initialize();
    const rows = this.db.prepare(`
      SELECT agent_id AS agentId, instructions, model, tools, enabled, updated_at AS updatedAt FROM agent_configs WHERE scope = ?
    `).all(scope);
    return new Map(rows.map((row) => [row.agentId, {
      instructions: row.instructions, model: row.model, tools: row.tools ? JSON.parse(row.tools) : null,
      enabled: Boolean(row.enabled), updatedAt: row.updatedAt
    }]));
  }

  async saveAgentConfig(scope, agentId, config, actorId) {
    await this.initialize();
    this.db.prepare(`
      INSERT INTO agent_configs (scope, agent_id, instructions, model, tools, enabled, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, agent_id) DO UPDATE SET instructions = excluded.instructions, model = excluded.model,
        tools = excluded.tools, enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(scope, agentId, config.instructions ?? null, config.model ?? null,
      config.tools ? JSON.stringify(config.tools) : null, config.enabled === false ? 0 : 1, actorId, new Date().toISOString());
  }

  async resetAgentConfig(scope, agentId) {
    await this.initialize();
    return Number(this.db.prepare("DELETE FROM agent_configs WHERE scope = ? AND agent_id = ?").run(scope, agentId).changes) === 1;
  }

  // ---- settings, audit, users, payments --------------------------------
  async getSettings() {
    await this.initialize();
    const settings = { ...DEFAULT_SETTINGS };
    for (const row of this.db.prepare("SELECT key, value FROM app_settings").all()) {
      if (row.key in DEFAULT_SETTINGS) settings[row.key] = JSON.parse(row.value);
    }
    return settings;
  }

  async updateSettings(changes, actorId) {
    await this.initialize();
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(changes)) {
      this.db.prepare(`
        INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), actorId, now);
    }
    return this.getSettings();
  }

  async audit(actor, action, target, details = {}) {
    await this.initialize();
    this.db.prepare("INSERT INTO admin_audit (actor_id, actor_email, action, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(actor.id, actor.email, action, target ?? null, JSON.stringify(details), new Date().toISOString());
  }

  async listAudit(limit = 100) {
    await this.initialize();
    return this.db.prepare(`
      SELECT id, actor_email AS actor, action, target, details, created_at AS createdAt FROM admin_audit ORDER BY id DESC LIMIT ?
    `).all(limit).map((row) => ({ ...row, details: JSON.parse(row.details) }));
  }

  async listUsers() {
    await this.initialize();
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT u.id, u.email, u.role, u.created_at AS createdAt,
        COALESCE(s.disabled, 0) AS disabled,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS projects,
        (SELECT COUNT(*) FROM sessions x WHERE x.user_id = u.id AND x.expires_at > ?) AS sessions,
        COALESCE((SELECT plan FROM payments y WHERE y.user_id = u.id AND y.status = 'paid' ORDER BY y.created_at DESC LIMIT 1), 'free') AS plan
      FROM users u LEFT JOIN user_status s ON s.user_id = u.id ORDER BY u.created_at DESC LIMIT 500
    `).all(now).map((row) => ({ ...row, disabled: Boolean(row.disabled) }));
  }

  async getUser(id) {
    await this.initialize();
    return this.db.prepare("SELECT id, email, role FROM users WHERE id = ?").get(id) || null;
  }

  async setUserDisabled(userId, disabled, reason) {
    await this.initialize();
    this.db.prepare(`
      INSERT INTO user_status (user_id, disabled, reason, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET disabled = excluded.disabled, reason = excluded.reason, updated_at = excluded.updated_at
    `).run(userId, disabled ? 1 : 0, reason ? String(reason).slice(0, 200) : null, new Date().toISOString());
    if (disabled) this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  async isDisabled(userId) {
    await this.initialize();
    return Boolean(this.db.prepare("SELECT disabled FROM user_status WHERE user_id = ?").get(userId)?.disabled);
  }

  async isEmailDisabled(email) {
    await this.initialize();
    return Boolean(this.db.prepare(`
      SELECT 1 FROM user_status s JOIN users u ON u.id = s.user_id WHERE u.email = ? COLLATE NOCASE AND s.disabled = 1
    `).get(String(email).trim()));
  }

  async revokeSessions(userId = null) {
    await this.initialize();
    const result = userId
      ? this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId)
      : this.db.prepare("DELETE FROM sessions").run();
    return Number(result.changes);
  }

  async deleteUser(userId) {
    await this.initialize();
    return Number(this.db.prepare("DELETE FROM users WHERE id = ? AND role != 'admin'").run(userId).changes) === 1;
  }

  async listPayments() {
    await this.initialize();
    return this.db.prepare(`
      SELECT p.id, u.email, p.plan, p.amount_cents AS amountCents, p.currency, p.status, p.note, p.created_at AS createdAt
      FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 200
    `).all();
  }

  async recordPayment(userId, { plan, amountCents, currency, status, note }, actorId) {
    await this.initialize();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO payments (id, user_id, plan, amount_cents, currency, status, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, plan, amountCents, currency, status, note || null, actorId, new Date().toISOString());
    return id;
  }

  async setPaymentStatus(id, status) {
    await this.initialize();
    return Number(this.db.prepare("UPDATE payments SET status = ? WHERE id = ?").run(status, id).changes) === 1;
  }

  async paymentTotals() {
    await this.initialize();
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents END), 0) AS paidCents,
        COALESCE(SUM(CASE WHEN status = 'refunded' THEN amount_cents END), 0) AS refundedCents,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending
      FROM payments
    `).get();
    return { ...row };
  }

  async apiUsage() {
    await this.initialize();
    return {
      byStatus: this.db.prepare("SELECT status, COUNT(*) AS count FROM model_requests GROUP BY status").all(),
      byModel: this.db.prepare(`
        SELECT model, COUNT(*) AS requests, COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
          COALESCE(SUM(completion_tokens), 0) AS completionTokens FROM model_requests GROUP BY model ORDER BY requests DESC LIMIT 20
      `).all(),
      providersConfigured: this.db.prepare("SELECT COUNT(*) AS n FROM provider_credentials").get().n,
      recentErrors: this.db.prepare(`
        SELECT error, COUNT(*) AS count FROM model_requests WHERE status = 'FAILED' GROUP BY error ORDER BY count DESC LIMIT 10
      `).all(),
      chatMessagesLast24h: this.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at > ?")
        .get(new Date(Date.now() - 86400000).toISOString()).n
    };
  }

  async overview() {
    await this.initialize();
    const count = (sql, ...params) => this.db.prepare(sql).get(...params).n;
    return {
      conversations: count("SELECT COUNT(*) AS n FROM conversations"),
      messages: count("SELECT COUNT(*) AS n FROM chat_messages"),
      collaborators: count("SELECT COUNT(*) AS n FROM project_collaborators"),
      commits: count("SELECT COUNT(*) AS n FROM project_commits"),
      disabledUsers: count("SELECT COUNT(*) AS n FROM user_status WHERE disabled = 1"),
      admins: count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
    };
  }

  async userDashboard(user) {
    await this.initialize();
    const count = (sql, ...params) => this.db.prepare(sql).get(...params).n;
    return {
      projects: count("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?", user.id),
      shared: count("SELECT COUNT(*) AS n FROM project_collaborators WHERE user_id = ?", user.id),
      conversations: count("SELECT COUNT(*) AS n FROM conversations WHERE owner_id = ?", user.id),
      messages: count("SELECT COUNT(*) AS n FROM chat_messages WHERE author_id = ?", user.id),
      files: count("SELECT COUNT(*) AS n FROM project_artifacts WHERE owner_id = ?", user.id),
      plan: this.db.prepare("SELECT plan FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1").get(user.id)?.plan || "free",
      recentActivity: this.db.prepare(`
        SELECT a.project_id AS projectId, a.actor_email AS actor, a.kind, a.summary, a.created_at AS createdAt
        FROM project_activity a
        WHERE a.project_id IN (SELECT id FROM projects WHERE owner_id = ?1 UNION SELECT project_id FROM project_collaborators WHERE user_id = ?1)
        ORDER BY a.id DESC LIMIT 10
      `).all(user.id)
    };
  }

  // ---- git-style history -----------------------------------------------
  async ensureBranches(projectId, actorEmail) {
    await this.initialize();
    const existing = this.db.prepare("SELECT 1 FROM project_branches WHERE project_id = ?").get(projectId);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO project_branches (project_id, name, head_id, created_by, created_at, is_current) VALUES (?, 'main', NULL, ?, ?, 1)
      `).run(projectId, actorEmail, new Date().toISOString());
    }
  }

  async listBranches(projectId, actorEmail) {
    await this.ensureBranches(projectId, actorEmail);
    return this.db.prepare(`
      SELECT b.name, b.head_id AS headId, b.created_by AS createdBy, b.created_at AS createdAt, b.is_current AS isCurrent,
        c.message AS headMessage
      FROM project_branches b LEFT JOIN project_commits c ON c.id = b.head_id WHERE b.project_id = ? ORDER BY b.created_at
    `).all(projectId).map((row) => ({ ...row, isCurrent: Boolean(row.isCurrent) }));
  }

  async getBranch(projectId, name) {
    await this.initialize();
    return this.db.prepare("SELECT name, head_id AS headId, is_current AS isCurrent FROM project_branches WHERE project_id = ? AND name = ?").get(projectId, name) || null;
  }

  async currentBranch(projectId, actorEmail) {
    await this.ensureBranches(projectId, actorEmail);
    return this.db.prepare("SELECT name, head_id AS headId FROM project_branches WHERE project_id = ? AND is_current = 1").get(projectId);
  }

  async createBranch(projectId, name, fromBranch, actorEmail) {
    await this.ensureBranches(projectId, actorEmail);
    const source = await this.getBranch(projectId, fromBranch);
    if (!source) throw Object.assign(new Error("Source branch not found."), { status: 404 });
    if (await this.getBranch(projectId, name)) throw Object.assign(new Error("A branch with that name already exists."), { status: 409 });
    this.db.prepare(`
      INSERT INTO project_branches (project_id, name, head_id, created_by, created_at, is_current) VALUES (?, ?, ?, ?, ?, 0)
    `).run(projectId, name, source.headId, actorEmail, new Date().toISOString());
  }

  async setCurrentBranch(projectId, name) {
    await this.initialize();
    this.db.prepare("UPDATE project_branches SET is_current = (name = ?) WHERE project_id = ?").run(name, projectId);
  }

  async createCommit(projectId, { branch, parentId, mergeParentId = null, message, authorEmail, files }) {
    await this.initialize();
    const id = randomBytes(10).toString("hex");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO project_commits (id, project_id, branch, parent_id, merge_parent_id, message, author_email, files, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, branch, parentId, mergeParentId, message, authorEmail, JSON.stringify(files), now);
      this.db.prepare("UPDATE project_branches SET head_id = ? WHERE project_id = ? AND name = ?").run(id, projectId, branch);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, branch, parentId, mergeParentId, message, authorEmail, createdAt: now };
  }

  async getCommit(projectId, id) {
    await this.initialize();
    const row = this.db.prepare(`
      SELECT id, branch, parent_id AS parentId, merge_parent_id AS mergeParentId, message, author_email AS authorEmail,
        files, created_at AS createdAt FROM project_commits WHERE project_id = ? AND id = ?
    `).get(projectId, id);
    return row ? { ...row, files: JSON.parse(row.files) } : null;
  }

  async listCommits(projectId, limit = 100) {
    await this.initialize();
    return this.db.prepare(`
      SELECT id, branch, parent_id AS parentId, merge_parent_id AS mergeParentId, message, author_email AS authorEmail,
        created_at AS createdAt
      FROM project_commits WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(projectId, limit);
  }
}

module.exports = { COLLAB_ROLES, DEFAULT_SETTINGS, StudioStore, hasRole };
