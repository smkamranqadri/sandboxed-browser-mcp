# Contributing

Issues and pull requests are welcome at https://github.com/smkamranqadri/sandboxed-browser-mcp.

## Setup

Node 22.4 or later, Docker with Compose.

```sh
npm ci
npm run test:unit       # no browser needed
```

The integration tests run against a separate test stack; [Testing](docs/testing.md) shows how to
create `docker/.env.test` and start it. Run `npm test` (unit and integration) before you open a pull request, and say
in it what you ran.

## Rules

- **A guard comes with a test that fails without it.** For a check that refuses or stops something (the allowlist,
  the call timeout, argument validation), break it on purpose, watch its test fail, then restore it. A test that still
  passes with the guard removed does not count.
- **Assert exact output.** Match whole messages (`/^...$/`) and exact counts, not loose substrings, so a change in
  behaviour shows up as a failing test.
- **Fictional data only.** Fixture hosts are `*.fixture.test` and `allowed.othersite.test`; names and pages are made
  up. No real sites, brands or people in tests.
- **Format only what you change.** There is no formatter config; match the surrounding code.

## Licence

By contributing you agree that your contribution is licensed under the MIT License, as the rest of the project is
(see LICENSE).
