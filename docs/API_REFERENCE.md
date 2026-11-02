# API Reference

All project routes require an authenticated session and enforce project ownership. State-changing project routes additionally enforce same-origin checks.

| Method and route | Purpose | Current outcome |
|---|---|---|
| `GET /api/health` | Read application readiness | Reports local readiness and production gate |
| `GET /api/agents` | Read agent capability catalog | Catalog descriptors only; not a provider connection |
| `POST /api/projects` | Create a project from `{ "prompt": "..." }` | Creates a persisted draft |
| `POST /api/projects/:id/approve` | Approve/edit requirement decisions | Persists approved blueprint |
| `GET /api/projects/:id/blueprint` | Download project blueprint | Owner-scoped |
| `POST /api/projects/:id/generate` | Create capability plan and task graph | Returns `IMPLEMENTED_UNVERIFIED`; tasks may be `BLOCKED` |
| `GET /api/projects/:id/execution` | Read the agentic execution snapshot | Owner-scoped SQLite read-back |
| `GET /api/projects/:id/tasks` | List task graph state | Owner-scoped |
| `GET /api/projects/:id/tasks/:taskId/events` | Read task state history | Owner-scoped |
| `POST /api/projects/:id/tasks/:taskId/run` | Request worker execution | Returns blocked when no worker exists |
| `/api/projects/:id/artifacts/*` | Manage project files and versions | Owner-scoped file operations |
| `/api/games/*` | Manage private deterministic 2D games | Not AI-generated |

There are no `/api/v1` routes, provider administration endpoints, agent authoring endpoints, workflow execution endpoints, wallet/swap routes, or billing routes in this release.
