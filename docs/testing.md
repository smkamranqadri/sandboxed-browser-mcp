# Testing

```sh
npm run test:unit          # view, refs, keys, the guard (its connection against a fake browser), policy.sh, signals, validation,
                           # call abandonment (a fake page): no browser
```

Integration tests spawn the built server over stdio, speak MCP to it, and drive a real Chromium. They need a *separate*
test stack (other project name and ports than the default one, so nothing collides):

```sh
( umask 077; printf 'BROWSER_PASSWORD=%s\nBROWSER_WEB_PORT=3201\nBROWSER_CDP_PORT=9422\nBROWSER_STREAM_PORT=8182\nFIXTURE_PORT=3299\n' \
  "$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" > docker/.env.test )
npm run stack:test:up
npm run test:integration
npm run stack:test:down    # down -v
```

CI runs the same on every push and pull request: the unit tests on Node 22.4, 24 and 26, the integration tests on
Node 24 (`.github/workflows/ci.yml`).

`test/integration/policy.test.mjs` drives the stack with `docker compose` itself: it writes the browser's policy through
the `policy` service, and stops the CDP relay for a few seconds to show that a page leaving while no CDP client can reach
the browser gets to a disallowed host without the policy and not with it. It leaves the policy empty again.

The view's unit tests run on aria trees the real browser gave for the fixture pages (`test/unit/fixtures/*.json`). The
integration tests cover the tools (`tools.test.mjs`), the cursor and `BROWSER_CURSOR=0` (`cursor.test.mjs`, comparing
regions of the browser's own screenshots), the fence (`guard.test.mjs`, `policy.test.mjs`), the followed tab
(`tabs.test.mjs`) and call time limits (`timeout.test.mjs`).

The test override (`docker/compose.test.yaml`) adds a fixture-site container (`test/integration/fixture-server.mjs`)
reachable from the browser as `allowed.fixture.test`, `blocked.fixture.test` and `allowed.othersite.test`. It is a
container, not a server on the host, because a host firewall (ufw's defaults here) drops traffic from containers to the
host. The tests check "did not go there" in the browser's own tab list (`/json/list`) and in what the blocked host's
server received, not in a tool's reply.

## Not verified

- Clients: on this build, one real model session each (2026-10-24, Linux) filled in a form and sent it, and was refused
  a blocked host, with the fixture showing no request to it: Claude Code (`claude -p`, Sonnet 5.5), Codex (`codex
  exec`, gpt-6.1-sol, with `default_tools_approval_mode = "approve"`) and pi (gpt-6.1-sol, `--exposure direct`).
  Longer sessions, other models and the clients' interactive modes were not tried.
- macOS / Windows hosts and Docker Desktop. Node: the tests ran here on Node 26.8 (Linux); CI covers 22.4, 24 and 26.
  Node 22.0-22.3 may work but print Node's "WebSockets are experimental" warning on stderr.
- The cursor's labels and look are checked by eye in captured frames, not by a test (they are in a closed shadow root,
  which no test can read); the tests measure where the tip is and that it is drawn.
