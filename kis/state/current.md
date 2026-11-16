# State

Branch: main
Stamp: main 3ec2914 53ccd708986e
Mode: Standard
Task: release and push macOS support for `browser_upload` after KIS synchronization and review.
Status: code, tests, docs, KIS plan and knowledge are updated. Local macOS unit suite passed 165/165 (upload suite 27/27); Linux Node 24 unit suite passed 165/165 and integration passed 98/98. GitHub-hosted CI has not run remotely.
Blocker: none.
Next: commit the verified change, inspect the project release process, create a release commit, then push. Facebook editor currently shows eight attached photos; Save as draft was clicked, but the UI remained in Saving with a publish prompt. Nothing was published; save completion is unconfirmed.

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

Not verified: Windows upload refusal in a Windows runtime; the clients' interactive modes; a real session with uploads in Codex or pi.

Upload attempt proof (2026-11-16): Facebook edit draft observed in profile `facebook`; the eight source JPEGs exist in Downloads (about 22 MiB total). Upload call on the Downloads paths and a second call using temporary home-folder copies both returned `Upload refused for files[0] (unreadable)`. `src/upload.ts` resolves the open handle via `/proc/self/fd`; `docs/security.md` documents Linux-only uploads. Temporary copies were removed.

Linux proof (2026-11-16, Node 24.22.3): `npm run test:unit` passed 165/165; with disposable test stacks, `npm run test:integration` passed 98/98. Both stacks were stopped with `down -v`; generated `docker/.env.test*` files were removed.

Facebook check (2026-11-16): editor showed 8 uploaded media tiles and collage preview. Clicked `Save as draft`; Facebook stayed in `Saving` with an event prompt offering `Publish Original Post`. That option was not selected; draft save completion is unconfirmed.
macOS proof (2026-11-16): `npm run test:unit` passed 165/165; focused `test/unit/upload.test.mjs` passed 27/27. `git diff --check` passed. Linux proof is recorded above.
