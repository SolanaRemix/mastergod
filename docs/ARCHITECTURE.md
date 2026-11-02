# Architecture

## Current implementation

Master GODS preserves the dependency-free V13.2.0 Node.js, browser JavaScript, and SQLite architecture. Increment 1 adds a server-side OpenAI-compatible provider boundary; it is not a connected Google AI Studio project, and no framework or database replacement is introduced.

The request path is:

1. `public/app.js` submits a user prompt to `server.js`.
2. `src/blueprint.js` creates editable requirement records.
3. An authenticated user approves the blueprint.
4. `src/services/ProjectGenerator.ts` validates approved requirements and asks `src/capability-registry.js` to match capabilities to catalog entries.
5. `src/services/AgentOrchestrator.ts` prepares a dependency graph, queues tasks when registered local handlers and dependencies are available, and records each execution.
6. `src/store.js` stores the graph and execution snapshot in SQLite; the owner-scoped execution endpoint reads the snapshot back.
7. The optional Product Discovery task uses `src/providers.js` to route one structured request to an owner-configured provider. Provider credentials, routing decisions, request outcomes, health results, and audit actions are persisted and read back.

The local code-generation handler can write editable, project-specific HTML/CSS/JavaScript prototype files to the SQLite artifact store. All specialists except Product Discovery continue to use deterministic local rules. Product Discovery uses a provider only after the owner configures one; its structured result remains `IMPLEMENTED_UNVERIFIED`. The system does not generate a complete production application, execute user code, or deploy an application.

## Module ownership

| Layer | Entry point | Status |
|---|---|---|
| Browser workspace | `public/app.js`, `public/index.html`, `public/styles.css` | Implemented, not production-verified |
| HTTP API and authentication gates | `server.js` | Implemented, focused tests |
| Requirement and blueprint logic | `src/blueprint.js` | Implemented, deterministic |
| Capability metadata and discovery | `src/agents.js`, `src/capability-registry.js`, `src/core-agents.js` | 20 specialists; Product Discovery may use provider adapter |
| Provider adapter and router | `src/providers.js` | One OpenAI-compatible adapter; live external setup remains blocked |
| Task orchestration | `src/services/AgentOrchestrator.ts` | Local handlers and Product Discovery provider task; no durable queue |
| Project, artifact, execution, provider, and build persistence | `src/store.js` | SQLite implementation, owner-scoped |
| File exchange and safe preview | `src/project-archive.js`, `src/project-preview.js` | Verified text ZIP import/export and sandboxed static HTML preview |
| More provider adapters, dependency builds, arbitrary runtime, workflow engine, and production deployment | Not present | Blocked or missing |

## Repository compatibility

The repository does not contain prior V7 phase/specification/gate definitions or a connected Gemini application to preserve. V12 baseline and V13 upgrade gates are tracked in `gods.blueprint.yaml`; they are not represented as legacy V7 definitions.
