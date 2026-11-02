# Security

## Existing controls

- Passwords use Node.js `scrypt`; sessions use opaque random tokens stored by hash.
- Project and game mutations require authenticated ownership; project writes apply same-origin checks.
- SQLite queries use prepared statements and project artifacts use version checks and audit events.
- Provider settings require an authenticated owner session, same-origin JSON mutations, rate limiting, and owner-scoped SQLite rows.
- Provider API keys are encrypted with AES-256-GCM using a 32-byte `GODS_SECRET_KEY`; production startup refuses a missing or invalid key. Keys are not returned, logged, or placed in artifacts.
- Provider endpoint validation rejects credential-bearing URLs, non-HTTPS endpoints by default, DNS results in private/loopback ranges, and redirects. Local/private endpoints require explicit server-side `GODS_ALLOW_LOCAL_PROVIDER=1`.
- Provider requests are bounded by timeout, a 1 MiB response limit, and at most three retries. Persisted error/audit data contains sanitized error codes rather than upstream response bodies.
- Game previews use a restricted iframe sandbox and a restrictive content security policy.
- Production readiness remains false in the canonical blueprint.

## Boundaries and gaps

There is no multi-tenant organization/RBAC system, production secret manager, isolated agent/code execution environment, wallet integration, payment processing, or distributed rate limiting. The provider endpoint DNS preflight does not pin the resolved address used internally by Node's `fetch`; only configure trusted endpoints and keep local-provider opt-in disabled on untrusted deployments. Provider credentials and live external service verification are not configured in this repository.

Prompts, project files, provider outputs, and future tool results must be treated as untrusted. Product Discovery validates provider JSON against a schema but does not independently verify factual accuracy. Do not grant a catalog entry runtime permissions based on its description. Sensitive operations, external calls, financial transactions, and production deployment require explicit authorization, least privilege, audit records, and independent verification.

Security status is partial and does not constitute a production security review.
