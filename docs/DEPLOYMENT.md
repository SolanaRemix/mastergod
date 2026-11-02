# Deployment

The repository contains a CI workflow and a gated SSH release workflow. The production gate is deliberately closed while `gods.blueprint.yaml` reports `productionReady: false`.

No production host, deployment credentials, protected environment approval, managed database backup, or external health response is configured here. A local release archive is not a deployment. Do not mark a release deployed until the target confirms the version and a post-deploy health/read-back check succeeds.

The app currently requires Node.js 22.13 or later and uses the built-in SQLite module. Production operation additionally needs a persistent, backed-up data directory, a hardened service account, verified SSH host keys, rate limiting suitable for multiple instances, and an independently protected deployment environment.
