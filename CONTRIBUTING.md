# Contributing

Thanks for helping improve `@fin-integrity/node`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup → dist/ (ESM + CJS + d.ts)
```

## Ground rules

- **The SDK must never throw into or block the caller's money path.** Any new capture path goes through `try/catch → onError`. Add a test proving it fails open.
- **No new runtime dependencies** without discussion — keep the bundle tiny. `stripe` stays an optional peer dependency.
- Money is always integer minor units + ISO-4217. Never introduce floats or decimal strings on the wire.
- Keep the public API stable and typed; changes to the event envelope must be additive and bump `schema_version` only on a breaking change.

## Pull requests

- Add/adjust tests in `test/`.
- Run `npm run typecheck && npm test && npm run build` before opening a PR.
- Describe the change and its effect on the wire format, if any.

## Reporting security issues

Please do not open public issues for vulnerabilities. Email the maintainers instead.
