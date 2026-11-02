# Agent System

## Capability catalog

`src/agents.js` describes role contracts and capability metadata. `src/capability-registry.js` validates descriptors, matches request text to declared capabilities, ranks matching entries by availability/evaluation score, and records missing or undeployed capabilities.

## Current execution behavior

Catalog entries are marked `catalog-only` and `not-deployed`. The orchestrator can create persistent dependency-aware task records and execution snapshots, but it does not invoke models or create source files. A task is executable only when an actual handler is registered; no production worker is configured in this repository.

Custom descriptors can be registered in an in-process registry for planning. They are not persisted, versioned in SQLite, generated from an AI model, permission-approved, isolated, or independently executable. No unrestricted permissions are granted.

The SQLite execution record retains the original prompt, approved requirements, blueprint version, selected assignments, capability gaps, task references, approvals, test results, and status. `GET /api/projects/:id/execution` provides owner-scoped read-back.

## Not implemented

Persistent agent lifecycle and marketplace, version rollback, typed cross-agent handoffs, concurrency control, independent QA workers, evaluation datasets, model registry, and agent deployment/monitoring remain missing or blocked. See the release gate matrix in `gods.blueprint.yaml`.
