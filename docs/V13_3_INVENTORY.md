# V13.3 Increment 1 — Repository Inventory

**Inventory date:** 2026-11-02  
**Baseline:** V13.2.0, commit `f15a13f`  
**Purpose:** Record the inspected repository state before implementation. This inventory is not evidence that target features exist or pass acceptance tests.

## Tracked repository files

Collected with `git ls-files` (excluding restricted agent-instruction contents):

```text
.github/workflows/ci-cd.yml
.gitignore
LICENSE
README.md
docs/AGENT_SYSTEM.md
docs/API_REFERENCE.md
docs/ARCHITECTURE.md
docs/CHANGELOG.md
docs/DATABASE.md
docs/DEPLOYMENT.md
docs/IMPLEMENTATION_PLAN.md
docs/PROVIDER_INTEGRATIONS.md
docs/RELEASE_V12.md
docs/RELEASE_V13.md
docs/SECURITY.md
docs/TESTING.md
gods.blueprint.yaml
package.json
public/app.js
public/index.html
public/markdown-renderer.js
public/styles.css
scripts/build.js
scripts/check.js
scripts/deploy-release.sh
scripts/provision-admin.js
server.js
src/agents.js
src/artifacts.js
src/auth.js
src/blueprint.js
src/capability-registry.js
src/core-agents.js
src/game-studio.js
src/project-archive.js
src/project-manifest.js
src/project-preview.js
src/services/AgentOrchestrator.ts
src/services/ProjectGenerator.ts
src/services/StaticBuildService.js
src/store.js
test/app.test.js
test/markdown-renderer.test.js
test/project-manifest.test.js
```

## Existing documentation inventory

- `AGENT_SYSTEM.md`: persistent 20-role deterministic local roster, execution contract and limitations.
- `API_REFERENCE.md`: current authenticated `/api/*` routes, project artifacts, tasks, ZIP, previews and static build checks.
- `ARCHITECTURE.md`: existing Node HTTP/browser/SQLite module layout.
- `CHANGELOG.md`: V12 and V13.0/V13.2 implementation history.
- `DATABASE.md`: current SQLite tables and schema limitations.
- `DEPLOYMENT.md`: gated deployment and environment requirements.
- `IMPLEMENTATION_PLAN.md`: V12 scope and baseline gaps.
- `PROVIDER_INTEGRATIONS.md`: provider integrations are not configured.
- `RELEASE_V12.md`, `RELEASE_V13.md`: existing release classification and blockers.
- `SECURITY.md`: authentication, origin, artifact and preview security boundaries.
- `TESTING.md`: `npm run check`, `npm test`, `npm run build` and unsupported acceptance coverage.

The requested `docs/MASTER_IMPLEMENTATION_SSOT.md`, `docs/V13_3_ACCEPTANCE.md`, and `docs/V13_3_EVIDENCE.md` do not exist at this baseline.

## Canonical blueprint snapshot

`gods.blueprint.yaml` is JSON-compatible YAML, version `13.2.0`; its `release.productionReady` is `false`, and it contains the existing V12/V13 gate matrix. Relevant current declarations:

| Area | Baseline evidence/status |
|---|---|
| Runtime and persistence | Node.js `>=22.13.0`, built-in `node:sqlite`, no npm dependencies; `src/store.js` initializes SQLite and imports owned legacy records once. |
| Authentication | `src/auth.js` uses `scrypt`; server session cookies and origin checks are implemented. |
| Agent roster | 20 deterministic local specialist definitions and handlers exist in `src/core-agents.js`; there is no model provider adapter or model assignment. |
| Orchestration | `src/services/AgentOrchestrator.ts` persists task/execution records and executes registered handlers in the request process; no durable background worker/recovery. |
| Product discovery | Requirements are split/approved locally by `src/blueprint.js`; the requirements specialist is deterministic and does not call a model. |
| Artifact workspace | Owner-scoped, versioned UTF-8 artifact CRUD, ZIP import/export, restricted HTML preview and static diagnostics exist. |
| Provider boundary | `providerIntegrations.configured` and `supportedAdapters` are empty; provider execution is disabled. |
| Security configuration | No provider credential table, encryption key lifecycle, SSRF policy, provider health, or routing-decision table exists. |
| GitHub and deployment | GitHub OAuth/sync is blocked; production deployment remains gated and blocked. |

These are inspection findings. Feature statuses still require the appropriate executed acceptance evidence.

## Increment 1 requirements-to-implementation trace

| Requirement | Baseline | Increment 1 target | Evidence needed |
|---|---|---|---|
| OpenAI-compatible provider contract | Missing | Implement a `fetch`-based adapter with health/model discovery/completion and normalized errors | Mock HTTP server tests; external live provider remains blocked without credentials |
| Safe provider URL selection | Missing | Validate provider URLs and deny loopback/private targets by default; local provider access only with explicit opt-in | URL-policy tests, including private/loopback/IPv4-mapped and allowed public URLs |
| Provider credentials | Missing | Owner-scoped AES-256-GCM ciphertext with IV/tag; never return or log plaintext | Set/list/rotate/delete integration tests, ciphertext read-back, API response redaction |
| Secret key boot policy | Missing | Require configured `GODS_SECRET_KEY` for credential operations and production; reject malformed keys | Boot/config tests with isolated process environments |
| Model routing decision | Missing | Deterministic scoring and persisted explanation; no candidates returns `BLOCKED` | Stable scoring and empty-provider tests; SQLite read-back |
| Model/provider health | Missing | Owner-scoped provider catalog/health/model routes with accurate `hasKey` only | Auth, same-origin, ownership and mock-provider tests |
| Product Discovery execution | Deterministic local handler only | Route one Product Discovery task through the provider boundary when configured; preserve blocked status without eligible credentials/model | Mock end-to-end route/task/output validation/read-back/audit |
| Audit trail | Existing artifact audit only | Record provider credential and health actions without storing secrets | Database read-back and absence-of-secret assertions |

## Increment 1 non-goals and blockers

- No Gemini, Anthropic, or provider failover implementation in this increment.
- No dynamic agent factory, durable worker queue, GitHub integration, workflow, Web3, or deployment changes.
- No automatic live provider verification is possible unless an operator supplies a supported endpoint, credential, and encryption key in the runtime environment.
- No private project data may be transmitted to an endpoint that fails the URL policy or is not explicitly configured by the owning user.
- `productionReady` remains `false`.

## Existing validation commands

Declared by `package.json`:

```sh
npm run check
npm test
npm run build
```

These commands must be rerun after implementation. A passing local mock-provider suite does not establish an external provider connection.
