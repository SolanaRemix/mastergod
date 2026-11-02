# Testing

Run the existing validation commands:

```sh
npm run check
npm test
npm run build
```

`npm run check` validates JavaScript syntax, loads the TypeScript services using Node's type stripping, parses the blueprint, checks the package/blueprint version, validates status values, and requires all 35 V12/V13 acceptance-gate entries. `npm test` runs the native Node test suite, including authentication, owner isolation, task persistence, registry matching, execution snapshot read-back, artifact/game coverage, structured Markdown rendering, project-manifest generation/read-back, provider credential encryption/redaction, SSRF policy, routing, provider error handling, and Product Discovery e2e against a mock HTTP server. `npm run build` creates a versioned archive.

The current automated suite does not prove live external provider integration, model failover, GitHub OAuth or synchronization, generated source quality, durable background execution, browser accessibility, production deployment, Web3 confirmation, billing, or all V13 acceptance scenarios. Mocked or unconfigured services are not represented as successful external tests.
