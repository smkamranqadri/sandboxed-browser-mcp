# State

Branch: main (local, no remote yet)
Mode: Phase
Task: release 1.0.0 (MIT) on a fresh repository history
Status: implementation accepted 2026-10-24: acceptance 41 cases (39 scripted, 34 by eye, 20/37/41 in the suite);
npm test 55 unit + 60 integration; one real session each in Claude Code, Codex and pi; install, check and update
from older installs (version string and commit) tested in an isolated HOME
Blocker: none
Next: publish on GitHub (owner's go per step), tag v1.0.0, check the install from outside

Proof (2026-10-24):
- npm test at 20d5ee1: 55/55 unit, 60/60 integration; the implementer ran it twice per change
- mutation checks: timeout recovery, BROWSER_CURSOR=0, persona signal, back with no history, bring-to-front (pair)
- clients: Claude Code (Sonnet 5.5), Codex (gpt-6.1-sol), pi (gpt-6.1-sol) filled and sent the order form and were
  refused a blocked host; the fixture saw no request to it

Not verified: macOS and Windows hosts; Node 22.4 and 24 on this build until CI runs.
