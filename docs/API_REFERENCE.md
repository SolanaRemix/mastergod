# API Reference

Project routes require an authenticated session and enforce project ownership. Provider settings/routes are authenticated and owner-scoped; all provider writes require same-origin JSON.

| Method and route | Purpose | Current outcome |
|---|---|---|
| `GET /api/health` | Read application readiness | Reports local readiness and production gate |
| `GET /api/agents` | Read agent capability catalog | Catalog descriptors only; not a provider connection |
| `GET /api/agents` (`operationalAgents`) | Read the persistent local specialist roster | 20 local specialists; Product Discovery may use the configured provider |
| `GET /api/providers` | Read provider catalog and credential availability | Returns provider ID, `hasKey`, and update time only |
| `PUT /api/providers/openai-compatible/credential` | Set/rotate `{apiKey, endpoint, model}` for the signed-in owner | AES-256-GCM encrypted; API never returns the key |
| `DELETE /api/providers/openai-compatible/credential` | Remove the signed-in owner's provider key | JSON body required; action is audited |
| `POST /api/providers/openai-compatible/health` | Check saved provider connectivity | Stores health result and audit row; may return `BLOCKED` |
| `GET /api/providers/openai-compatible/models` | Discover model IDs from saved provider | Owner-scoped; no credential required in response |
| `POST /api/projects` | Create a project from `{ "prompt": "..." }` | Creates a persisted draft |
| `POST /api/projects/:id/approve` | Approve/edit requirement decisions | Persists approved blueprint |
| `GET /api/projects/:id/blueprint` | Download project blueprint | Owner-scoped |
| `POST /api/projects/:id/generate` | Create capability plan and task graph | Local handlers and dependency states determine queued versus blocked tasks |
| `GET /api/projects/:id/execution` | Read the agentic execution snapshot | Owner-scoped SQLite read-back |
| `GET /api/projects/:id/tasks` | List task graph state | Owner-scoped |
| `GET /api/projects/:id/tasks/:taskId/events` | Read task state history | Owner-scoped |
| `POST /api/projects/:id/tasks/:taskId/run` | Run an assigned task handler | Product Discovery is `503 BLOCKED` without a configured provider; output/state are persisted and read back |
| `GET /api/projects/:id/routing-decisions` | Read explainable model-routing decisions | Project owner only |
| `GET /api/projects/:id/agent-executions` | Read persisted specialist run records | Owner-scoped |
| `GET /api/projects/:id/manifest` | Assemble a project implementation manifest from persisted requirements, tasks, executions, artifacts, and build reports | Owner-scoped, evidence-derived; unknown tests remain `UNKNOWN` |
| `GET /api/projects/:id/manifest?download=1` | Download the current implementation manifest as JSON | Same manifest and ownership checks |
| `POST /api/projects/:id/agents/:agentId/execute` | Run one of 20 local specialists on an approved project | Persists result; provider-dependent roles return `BLOCKED` |
| `POST /api/projects/:id/build` | Run bounded static syntax/structure checks | Persists build report; does not execute project code |
| `GET /api/projects/:id/builds` | Read build check history | Owner-scoped |
| `GET /api/projects/:id/preview?entry=...` | Preview a saved HTML artifact | Opaque sandbox, scripts only in iframe, network blocked |
| `/api/projects/:id/artifacts/*` | Manage project files and versions | Owner-scoped file operations |
| `POST /api/projects/:id/artifacts/upload` | Upload one UTF-8 text file | 256 KiB and safe-path limits |
| `GET /api/projects/:id/artifacts/zip` | Download a ZIP of stored text artifacts | ZIP verified before response |
| `POST /api/projects/:id/artifacts/zip-import` | Import text files from base64 ZIP | No overwrite; traversal, secrets, binary files and oversize entries rejected |
| `/api/games/*` | Manage private deterministic 2D games | Not AI-generated |

There are no `/api/v1` routes, agent authoring endpoints, workflow execution endpoints, wallet/swap routes, or billing routes in this release. The provider API supports one OpenAI-compatible adapter and Product Discovery only; it does not claim live provider connectivity until an owner configures and verifies a real endpoint.
