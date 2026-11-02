# V13.3 Increment 1 Acceptance Mapping

**Scope:** Provider Boundary + Router + Product Discovery  
**Baseline:** V13.2.0; dependency-free Node.js 22.13+ and built-in SQLite  
**Status:** Implemented with outstanding gaps; this document maps criteria to executable evidence and does not claim production readiness.

## Acceptance criteria

| ID | Requirement | Evidence | Current result |
|---|---|---|---|
| I1-PROVIDER-01 | OpenAI-compatible requests use server-side `fetch`; no SDK or dependency is added. | `test/providers.test.js`: mock provider completion and error mapping; `package.json` dependency-free. | IMPLEMENTED_UNVERIFIED |
| I1-PROVIDER-02 | Provider health, model discovery, and completion responses are bounded and errors are sanitized. | `test/providers.test.js`: mock provider completion; `OpenAI-compatible adapter maps auth, rate-limit, server, timeout, and invalid JSON responses`. | IMPLEMENTED_UNVERIFIED |
| I1-SECURITY-01 | Private/loopback targets are denied by default; local endpoints require explicit opt-in; redirects are refused. | `SSRF endpoint policy rejects private addresses unless local-provider opt-in is explicit`. | IMPLEMENTED_UNVERIFIED; DNS resolution is checked but not pinned to the address used by `fetch`. |
| I1-SECURITY-02 | Provider credentials are encrypted at rest, owner-scoped, absent from responses, and audited on writes. | `credential APIs encrypt secrets, redact responses, enforce ownership, audit writes, and read back`; production-key negative test. | IMPLEMENTED_UNVERIFIED |
| I1-ROUTES-01 | Catalog GET returns provider identity and `hasKey` only. | Credential API integration test checks response field allowlist, redaction, and owner isolation. | IMPLEMENTED_UNVERIFIED |
| I1-ROUTES-02 | Credential PUT encrypts and reads back the new or rotated credential. | Credential API integration test checks ciphertext, rotation, and one-row uniqueness. | IMPLEMENTED_UNVERIFIED |
| I1-ROUTES-03 | Credential DELETE removes only the authenticated owner's credential. | Credential API integration test checks another account cannot delete the owner's record and verifies owner read-back. | IMPLEMENTED_UNVERIFIED |
| I1-ROUTES-04 | Health POST calls the configured provider and records health/audit evidence. | Mock Product Discovery test checks successful health response and audit read-back; blocked test checks unconfigured provider response. | IMPLEMENTED_UNVERIFIED |
| I1-ROUTES-05 | Models GET calls the configured provider and returns discovered model IDs. | Mock Product Discovery test checks model discovery; blocked test checks unconfigured provider response. | IMPLEMENTED_UNVERIFIED |
| I1-ROUTES-06 | Routing-decision GET is authenticated and project-owner scoped. | Blocked-task test checks persisted decision read-back and unauthenticated rejection. | IMPLEMENTED_UNVERIFIED |
| I1-ROUTER-01 | Routing is deterministic and persists both selected and blocked decisions. | `model router deterministically selects a configured provider and records blocked decisions`; task e2e verifies decision read-back. | IMPLEMENTED_UNVERIFIED |
| I1-ROUTER-02 | Routing considers complexity, budget, tool/JSON capability requirements, and preferred provider. | No acceptance test demonstrates this behavior; current selection is deterministic but does not implement the complete scoring contract. | MISSING |
| I1-AGENT-01 | Product Discovery runs through approval, task API, orchestrator, router, provider adapter, schema validation, SQLite read-back, audit, and redacted response. | `mock provider completes Product Discovery with validated output, usage, health, and read-back`. | IMPLEMENTED_UNVERIFIED; mock provider only. |
| I1-AGENT-02 | Product Discovery remains explicitly blocked when no eligible provider is configured. | `Product Discovery stays BLOCKED without a configured provider and persists the routing decision`. | IMPLEMENTED_UNVERIFIED |
| I1-BOOT-01 | Production startup refuses to run without `GODS_SECRET_KEY`. | `production server startup refuses to run without GODS_SECRET_KEY`. | IMPLEMENTED_UNVERIFIED |
| I1-UI-01 | Provider setup and consent are visible; Product Discovery can be invoked from the workspace. | `workspace exposes encrypted provider settings and consent details`. | IMPLEMENTED_UNVERIFIED; no browser E2E screenshot or interaction log. |
| I1-REGRESSION-01 | Existing check, test, and build commands pass. | Recorded in `docs/V13_3_EVIDENCE.md#increment-1`. | Pending final validation. |

## Important scope limits

- No real provider credentials, external provider response, or live sandbox verification are available. Mock-server success is not live integration evidence.
- The router's complete multi-factor scoring contract is not implemented.
- DNS results are checked against private ranges, but built-in `fetch` does not pin the resolved address; this residual DNS-rebinding limitation is documented in `docs/SECURITY.md`.
- Streaming is unsupported. Tool calls are not executed. Product Discovery output is marked `IMPLEMENTED_UNVERIFIED`.
- This increment does not wire the other agents, create a durable worker, or deliver a production application.

`gods.blueprint.yaml` remains version 13.2.0 with `release.productionReady: false`.
