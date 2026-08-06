# Contributing to Dispatch

Issues and pull requests are welcome. Discuss substantial changes in an issue
before investing in an implementation.

## Development

Use the repository's pinned pnpm version:

```bash
pnpm install
pnpm typecheck
pnpm typecheck:test
pnpm test:unit
```

Run `TESTCONTAINERS_RYUK_DISABLED=true pnpm test:e2e` when the local Docker
environment cannot mount the Docker socket for Testcontainers.

Keep changes focused, add or update tests for behavioral changes, and preserve
the naming policy in `DESIGN.md` when introducing public interfaces.

## Contribution terms

By submitting a contribution, you agree that your contribution is licensed under
the Apache License 2.0, the same license that covers Dispatch. No contributor
license agreement is required.
