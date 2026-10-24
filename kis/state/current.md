# State

Branch: main
Mode: Standard
Task: none in progress
Status: 1.0.0 released 2026-10-24 (MIT, tag v1.0.0 on 6f31136, CI green; branch protection: the four CI checks).
Installed on the maintainer's machine (~/.local/share/sandboxed-browser-mcp, Claude Code, Codex and pi registered,
any host).
Blocker: none
Next: support Command Code as a fourth client: an `install.sh --client cmd` registration (and its removal on
uninstall), a row in the README's Supported agents table and docs/configuration.md, and one real session against
the test stack, as was done for Claude Code, Codex and pi.

Proof (2026-10-24):
- npm test: 55 unit, 60 integration (local and CI on Node 22.4, 24, 26)
- acceptance: kis/intent/acceptance-cases.md, 41 cases passed
- one real session each in Claude Code (Sonnet 5.5), Codex (gpt-6.1-sol), pi (gpt-6.1-sol)
- from outside: README curl | bash installed v1.0.0, MCP call, check, uninstall --purge; update from older installs

Not verified: macOS and Windows hosts; the clients' interactive modes.
