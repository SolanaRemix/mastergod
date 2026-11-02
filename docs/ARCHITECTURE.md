# Architecture

## Current implementation

Master GODS V13.0.0 remains a dependency-free Node.js application, not a connected Google AI Studio project. It uses the existing Node.js HTTP server, browser JavaScript, and SQLite architecture; no framework or database replacement is introduced.

The request path is:

1. `public/app.js` submits a user prompt to `server.js`.
2. `src/blueprint.js` creates editable requirement records.
3. An authenticated user approves the blueprint.
4. `src/services/ProjectGenerator.ts` validates approved requirements and asks `src/capability-registry.js` to match capabilities to catalog entries.
5. `src/services/AgentOrchestrator.ts` prepares a dependency graph, queues tasks when registered local handlers and dependencies are available, and records each execution.
6. `src/store.js` stores the graph and execution snapshot in SQLite; the owner-scoped execution endpoint reads the snapshot back.

The local code-generation handler can write editable, project-specific HTML/CSS/JavaScript prototype files to the SQLite artifact store. The specialists use deterministic local rules, not model providers. They do not generate a complete production application, execute user code, or deploy an application.

## Module ownership

| Layer | Entry point | Status |
|---|---|---|
| Browser workspace | `public/app.js`, `public/index.html`, `public/styles.css` | Implemented, not production-verified |
| HTTP API and authentication gates | `server.js` | Implemented, focused tests |
| Requirement and blueprint logic | `src/blueprint.js` | Implemented, deterministic |
| Capability metadata and discovery | `src/agents.js`, `src/capability-registry.js`, `src/core-agents.js` | 20 persisted deterministic local specialists; no model calls |
| Task orchestration | `src/services/AgentOrchestrator.ts` | Executable local handlers and persistent run records; no durable queue |
| Project, artifact, execution, and build persistence | `src/store.js` | SQLite implementation, owner-scoped |
| File exchange and safe preview | `src/project-archive.js`, `src/project-preview.js` | Verified text ZIP import/export and sandboxed static HTML preview |
| Provider adapters, dependency builds, arbitrary runtime, workflow engine, and production deployment | Not present | Blocked or missing |

## Repository compatibility

The repository does not contain prior V7 phase/specification/gate definitions or a connected Gemini application to preserve. V12 baseline and V13 upgrade gates are tracked in `gods.blueprint.yaml`; they are not represented as legacy V7 definitions.
