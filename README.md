# Master GODS V13.0.0

A dependency-free, local-first AI Studio foundation with authenticated ownership, SQLite persistence, request-derived capability plans and execution snapshots, a deterministic 2D game template, and an evidence-aware artifact file manager. Provider-backed agent execution and the full production software factory are not configured.

## Run locally

Requires Node.js 22.13 or later. No package installation is needed; the application uses Node's built-in SQLite module.

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Create an account with a password of at least 12 characters, then sign in to a private workspace. Accounts, sessions, projects, and generated project artifacts are stored transactionally in `data/gods.sqlite` (or under `GODS_DATA_DIR`). The server binds to `127.0.0.1` by default. Passwords are hashed with Node.js `scrypt`; sessions use random opaque tokens in `HttpOnly`, `SameSite=Strict` cookies and are stored by SHA-256 hash. Production mode also sets `Secure` and uses a `__Host-` cookie.

## Current workflow

1. Describe an application in ordinary language.
2. Review and edit the locally split requirement statements.
3. Approve or reject each requirement.
4. Download the persisted `gods.blueprint.yaml` for the project.
5. Generate a request-derived capability team and task graph. The original request, selected agents, gaps, and graph are persisted together. Twenty deterministic local specialist handlers are registered and can be run on an approved project; provider-dependent capabilities remain `BLOCKED`.
6. Run a local code-generation task to create editable HTML/CSS/JavaScript prototype files, then use the artifact manager to edit, version, upload, download, preview saved HTML, or import/export text-only project ZIPs. These local handlers do not call AI models and the prototype does not provide production backend, authentication, or database features.
7. Run a bounded static build check for source syntax and file structure. It does not install dependencies, compile, or execute arbitrary project code.

Project APIs require an authenticated account and only return projects owned by that account. New accounts are regular users; matching an email address never grants administrator rights.

### Project artifact file manager

`ProjectGenerator` validates that a saved, approved blueprint exactly matches its approved requirements, discovers capabilities from approved requirement text, selects matching catalog entries, reports missing or undeployed capabilities, and persists the execution snapshot with its task graph. Twenty deterministic local specialists are registered with bounded handlers and persisted execution records; an approved project's eligible task can run through the orchestrator or a direct specialist endpoint. These are local rule-based workers, not provider-backed AI agents. The capability registry supports validated in-process specialist descriptors; it is not a persistent agent marketplace or autonomous agent factory.

The file manager supports read, create, edit, copy, rename, delete, download, folder operations, version history, restore, upload of bounded UTF-8 files, and verified text-only ZIP import/export. Imports reject unsafe paths, secrets, binary files, oversize entries, and conflicts rather than overwriting. Writes use optimistic version checks and are read back from SQLite before success is returned. The endpoints are owner-scoped under `/api/projects/:id/artifacts`; state-changing requests require same-origin JSON. Saved HTML can be previewed in a network-restricted sandbox. Persistent static checks report supported syntax and structure findings without executing project code. These capabilities are not a general-purpose IDE or isolated production build pipeline.

Markdown artifacts have an editable source and live preview supporting headings, paragraphs, nested lists/checklists, tables, blockquotes, inline emphasis/code, safe links, HTTPS images, and fenced code. Raw HTML is escaped. This is not a full CommonMark implementation and does not provide syntax highlighting, math/Mermaid execution, or AI-response code actions.

### UI design system

The existing builder, requirement review, project and game cards, task panels, and artifact editor share dark glass/neon design tokens and the `FlashGlowCard` DOM helper. Its CSS variants are purple, orange, red, green, yellow, cyan, blue, and `rainbow-subtle`; animation and blur are optional and reduced-motion is respected. This is a skin for the actual single-page app, not an implementation of absent chat, model, provider, billing, community, or asset-studio pages.

### Provision the super administrator

After the intended account has been created and its email identity has been independently verified by the operator, run `npm run provision-admin` in an interactive terminal on the host. The command accepts only `GODS_SUPER_ADMIN_EMAIL` (defaults to `gxqstudio@gmail.com`), asks for the account password without echoing it, verifies that password against the stored scrypt hash, and performs a conditional server-side role update. Never put passwords in command arguments or grant admin based on an email string alone. `GET /api/admin/summary` is available only to a currently authenticated, provisioned administrator. Email identity verification is an operator procedure, not an implemented email integration.

The browser does not call an AI service. Requirement extraction and capability matching use deterministic text rules, not model-based interpretation. Project-specific blueprints are JSON documents (a valid YAML 1.2 subset) stored with a `.yaml` extension to avoid an unverified YAML dependency. The root [`gods.blueprint.yaml`](gods.blueprint.yaml) records the current product scope and unmet release gates.

## Platform documentation

- [Architecture](docs/ARCHITECTURE.md) and [implementation status](docs/IMPLEMENTATION_PLAN.md)
- [API reference](docs/API_REFERENCE.md), [agent system](docs/AGENT_SYSTEM.md), and [provider boundaries](docs/PROVIDER_INTEGRATIONS.md)
- [Security](docs/SECURITY.md), [database](docs/DATABASE.md), and [deployment](docs/DEPLOYMENT.md)
- [Testing](docs/TESTING.md), [changelog](docs/CHANGELOG.md), and [V12 release status](docs/RELEASE_V12.md)
- [V13 implementation and release gates](docs/RELEASE_V13.md)

## API

- `GET /api/health` — application and integration readiness indicators.
- `POST /api/auth/register` — create an account using `{ "email": "...", "password": "..." }`.
- `POST /api/auth/login` — sign in and set a server-managed session cookie.
- `GET /api/auth/me` — read the current authenticated account.
- `POST /api/auth/logout` — revoke the current session.
- `POST /api/auth/request-password-reset` — returns `503 BLOCKED` until an email provider can securely deliver recovery links.
- `POST /api/auth/reset-password` — consumes a delivered single-use token, changes the password, and revokes existing sessions.
- `GET /api/admin/summary` — operator-provisioned administrators only.
- `GET /api/agents` — capability descriptors, contracts, and honest availability/deployment status.
- `GET /api/projects` — local project records.
- `POST /api/projects` — create a draft from `{ "prompt": "..." }`.
- `GET /api/projects/:id` — retrieve a project.
- `POST /api/projects/:id/approve` — approve/edit each requirement.
- `GET /api/projects/:id/blueprint` — download the project blueprint.
- `POST /api/projects/:id/generate` — validate an approved blueprint and persist its deterministic agent task graph; eligible local workers can execute assigned tasks and write prototype artifacts.
- `GET /api/projects/:id/execution` — read the persisted, owner-scoped request/team/capability-gap/task-graph snapshot.
- `GET /api/projects/:id/tasks` — list persisted, owner-scoped task records.
- `GET /api/projects/:id/tasks/:taskId/events` — read a task's persisted state-transition history.
- `POST /api/projects/:id/tasks/:taskId/run` — execute a registered task handler; unavailable workers remain `BLOCKED`.
- `POST /api/projects/:id/agents/:agentId/execute` — execute one of the 20 registered local specialists on an approved project and persist its result; provider-dependent tasks report `BLOCKED`.
- `POST /api/projects/:id/artifacts/generate` — retired static generator (`410 BLOCKED`); use the file manager for explicit user-managed artifacts.
- `GET /api/projects/:id/artifacts` — list owned files and folders.
- `GET|PUT|DELETE /api/projects/:id/artifacts/file?path=...` — read, save with `expectedVersion`, download with `download=1`, or delete with the current `version`.
- `POST /api/projects/:id/artifacts/files` — create a file.
- `POST /api/projects/:id/artifacts/rename` — rename a file with its current version or a folder with `{ "kind": "directory" }`.
- `POST /api/projects/:id/artifacts/duplicate` — copy an owned file.
- `POST|PATCH|DELETE /api/projects/:id/artifacts/directories` — create, rename, or recursively delete a folder.
- `GET /api/projects/:id/artifacts/history?path=...` and `POST /api/projects/:id/artifacts/restore` — inspect history and restore a prior version as a new version.
- `GET /api/projects/:id/artifacts/audit` — read recent artifact activity.
- `GET /api/projects/:id/artifacts/export` — download a size-limited JSON project export.
- `GET /api/projects/:id/artifacts/zip` and `POST /api/projects/:id/artifacts/zip-import` — export or import a verified text-only ZIP archive; import never overwrites existing paths.
- `POST /api/projects/:id/build` and `GET /api/projects/:id/builds` — run and read bounded static syntax/structure checks; project code is not executed.
- `GET /api/projects/:id/preview?entry=...` — preview saved HTML in a sandbox that blocks network access.
- `GET /api/games` — list private game projects owned by the signed-in user.
- `POST /api/games` — create a private 2D game from `{ "prompt": "..." }`.
- `GET /api/games/:id` — retrieve the game specification and version history.
- `GET /api/games/:id/preview?version=1` — load an owned game version in the restricted preview.
- `POST /api/games/:id/refine` — create a new supported difficulty version.
- `POST /api/games/:id/rollback` — restore an earlier design as a new version.
- `GET|POST /api/games/:id/save` — read or save validated local game progress.

Requests that change state require JSON and are size-limited. State-changing browser requests are checked against the request origin, login and registration have process-local rate limits, and the SQLite database is created with restrictive local permissions. Existing legacy JSON data is imported once at startup; only projects linked to an imported account are retained in the authenticated project database. Original JSON files are left untouched for backup/recovery. The password reset-token lifecycle is implemented internally, but the public recovery request returns `BLOCKED` until a real email delivery adapter is configured; no token is issued or emailed through the public route. Rate limits are not distributed, and email verification, administrator provisioning, managed database backups, and multi-factor authentication are not implemented. Do not expose this preview to an untrusted network.

## Validation

```sh
npm run check
npm test
npm run build
```

`npm run build` creates a `.tar.gz` release under `dist/`; it includes only the explicitly selected runtime files and never includes local SQLite data, test data, or GitHub credentials.

## CI and gated deployment

[`ci-cd.yml`](.github/workflows/ci-cd.yml) runs on pull requests and pushes to `main`. It checks JavaScript syntax and the project blueprint, then runs the full native Node.js test suite on Node 22.13 and Node 24. A release artifact is packaged only after both runtime checks pass and is retained for seven days. GitHub Actions are pinned to reviewed commit SHAs.

Production deployment is deliberately separate from ordinary CI: dispatch this workflow from `main`, explicitly select `deploy_production`, and configure a protected GitHub `production` environment with reviewer approval. Configure these environment secrets before a run:

- `GODS_DEPLOY_HOST`, `GODS_DEPLOY_USER`, and `GODS_DEPLOY_KEY` for the deployment SSH target.
- `GODS_DEPLOY_KNOWN_HOSTS` containing the independently verified SSH host key (do not learn a key during the deployment).
- `GODS_DEPLOY_PATH` for an absolute, shell-safe release directory, for example `/srv/gods`.
- `GODS_DEPLOY_HEALTH_URL` for the public HTTPS `/api/health` endpoint.

The host must have `tar`, `sudo systemctl`, and a preconfigured `gods.service` that runs the app from `<GODS_DEPLOY_PATH>/current`, uses a persistent `GODS_DATA_DIR` outside the release directories, and permits the deploy user to restart/stop only that service. Configure the service and its least-privilege sudo rule out of band. The HTTPS endpoint must be reachable from the GitHub runner. The deploy script validates configuration, extracts the already-tested artifact, switches the release symlink, restarts the service, and verifies the health JSON. It restores the prior release (or stops the service if there is no prior release) when service restart or health verification fails.

Deployment is refused unless `gods.blueprint.yaml` marks all production gates ready, and the post-deploy health response must report `productionReady: true`. This repository currently reports `productionReady: false`; no production host, credentials, protected environment approval, or live deployment is configured. Therefore the CI pipeline can verify and package this branch, but production delivery is **BLOCKED**. A workflow configuration or HTTP 200 response alone is not represented as a successful production deployment.

## GODS AI Game Studio (first vertical slice)

Signed-in users can create an original 2D, single-player Canvas collection game, inspect a deterministic game plan, run it in a sandboxed preview, restart it, save/load validated progress, adjust supported difficulty settings, and restore an earlier version without overwriting history. Game specifications, source versions, and saves are stored in SQLite with account ownership checks; the preview has an opaque sandbox origin and a restrictive Content Security Policy that blocks network access.

This is a deterministic starter template, **not AI generation**. Its accepted edits are limited to difficulty. The current slice does not provide provider-backed agents, 3D, generated artwork/audio, arbitrary code execution/upload, player accounts, scores/leaderboards, achievements, multiplayer, public discovery, publishing, Remix integration, or monetization. Requests that exceed the template's capabilities are reported rather than silently claimed as implemented. Game status remains `IMPLEMENTED_UNVERIFIED` until the broader runtime, security, and release evidence is in place.

## Delivery status

The local planning workflow, SQLite persistence, password authentication, project ownership, game-project versioning/save access, sandbox preview response, explicit super-admin provisioning, deployment preflight, and admin-only summary route have focused automated coverage. The complete mission is **not production-ready**: model/provider agents, broad game generation and real media providers, online platform services, automated email verification/recovery, distributed rate limiting, managed backups, integrations, full generated-game QA, and a production target are not present. The authoritative status and blockers are listed in [`gods.blueprint.yaml`](gods.blueprint.yaml); no external connection or successful deployment is claimed.
