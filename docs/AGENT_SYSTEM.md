# Agent System

## Capability catalog

`src/agents.js` describes legacy provider-dependent catalog roles. `src/core-agents.js` defines 20 distinct, versioned deterministic local specialists and their bounded permissions. Startup persists the 20 specifications in SQLite; `/api/agents` reads back the persistent roster. `src/capability-registry.js` validates descriptors, matches request text to declared capabilities, ranks matching entries by availability/evaluation score, and records missing or unavailable capabilities.

## Current execution behavior

The 20 local specialists have registered deterministic handlers and are available to the orchestrator. Each execution is recorded in SQLite with agent/version, project/task, input/output, tools, nullable provider/model IDs, start/finish times, status, errors, and validation. The code-generation worker writes request-specific editable HTML/CSS/JavaScript artifacts to the owner-scoped artifact store. Its output is a browser-local prototype, not a complete production application. None of these workers call an AI model.

Custom descriptors can be registered in an in-process registry for planning. They are not persisted, generated from an AI model, isolated, or deployed. Agent evaluation history is limited to output/task validation; no evaluation-driven promotion is implemented. No unrestricted permissions are granted.

The SQLite execution record retains the original prompt, approved requirements, blueprint version, selected assignments, capability gaps, task references, approvals, test results, and status. `GET /api/projects/:id/execution` and `GET /api/projects/:id/agent-executions` provide owner-scoped read-back.

## Not implemented

Persistent custom-agent lifecycle and marketplace, version rollback, typed cross-agent handoffs, durable queue/concurrency control, full independent QA, evaluation datasets, model registry, and agent deployment/monitoring remain missing or blocked. See the release gate matrix in `gods.blueprint.yaml`.
