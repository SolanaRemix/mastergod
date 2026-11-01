# Master GODS

A dependency-free, local-first starting point for the GODS project factory. This repository did not contain an application, framework, persistence layer, or tests, so this implementation deliberately starts with a small, runnable project-planning workflow rather than claiming the full v9 production factory exists.

## Run locally

Requires Node.js 20 or later. No package installation is needed.

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Project records and blueprints are written under `data/` (or `GODS_DATA_DIR` if set). The server binds to `127.0.0.1` by default. Keep it on a trusted local machine: this preview does not implement user authentication or multi-user access control.

## Current workflow

1. Describe an application in ordinary language.
2. Review and edit the locally split requirement statements.
3. Approve or reject each requirement.
4. Download the persisted `gods.blueprint.yaml` for the project.
5. Inspect the task contracts. Implementation tasks remain visibly `BLOCKED` because this repository has no configured AI provider or secure worker.

The browser does not call an AI service. Discovery is deterministic text splitting, not AI interpretation. Project-specific blueprints are JSON documents (a valid YAML 1.2 subset) stored with a `.yaml` extension to avoid an unverified YAML dependency. The root [`gods.blueprint.yaml`](gods.blueprint.yaml) records the current product scope and unmet release gates.

## API

- `GET /api/health` — application and integration readiness indicators.
- `GET /api/agents` — role names and input/output contracts.
- `GET /api/projects` — local project records.
- `POST /api/projects` — create a draft from `{ "prompt": "..." }`.
- `GET /api/projects/:id` — retrieve a project.
- `POST /api/projects/:id/approve` — approve/edit each requirement.
- `GET /api/projects/:id/blueprint` — download the project blueprint.

Requests that change state require JSON and are size-limited. Project storage uses restrictive local file permissions. There is no authentication, CSRF/session system, database, rate limiting, or tenant isolation; do not expose this preview to an untrusted network.

## Validation

```sh
npm test
```

## Delivery status

The implemented local planning workflow and project persistence have focused automated coverage. The complete mission is **not production-ready**: model/provider adapters, agent execution, code generation, authentication/authorization, database migrations, integrations, tests of generated applications, and verified deployment are not present. The authoritative baseline and blockers are listed in [`gods.blueprint.yaml`](gods.blueprint.yaml); no external connection or successful deployment is claimed.
