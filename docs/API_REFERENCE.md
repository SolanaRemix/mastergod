# API Reference

All project routes require an authenticated session and enforce project ownership. State-changing project routes additionally enforce same-origin checks.

| Method and route | Purpose | Current outcome |
|---|---|---|
| `GET /api/health` | Read application readiness | Reports local readiness and production gate |
| `GET /api/agents` | Read agent capability catalog | Catalog descriptors only; not a provider connection |
| `GET /api/agents` (`operationalAgents`) | Read the persistent local specialist roster | 20 deterministic local workers; no model calls |
| `POST /api/projects` | Create a project from `{ "prompt": "..." }` | Creates a persisted draft |
| `POST /api/projects/:id/approve` | Approve/edit requirement decisions | Persists approved blueprint |
| `GET /api/projects/:id/blueprint` | Download project blueprint | Owner-scoped |
| `POST /api/projects/:id/generate` | Create capability plan and task graph | Returns `IMPLEMENTED_UNVERIFIED`; tasks may be `BLOCKED` |
| `GET /api/projects/:id/execution` | Read the agentic execution snapshot | Owner-scoped SQLite read-back |
| `GET /api/projects/:id/tasks` | List task graph state | Owner-scoped |
| `GET /api/projects/:id/tasks/:taskId/events` | Read task state history | Owner-scoped |
| `POST /api/projects/:id/tasks/:taskId/run` | Request worker execution | Returns blocked when no worker exists |
| `GET /api/projects/:id/agent-executions` | Read persisted specialist run records | Owner-scoped |
| `POST /api/projects/:id/build` | Run bounded static syntax/structure checks | Persists build report; does not execute project code |
| `GET /api/projects/:id/builds` | Read build check history | Owner-scoped |
| `GET /api/projects/:id/preview?entry=...` | Preview a saved HTML artifact | Opaque sandbox, scripts only in iframe, network blocked |
| `/api/projects/:id/artifacts/*` | Manage project files and versions | Owner-scoped file operations |
| `POST /api/projects/:id/artifacts/upload` | Upload one UTF-8 text file | 256 KiB and safe-path limits |
| `GET /api/projects/:id/artifacts/zip` | Download a ZIP of stored text artifacts | ZIP verified before response |
| `POST /api/projects/:id/artifacts/zip-import` | Import text files from base64 ZIP | No overwrite; traversal, secrets, binary files and oversize entries rejected |
| `/api/games/*` | Manage private deterministic 2D games | Not AI-generated |

There are no `/api/v1` routes, provider administration endpoints, agent authoring endpoints, workflow execution endpoints, wallet/swap routes, or billing routes in this release.
