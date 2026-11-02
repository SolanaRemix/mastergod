# Testing

Run the existing validation commands:

```sh
npm run check
npm test
npm run build
```

`npm run check` validates JavaScript syntax, loads the TypeScript services using Node's type stripping, parses the blueprint, checks the package/blueprint version, validates status values, and requires 17 V12 acceptance-gate entries. `npm test` runs the native Node test suite, including authentication, owner isolation, task persistence, registry matching, execution snapshot read-back, and artifact/game coverage. `npm run build` creates a versioned archive.

The current automated suite does not prove external provider integration, generated source quality, durable background execution, browser accessibility, production deployment, Web3 confirmation, billing, or all eight V12 acceptance scenarios. Mocked or unconfigured services are not represented as successful external tests.
