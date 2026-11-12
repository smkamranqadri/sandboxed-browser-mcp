# State

Branch: brigade/implement-multiple-named-browser-5b9823 (PR against main; based on the plan branch of PR #10)
Mode: Standard
Task: named browser profiles (1.2.0), plan kis/intent/plan-browser-profiles.md: implemented, awaiting the owner's review
and release. Version in package.json is still 1.1.0 on purpose.
Status: code, tests and docs done (src/profiles.ts, per-profile Session/link/guard, optional `profile` on all twelve
tools, `install.sh profile add|list|remove`, profiles.json, BROWSER_PROFILES). 1.1.0 stays the released version
(2026-10-25, tag v1.1.0); installed on the maintainer's machine: 1.1.0, untouched by this work.
Blocker: none
Next: the owner reviews, merges and releases 1.2.0; then support Command Code as a fourth client: an `install.sh --client cmd` registration (and its removal on
uninstall), a row in the README's Supported agents table and docs/configuration.md, and one real session against the
test stack, as was done for Claude Code, Codex and pi.
Owner's: upload docs/assets/social-preview.png as the repo's social preview in GitHub settings (no API for it).

Proof, profiles (2026-11-12, Linux):
- `npm test`: 153 unit, 98 integration, 0 fail (test stack + second stack `stack:test-b`). One earlier full run had
  one unrelated-looking integration failure (guard.test.mjs "once loaded", tab url empty); it passed 3 times alone and in
  the next full run, so it is treated as flaky, not explained.
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
