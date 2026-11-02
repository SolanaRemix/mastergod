# MASTER GODS AI STUDIO — SINGLE SOURCE OF TRUTH

**Implementation Plan v1.0 — Merged V13.2.0 Baseline + V13.3.0 Enterprise Elite Target**  
**DOCUMENT_ID:** MG-SSOT-001  
**MERGE_SOURCE:** V13.2.0 README baseline + V13.3.0 Enterprise Elite + Agent Team Brief + Increment 1  
**AUTHORITY:** This document supersedes separate implementation-planning prompts. `gods.blueprint.yaml` remains the machine-validated platform SSOT.  
**STATUS:** Authoritative staged plan; not proof of implementation.  
**EVIDENCE_RULE:** A feature is `VERIFIED` only when executed acceptance evidence is linked from `docs/V13_3_EVIDENCE.md`.

## 0. How to use this document

1. Inspect before modifying. Refresh `docs/V13_3_INVENTORY.md` from tracked files, `docs/`, and `gods.blueprint.yaml` before each increment.
2. One increment per PR. Implement exactly one roadmap increment and end with an evidence ledger.
3. Use honest statuses. External functionality without configured credentials/permissions is `BLOCKED`, not assumed working.
4. Preserve V13.2.0: dependency-free Node 22.13+, `node:sqlite`, scrypt, `__Host-` cookies in production, artifact file manager, sandboxed preview, game slice, admin provisioning, and CI/CD.
5. Follow the evidence chain for mutations: UI → handler → route → service → database → external provider (if applicable) → read-back → audit → user-visible result.

## 1. System identity

| Field | Value |
|---|---|
| Product | MASTER GODS AI STUDIO |
| Baseline | V13.2.0, local-first and dependency-free |
| Target | V13.3.0 Enterprise Elite, staged delivery |
| Current readiness | `productionReady: false` |
| Primary environment | Node.js 22.13+ runtime; repository-first and portable |
| Secondary environment | Google AI Studio / Gemini execution adapter |

This is not a chatbot-only, UI-mock-only, snippet-only, planner-only, evidence-faking product.

## 2. Single source of truth stack

| Layer | File | Purpose | Validation |
|---|---|---|---|
| Platform SSOT | `gods.blueprint.yaml` | Platform identity, modules, agents, providers, gates | Versioned schema |
| Project SSOT | `projects/{id}/project.blueprint.yaml` | Per-project scope | Schema and approved requirements |
| Module contract | `modules/{id}/module.manifest.yaml` | Module I/O and dependencies | Manifest validator |
| Implementation evidence | `artifacts/implementation-manifest.json` | Actual files, tests, statuses | Repository and DB read-back |
| Human plan | `docs/MASTER_IMPLEMENTATION_SSOT.md` | Increment scope | Per-increment review |
| Inventory | `docs/V13_3_INVENTORY.md` | Gap analysis | Refreshed each increment |
| Acceptance | `docs/V13_3_ACCEPTANCE.md` | Per-feature criteria | Linked tests |
| Evidence ledger | `docs/V13_3_EVIDENCE.md` | Twelve-gate results | Verification agent |

No module may redefine a platform feature without updating `gods.blueprint.yaml`.

## 3. Target architecture

```text
master-gods-ai-studio/
├── apps/
│   ├── web/                  # Existing SPA builder and workspace
│   ├── api/                  # Existing Node built-in HTTP server
│   ├── worker/               # Future durable background task worker
│   └── preview/              # Existing sandboxed preview origin
├── packages/
│   ├── providers/            # Provider adapters (Increment 1+)
│   ├── router/               # Model router
│   ├── orchestrator/         # Durable task graph
│   ├── agents/               # Agent descriptors and handlers
│   ├── tools/                # Tool registry
│   ├── plugins/              # Plugin registry (Increment 4+)
│   ├── database/             # Migrations and read-back helpers
│   ├── auth/                 # scrypt, sessions, cookies
│   ├── blueprints/           # Blueprint parse and validation
│   ├── audit/                # Append-only audit and hash chain
│   ├── assets/               # Asset studio (Increment 8+)
│   ├── games/                # Existing game slice
│   ├── web3/                 # Web3 (Increment 9+)
│   ├── github/               # OAuth and sync (Increment 6+)
│   ├── workflows/            # Visual workflow engine (Increment 7+)
│   └── clm/                  # GODS CLM (Increment 10+)
├── modules/gods-clm/         # CLM application domain (future)
├── database/                 # Migrations, seeds, schema
├── tests/                    # Unit, integration, security, e2e, failure, load
├── artifacts/                # Implementation manifest and acceptance report
├── docs/
├── scripts/
├── infrastructure/
├── gods.blueprint.yaml
└── README.md
```

V13.2.0 is dependency-free except Node built-ins. Any new npm dependency requires explicit justification in its increment and security review.

## 4. Increment 1 database delta

Add tables using the existing migration style:

```text
provider_credentials(id, owner_id, provider_id, ciphertext, iv, tag, created_at, updated_at)
  UNIQUE(owner_id, provider_id)

provider_health(id, provider_id, checked_at, ok, latency_ms, error)

model_requests(
  id, project_id, task_id, agent_id, provider_id, model,
  prompt_tokens, completion_tokens, latency_ms, status, error, created_at
)
  INDEX(project_id, created_at)

model_routing_decisions(
  id, project_id, task_id, inputs_json, chosen_provider, chosen_model, reason, created_at
)
  INDEX(project_id, created_at)
```

Future increments may add plugins, plugin credentials, workflow runs, assets, Git sync, CLM contracts/versions/AI logs/signatures/collaboration revisions, audit logs, deployments, and usage records. Every write must be read back before returning success.

## 5. API surface

Existing routes remain unchanged: `/api/health`, `/api/auth/*`, `/api/admin/summary`, `/api/agents`, `/api/projects/*` (artifacts, tasks, execution, manifest, builds, preview), and `/api/games/*`.

Increment 1 adds:

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/providers` | Catalog and `hasKey` only; never return a key |
| PUT | `/api/providers/:id/credential` | Set or rotate encrypted credential |
| DELETE | `/api/providers/:id/credential` | Remove credential |
| POST | `/api/providers/:id/health` | Live health check |
| GET | `/api/providers/:id/models` | Model discovery |
| GET | `/api/projects/:id/routing-decisions` | Explainable routing log |

Reserved for later increments: `/api/plugins/*`, `/api/workflows/*`, `/api/github/*`, `/api/deployments/*`, `/api/audit/*`, `/api/clm/*`.

Every endpoint requires authentication, owner/tenant scope, same-origin JSON for writes, structured errors, audit, and tests.

## 6. Agent roster

V13.2.0 has 20 registered deterministic local specialists. V13.3.0 targets those same 20 with provider augmentation. Increment 1 wires Product Discovery through the provider boundary.

| # | Agent | Increment 1 | Later |
|---:|---|---|---|
| 1 | Master Orchestrator | Partial | Durable task graph |
| 2 | Requirements & Intent | Local (unchanged) | Provider |
| 3 | System Architecture | Local | Provider |
| 4 | UI/UX Design | Local | Provider |
| 5 | Frontend Engineering | Local | Provider |
| 6 | Backend Engineering | Local | Provider |
| 7 | Database Engineering | Local | Provider |
| 8 | AI Model Integration | New | — |
| 9 | Dynamic Agent Factory | Planned | Increment 4 |
| 10 | Code Generation | Local prototype | Increment 5 |
| 11 | Game Development | Local slice | Increment 8 |
| 12 | Asset Generation | Missing | Increment 8 |
| 13 | Workflow Automation | Missing | Increment 7 |
| 14 | Web3 / Blockchain | Missing | Increment 9 |
| 15 | Security Engineering | Partial | Ongoing |
| 16 | QA & Testing | New suite | Ongoing |
| 17 | Code Review & Repair | Increment 1 review | Ongoing |
| 18 | Performance & Accessibility | Missing | Increment 8 |
| 19 | DevOps & Deployment | Partial, gated | Increment 6 |
| 20 | Independent Verification | New evidence role | Ongoing |

An agent profile is operational only when it can receive a task, invoke authorized tools, produce output, and pass validation.

## 7. Provider and router specification — Increment 1

### 7.1 Adapter contract

The adapter exposes `id`, `capabilities`, `healthCheck()`, `listModels()`, `complete({messages, tools, jsonSchema, stream}) → {text, toolCalls?, json?, usage}`, `normalizeError(err)`, and `usageStats()`.

### 7.2 Initial provider

- OpenAI-compatible only (including OpenAI, Azure OpenAI, OpenRouter, Groq, Ollama, and local-compatible services when configured).
- Uses `fetch`; no SDK.
- SSRF guard denies private/loopback addresses unless `GODS_ALLOW_LOCAL_PROVIDER=1`.
- Retry uses exponential backoff and jitter, honors `Retry-After`, and makes at most three attempts.
- Persists one `model_requests` row per call.

### 7.3 Credential storage

- AES-256-GCM using `GODS_SECRET_KEY`.
- Production boot refuses to start without the required key.
- API returns `{provider_id, hasKey: true|false, updated_at}` only.

### 7.4 Router

Deterministically score `{task_type, complexity, budget, require_tools, require_json, preferred_provider}`. With no eligible providers, return `BLOCKED` and a reason. Persist every routing decision.

### 7.5 Increment 1 end-to-end acceptance

UI approval and Product Discovery run → `POST /api/projects/:id/tasks/:taskId/run` → orchestrator → router → OpenAI-compatible adapter (mock server in tests; real only with a supplied key) → JSON-schema validation → task output persistence → SQLite read-back → audit row → response containing no secrets.

## 8. Increment roadmap

| # | Increment | Scope | Gates | `productionReady` |
|---:|---|---|---|---|
| 1 | Provider Boundary + Router + 1 Agent | Section 7 | 07, 08, 09, 10 | false |
| 2 | Four more agents | Architecture, FE, BE, QA provider calls | 09 | false |
| 3 | Extra providers and failover | Anthropic, Gemini adapters, circuit breaker | 07, 09 | false |
| 4 | RBAC and organizations | Multi-tenancy and five admin pages | 08, 12 | false |
| 5 | Real file generation and build | One stack, child process with limits | 10, 11 | false |
| 6 | GitHub and deploy | OAuth, branch/commit/PR, gated deployment | 11, 12 | false until all gates pass |
| 7 | Workflows and plugins | Visual workflows and plugin registry | 10, 12 | false |
| 8 | Game, assets, performance | Three.js, asset studio, accessibility | 04, 10 | false |
| 9 | Web3 adapters | EVM and Solana read-only first | 07, 08 | false |
| 10 | GODS CLM | Full module and 12-gate acceptance | 01–12 | false until CLM gate passes |

`productionReady` may become true only when every applicable gate has `PASS` evidence in `docs/V13_3_EVIDENCE.md`.

## 9. Twelve verification gates

| Gate | Name | Evidence required |
|---:|---|---|
| 01 | Requirements | Mapping in `docs/V13_3_ACCEPTANCE.md` |
| 02 | Blueprint | Schema validation output |
| 03 | Architecture | `docs/ARCHITECTURE.md` and module graph |
| 04 | Frontend | E2E screenshots and interactions |
| 05 | Backend | Route handler tests |
| 06 | Database | Migration and read-back tests |
| 07 | Integrations | `LIVE_SANDBOX` or `BLOCKED` label |
| 08 | Security | Security test results |
| 09 | Agents & AI | Agent e2e tests |
| 10 | Testing | Test names and pass counts |
| 11 | Build & Deploy | Build output and health probe, or `BLOCKED` |
| 12 | Delivery | Manifest, ZIP hash, and evidence document |

Each increment adds one evidence row per gate to `docs/V13_3_EVIDENCE.md`.

## 10. Status taxonomy

The plan's implementation workflow uses exactly:

`NOT_STARTED | PLANNED | IN_PROGRESS | IMPLEMENTED | VERIFIED | BLOCKED | FAILED | DEFERRED`

`VERIFIED` requires executed acceptance evidence, never code inspection alone. `productionReady` must remain false when any required gate is FAIL, MISSING, or BLOCKED.

**Compatibility clarification:** the current platform blueprint and checker use the established feature-evidence statuses `VERIFIED | IMPLEMENTED_UNVERIFIED | PARTIALLY_IMPLEMENTED | MISSING | BLOCKED | FAILED | UNKNOWN | NOT_APPLICABLE`. These are not interchangeable with the workflow statuses above. Preserve the existing schema/checker during Increment 1; record increment workflow state separately rather than silently changing the canonical feature-status contract.

## 11. Security baseline

Inherited: scrypt, `HttpOnly`/`SameSite=Strict`/`Secure` and `__Host-` cookies, origin checks, rate limits, restrictive SQLite permissions, and sandboxed preview.

Increment 1 adds AES-256-GCM credential encryption, SSRF guard, secret redaction in logs/responses, and audit records for credential writes and health checks.

Deferred: MFA, distributed rate limits, managed backups, secret-rotation UI, and email verification.

## 12. Test strategy

Use built-in `node:test` only in Increment 1, preserving the dependency-free baseline. Tests belong in `tests/unit`, `tests/integration`, `tests/security`, `tests/e2e`, and `tests/failure` where those directories are introduced; existing repository tests remain in `test/`.

Mock upstream requests with `http.createServer`. Required coverage:

- Adapter error mapping for 401, 429, timeout, 5xx, and invalid JSON.
- Deterministic routing and `BLOCKED` when empty.
- Credential set → list (`hasKey: true`, no key leak) → delete.
- Production boot refusal without `GODS_SECRET_KEY`.
- Task remains `BLOCKED` without a configured provider.
- Product Discovery e2e with database read-back and audit row.
- Full regression suite.

## 13. Agent team execution protocol

For each increment: (1) Orchestrator — inventory and task graph; (2) Requirements — acceptance; (3) Architecture — layout; (4) Security — threat model; (5) Backend — implementation; (6) Database — migrations and read-back; (7) QA — tests; (8) Documentation — README/docs; (9) Code Review — block violations; (10) Verification — evidence ledger last.

Each handoff records changed files, verified items, and blockers. Code review precedes verification. The evidence document is the final implementation commit for the increment.

## 14. Delivery report template

```text
INCREMENT:    N — <name>
VERSION:      V13.3.0-increment.N
BASELINE:     V13.2.0 (preserved? yes/no + list)
FILES:        added / changed / deleted
DB:           migrations, tables, indexes
API:          routes added / changed
TESTS:        names + pass/fail counts
EVIDENCE:     link to docs/V13_3_EVIDENCE.md#increment-N
BLOCKED:      list + reason
DEFERRED:     list + reason
productionReady: false
```

## 15. Final directive

Deliver one honest increment at a time with real code, real tests, real read-back, and real evidence. Never claim the full V13.3.0 factory in one pass. Never mark `VERIFIED` without execution. Never flip `productionReady` while any gate is FAIL, MISSING, or BLOCKED.

**One platform. One blueprint. One plan. Real execution. Independent verification. Verified delivery.**
