# State

Branch: main
Mode: Standard
Task: none in progress
Status: 1.1.0 released 2026-10-25 (tag v1.1.0 on 6aa699b, PR #4 squash-merged with the four CI checks green;
GitHub release "sandboxed-browser-mcp 1.1.0: file upload"). It adds `browser_upload` (plan
kis/intent/plan-file-upload.md, done) and the chooser catch in `browser_click`. 1.0.0: 2026-10-24, tag v1.0.0 on
6f31136. Installed on the maintainer's machine: 1.1.0 (~/.local/share/sandboxed-browser-mcp, Claude Code, Codex and pi
registered, any host); clients need a restart to load it.
Blocker: none
Next: support Command Code as a fourth client: an `install.sh --client cmd` registration (and its removal on
uninstall), a row in the README's Supported agents table and docs/configuration.md, and one real session against the
test stack, as was done for Claude Code, Codex and pi.
Owner's: upload docs/assets/social-preview.png as the repo's social preview in GitHub settings (no API for it).

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
