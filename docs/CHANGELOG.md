# Changelog

## 13.2.0

- Add an owner-scoped project implementation manifest assembled from persisted requirements, tasks, agent executions, files, and build reports.
- Include evidence references, actual provider/model assignments, unknown test-run status, and explicit GitHub/provider/deployment blockers.
- Add project UI actions to view and download the manifest as JSON.
- Keep task completion distinct from feature verification and production readiness.

## 13.0.0

- Begin the V13 upgrade on the existing V12 Node.js/SQLite application; this release remains partially implemented and is not production-ready.
- Replace the artifact Markdown preview's heading/list-only substitutions with a safe structured renderer for headings, lists/checklists, tables, blockquotes, links, images, and fenced code.
- Add renderer tests for document structure, raw HTML escaping, unsafe URL rejection, and external link protections.
- Add the V13-specific acceptance gates and keep unconfigured model routing, failover, durable background execution, and GitHub synchronization explicitly blocked or missing.

## 12.0.0

- Consolidate release identity and blueprint metadata at V12.0.0.
- Record architecture, database entities, provider status, feature flags, and all 17 V12 release gates in the canonical blueprint.
- Enforce blueprint/package version agreement and gate/status validation in the existing check command.
- Include platform documentation in release archives.
- Preserve the V11 request-derived capability plan, owner-scoped persistent execution snapshot, and explicit blocked states.
- No provider, custom-agent execution, workflow runtime, Web3 transaction, billing, or production deployment capability is claimed as complete.
