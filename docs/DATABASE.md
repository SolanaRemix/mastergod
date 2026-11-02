# Database

The application uses Node's built-in SQLite support and initializes schema from `src/store.js`. The current database persists users/sessions, projects and approvals, agent tasks/events, execution snapshots, versioned artifacts, private games, game versions, and validated game saves.

The `agentic_executions` table stores a JSON-validated execution snapshot keyed by project and generation. Task-graph creation and snapshot insertion occur in one transaction, followed by database read-back. The execution API filters by both project and authenticated owner.

This is not a normalized enterprise/tenant schema. Agent specifications and versions, organizations, provider credentials, models, tools, connectors, workflows, billing, and deployment records do not exist. Schema initialization uses additive `CREATE TABLE IF NOT EXISTS` statements; a general migration/rollback framework and managed backups are not configured.
