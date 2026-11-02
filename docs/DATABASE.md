# Database

The application uses Node's built-in SQLite support and initializes schema from `src/store.js`. The database persists users/sessions, projects and approvals, 20 core-agent specifications, agent tasks/events and execution logs, execution snapshots, versioned artifacts, safe build reports, private games, game versions, validated game saves, and Increment 1 provider state.

The `agentic_executions` table stores a JSON-validated execution snapshot keyed by project and generation. Task-graph creation and snapshot insertion occur in one transaction, followed by database read-back. The execution API filters by both project and authenticated owner.

Increment 1 adds additive SQLite tables for:

- `provider_credentials`: one AES-256-GCM ciphertext per `(owner_id, provider_id)`, plus the non-secret endpoint and model configuration.
- `provider_health`: timestamped, owner-scoped health outcomes and sanitized error codes.
- `model_requests`: task/provider/model, token counts when supplied, latency, status, and sanitized error code.
- `model_routing_decisions`: owner/project/task inputs, selected provider/model, and explanation.
- `provider_audit`: credential set/delete and health-check actions; no API keys or response bodies.

Writes are read back before the API reports success. Schema initialization uses additive `CREATE TABLE IF NOT EXISTS` statements and records schema version 2. A general migration/rollback framework and managed backups are not configured. This is not a normalized enterprise/tenant schema; organizations, provider failover, tools, connectors, workflows, billing, and deployment records remain unavailable.
