# Security

## Reporting

Open an issue at https://github.com/smkamranqadri/sandboxed-browser-mcp/issues. Say what you did, what happened, and
what you expected; a page or a command that shows it helps most. Leave out passwords, cookies and anything else from
your own browser profile.

## Supported versions

The latest release. Fixes are not backported.

## What this project does and does not protect

[docs/security.md](docs/security.md) is the threat model: what the host allowlist covers (navigations,
frames, popups and redirects, through the browser's policy, a CDP guard and a check of where each action ends up), and
what it does not (an allowed page's own sub-requests, workers, other CDP clients, DNS rebinding). A way past the
allowlist for something it says it covers is a bug worth reporting. So is a way for page content to get out of the
`<untrusted-web-content>` envelope.

Things docs/security.md lists as not covered, or as yours to set up (CDP on loopback is unauthenticated, the
container has ordinary outbound network access), are known limits, not vulnerabilities.
