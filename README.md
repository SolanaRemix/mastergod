# Master GODS

A dependency-free, local-first starting point for the GODS project factory. This repository did not contain an application, framework, persistence layer, or tests, so this implementation deliberately starts with a small, runnable project-planning workflow rather than claiming the full v9 production factory exists.

## Run locally

Requires Node.js 22.13 or later. No package installation is needed; the application uses Node's built-in SQLite module.

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Create an account with a password of at least 12 characters, then sign in to a private workspace. Accounts, sessions, and projects are stored transactionally in `data/gods.sqlite` (or under `GODS_DATA_DIR`). The server binds to `127.0.0.1` by default. Passwords are hashed with Node.js `scrypt`; sessions use random opaque tokens in `HttpOnly`, `SameSite=Strict` cookies and are stored by SHA-256 hash. Production mode also sets `Secure` and uses a `__Host-` cookie.

## Current workflow

1. Describe an application in ordinary language.
2. Review and edit the locally split requirement statements.
3. Approve or reject each requirement.
4. Download the persisted `gods.blueprint.yaml` for the project.
5. Inspect the task contracts. Implementation tasks remain visibly `BLOCKED` because this repository has no configured AI provider or secure worker.

Project APIs require an authenticated account and only return projects owned by that account. New accounts are regular users; matching an email address never grants administrator rights.

The browser does not call an AI service. Discovery is deterministic text splitting, not AI interpretation. Project-specific blueprints are JSON documents (a valid YAML 1.2 subset) stored with a `.yaml` extension to avoid an unverified YAML dependency. The root [`gods.blueprint.yaml`](gods.blueprint.yaml) records the current product scope and unmet release gates.

## API

- `GET /api/health` — application and integration readiness indicators.
- `POST /api/auth/register` — create an account using `{ "email": "...", "password": "..." }`.
- `POST /api/auth/login` — sign in and set a server-managed session cookie.
- `GET /api/auth/me` — read the current authenticated account.
- `POST /api/auth/logout` — revoke the current session.
- `POST /api/auth/request-password-reset` — returns `503 BLOCKED` until an email provider can securely deliver recovery links.
- `POST /api/auth/reset-password` — consumes a delivered single-use token, changes the password, and revokes existing sessions.
- `GET /api/agents` — role names and input/output contracts.
- `GET /api/projects` — local project records.
- `POST /api/projects` — create a draft from `{ "prompt": "..." }`.
- `GET /api/projects/:id` — retrieve a project.
- `POST /api/projects/:id/approve` — approve/edit each requirement.
- `GET /api/projects/:id/blueprint` — download the project blueprint.

Requests that change state require JSON and are size-limited. State-changing browser requests are checked against the request origin, login and registration have process-local rate limits, and the SQLite database is created with restrictive local permissions. Existing legacy JSON data is imported once at startup; only projects linked to an imported account are retained in the authenticated project database. Original JSON files are left untouched for backup/recovery. The password reset-token lifecycle is implemented internally, but the public recovery request returns `BLOCKED` until a real email delivery adapter is configured; no token is issued or emailed through the public route. Rate limits are not distributed, and email verification, administrator provisioning, managed database backups, and multi-factor authentication are not implemented. Do not expose this preview to an untrusted network.

## Validation

```sh
npm test
```

## Delivery status

The implemented local planning workflow, SQLite persistence, password authentication, session revocation, and per-account project isolation have focused automated coverage. The complete mission is **not production-ready**: model/provider adapters, agent execution, code generation, administrator provisioning, email verification/recovery, distributed rate limiting, managed backups, integrations, tests of generated applications, and verified deployment are not present. The authoritative baseline and blockers are listed in [`gods.blueprint.yaml`](gods.blueprint.yaml); no external connection or successful deployment is claimed.
