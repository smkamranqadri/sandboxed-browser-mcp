# State

Branch: main
Stamp: main 610b8a6 b286ff61a770
Mode: Standard
Task: expose the running `facebook` profile to the active agent for a Facebook draft.
Status: installed server is configured with `default` and `facebook`; both browser profiles are running. The global
Codex MCP entry `browser` has no `BROWSER_PROFILES` filter. The active agent has not reloaded the MCP process.
Blocker: the active Codex session still has a stale MCP connection; refreshing the status view did not restart it.
Next: fully restart Codex so the MCP server reloads `profiles.json`, then call the browser tools with `profile: "facebook"`.

Install proof (2026-11-16): `install.sh check` reports up to date (1.2.0, 610b8a639e0d); `codex mcp get browser` shows the enabled stdio entry pointing to `dist/server.js`; `docker compose ps` shows the browser and both relays up; CDP at `127.0.0.1:9322/json/version` returns Chrome/155.0.8059.79.
Profile proof (2026-11-16): `install.sh profile list` shows `facebook` running (desktop 3102, CDP 9323, stream 8083); CDP at `127.0.0.1:9323/json/version` returns Chrome/155.0.8059.79.
MCP availability proof (2026-11-16): installed `profiles.json` contains `default` and `facebook`; `codex mcp get browser` shows an enabled stdio entry with no environment filter. `src/server.ts` loads profile names at process startup.
Owner's: upload docs/assets/social-preview.png as the repo's social preview in GitHub settings (no API for it).

Proof, profiles (2026-11-12, Linux):
- `npm test`: 161 unit, 98 integration, 0 fail (test stack + second stack `stack:test-b`). One earlier full run had
  one integration failure (guard.test.mjs "once loaded", tab url empty); it did not repeat. Likely cause: /json/list read
  right after the page was put back (the test now waits for the settled address); not proven, and the test stack was
  possibly shared with another worktree.
- Real client session (2026-11-12, Linux): Claude Code 2.1.322 with Sonnet 5.5 (`claude -p`, MCP config naming
  dist/server.js and a temp profiles.json with `default` = test stack CDP 9422, any host, and `other` = test-b stack
  CDP 9423, hosts allowed.fixture.test). Only the test stacks; not the installed copy. Observed in the tool log: the
  model passed `profile` itself; cookie set in default was `seed=alpha` there and `none` in other; refs of other were
  `[f3e5@other]`, default's plain `[f4e5]`; default's `f4e14` used with other was refused ("has no profile tag, so it
  is a ref of the default profile…"), `f3e14@other` used with default was refused ("is a ref of profile other…"); the
  same ref worked in its own profile; `blocked.fixture.test/secret` opened in default and was refused in other
  ("not an allowed host (BROWSER_ALLOWED_HOSTS: allowed.fixture.test)"). A second session with a single-profile
  client (no profiles.json, BROWSER_CDP_URL) saw plain refs (`[f1e14]`) and its click worked. Not checked: Codex or
  pi sessions with two profiles; a fenced non-default profile's Chromium policy; macOS and Windows. The model first
  called the fence gap on default "a gap"; that is by design (default had no hosts list).
- Review fixes (2026-11-12): profiles.json path with fileURLToPath (space/non-ASCII install dir); refs carry the profile
  tag when a client has several profiles; a client entry's BROWSER_ALLOWED_HOSTS that differs from profiles.json is a
  failure to start; kept volumes are recorded (.kept-profiles) and purged; `test-*` reserved; duplicate cdpPort
  refused; installer tests for update, name check, purge. 14 + 8 + 3 more mutants, caught. The plan was corrected: no
  `uninstall --profile`, and BROWSER_PROFILES is set by hand in the client entry.
- Mutation checks: 7 + 14 + 13 mutants of profiles.ts, tools.ts, navguard.ts, connection.ts, schema.ts, server.ts and
  install.sh, each caught by a named test; two survivors in install.sh were tightened and then caught; every file
  restored byte-identical (git diff clean).
- Real run of install.sh on /tmp/sbm-dev (compose project sbm-dev, other ports, never the installed copy): an install
  made by 1.1.0's script was updated by the new one; a cookie set before survived `update` and a forced container
  recreation; `profile add` x2, `list`, `remove` (volume kept), `remove --purge`, `uninstall --purge` (refused without
  --yes with 2 profiles), then removed; the server in that folder refused a host on the work profile's list.
- From inside a profile's container, other stacks' published ports and containers did not answer.
Not verified: a real client session (Claude Code, Codex, pi) using two profiles; a plan review by a second CLI; macOS/
Windows; the Chromium policy of a non-default profile under a fence (only the server's guard was exercised there).

Proof, 1.1.0 (2026-10-25):
- CI on PR #4 (057b837): unit on Node 22.4, 24, 26 and integration, all pass; the merged tree equals the verified
  branch tree
- local, on the branch head: timeout 900 npm test 126 unit, 89 integration; mutation checks of every new guard
- reviews by a second model (Codex gpt-6.1-sol): the plan (2 rounds) and the branch (7 findings fixed, re-checked)
- one real Claude Code session (Sonnet 5.5) uploaded a fixture file through the tools, SHA-256 matching the host
- from outside: `install.sh update` installed v1.1.0 (`check`: up to date, 6aa699ba3c26) without restarting the
  browser container; the installed server lists 12 tools over MCP, browser_upload last

Proof (2026-10-24, 1.0.0):
- npm test: 55 unit, 60 integration (local and CI on Node 22.4, 24, 26)
- acceptance: kis/intent/acceptance-cases.md, 41 cases passed
- one real session each in Claude Code (Sonnet 5.5), Codex (gpt-6.1-sol), pi (gpt-6.1-sol)
- from outside: README curl | bash installed v1.0.0, MCP call, check, uninstall --purge; update from older installs

Not verified: macOS and Windows hosts (uploads are refused there by design); the clients' interactive modes; a real
session with uploads in Codex or pi.
