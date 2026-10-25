# Plan: file upload

Let the agent attach a file from the host to a page's file input. Scope approved by the owner 2026-10-25, revised the
same day after the plan review below. Status lives in `kis/state/current.md`. How uploads reach a remote browser, and
why the native dialog cannot be used, is in `kis/knowledge/project.md` (Known limits).

Status: all tasks done on branch upload-impl (abdb38f), verified 2026-10-25; merge is the owner's (see State).

## Decisions (owner, 2026-10-25)

- A new, 12th tool `browser_upload { ref: string, files: string[] }`, both required, always listed, last in the list.
  The other eleven tools keep their names, arguments and defaults.
- `files` are host paths: absolute, or starting with `~/`. **Only regular files inside the server's own home** are
  allowed (its home, canonical and as given), minus the denylist below. Everything else on the host (`/proc`, `/sys`,
  `/dev`, `/run`, `/etc`, `/tmp`, other users' homes, mounted drives) is refused. No upload folder, no on/off switch, no
  installer change.
- `browser_click` on something that opens a file chooser: the chooser is caught on the followed page only during the
  agent's own click (a bounded window), so no native dialog opens, and the click answers that this ref opens a file
  chooser and to use `browser_upload` on it.

## Paths

Resolution, in this order, before anything touches the page:

1. `files` must be a non-empty array of non-empty strings (else one argument error, before any file or browser work).
2. Each entry: `~/` is expanded to the server's home; any other relative form (`~user`, `./x`, `x`) is refused.
   The absolute result is normalised lexically (`..` resolved) and kept; then its canonical path (`realpath`) is taken.
3. Home roots: the lexical home and its canonical path (the home itself may be a symlink). Both the lexical and the
   canonical file path must lie inside a home root, compared by whole path components (`/home/me2` is not inside
   `/home/me`).
4. Denylist, matched on whole components of the path relative to the home root, for both the lexical and the
   canonical path (case-sensitive, as on Linux; the extension rules below ignore case):
   - directories: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gcloud`, `.config/gh`,
     `.config/containers`, `.password-store`, `.local/share/keyrings`, `.mozilla`, `.config/google-chrome`,
     `.config/chromium`, `.config/BraveSoftware`, `.claude`, `.codex`, `.local/share/sandboxed-browser-mcp`
   - files: `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.bash_history`, `.zsh_history`, `.python_history`,
     `.node_repl_history`, `.psql_history`, `.mysql_history`, `.lesshst`, `.config/fish/fish_history`
   - any file named `.env` or `.env.*`; any `*.pem`, `*.key`, `*.p12`, `*.pfx`; SSH private keys by name: `id_rsa`,
     `id_dsa`, `id_ecdsa`, `id_ed25519`, `id_ecdsa_sk`, `id_ed25519_sk` (exactly; a `.pub` suffix is the public key and
     allowed). `id_card.pdf` is allowed. The certificate and `.key` rules also refuse public bundles and Keynote files:
     a stated cost.
   A component that only looks like one (`.ssh-notes`) is not refused.
5. The approved identity is taken right after the checks in 3 and 4: an `lstat` of the canonical path, which must be
   a regular file (a folder, socket, FIFO or device is refused here, before any open). Then the file is opened
   read-only with `O_NOFOLLOW | O_NONBLOCK` (Linux), so a FIFO swapped in afterwards cannot block the open. On the
   handle: `fstat` again a regular file, link count 1 (more than one hard link is refused: a hard link to a denied
   file is otherwise invisible), and the same device and inode as the approved `lstat`. Then the handle's real
   location (`readlink /proc/self/fd/<n>`) goes through the checks in 3 and 4 again, so a parent folder swapped for
   a symlink between the check and the open (which `O_NOFOLLOW` does not stop) is refused.
6. Bytes are read through that handle. The read length must equal the handle's `fstat` size (a file that grew or
   shrank meanwhile is refused), and the total across all files must be **under 52,428,800 bytes per call**
   (Playwright's limit for a remote browser, `>=` refused), checked on the bytes actually read. Handles close on every
   outcome.
7. Playwright gets public payloads (`name` = basename, `mimeType`, `buffer`), never a path to reopen. The source
   file's modification time is not passed on (the public payload has no field for it).

Each refusal has its own short answer with fixed server wording and a fixed rule name (relative path, missing,
outside home, denied location, hard link, not a regular file, unreadable, too large, changed while reading), never
file contents. Trusted refusals (`ToolError`, which skips the envelope and the signal scan) carry no path, basename,
page label or raw library error: the argument's position (`files[2]`) identifies the file. Anything quoting a path goes
through the untrusted envelope. Residual risk, for `docs/security.md`: a secret in an ordinary file (a token in
`~/notes.txt`) or at a custom path is not recognised; a file rewritten in place, keeping its size, during the read is
not detected; the denylist is a filter, not a wall; and the bytes reach page scripts, which may send them to any host
(sub-resources are not fenced).

## The tool

- Dispatch, decided by inspecting the resolved ref in its own document or shadow root, before any action:
  - a file input, or a label whose control is a file input: `setInputFiles(payloads)` on it directly. A
    `webkitdirectory` input is refused. Two or more files on an input without `multiple` are refused and the input
    keeps what it had.
  - anything else: arm chooser capture on the followed page, click once, wait a bounded window (about 2 s) for a
    chooser, then `chooser.setFiles(payloads)` on that chooser (its own `isMultiple()` decides two-or-more), never a
    second lookup or click. No chooser in the window: the answer says the element opened no file chooser. Clicking an
    arbitrary control can run its handler even then; the description says to point the tool at the upload control.
  - capture covers the followed page only. If no chooser came there and the click opened a new tab, the answer says
    no chooser was caught on this page, upload capture does not reach the new tab, and no files were assigned (it
    does not claim to have seen a chooser in that tab).
- Before sending bytes, the captured chooser's page is checked against the allowlist; after, the normal tab checks run.
- The action runs through the same machinery as the others (`Session.perform`, `Session.acting()`, the last-seen diff
  state), so the answer is like click's: each file attached with its full resolved path and size, then what changed
  (or the new page or tab). Path-bearing success answers stay inside the untrusted envelope; Playwright errors too.
- The cursor shows `Upload · <element name>`, and nothing when `BROWSER_CURSOR=0`.
- Abandonment: `stillWanted()` before each browser step and after each filesystem or capture await. The chooser
  listener is call-owned: armed just before the one click, removed on every exit, including abandonment; a rejected
  wait is handled. No `setFiles` starts after abandonment.
- Teardown barrier: removing a Playwright listener only starts an asynchronous protocol update, so the call (or, after
  abandonment, the queue before the next call starts) awaits a confirmed disable of
  `Page.setInterceptFileChooserDialog` on the followed page and its frame sessions before anything may assume
  interception is off. The mechanism is the implementer's; the test holds the disable and shows nothing proceeds on
  that assumption until it is released.
- `instructions(defs)` mentions uploads in one clause.

## browser_click and choosers

The same bounded capture, armed before the click and removed on every exit. A caught chooser is not given files (no
`setFiles([])`, so an earlier selection stays) and the answer names the ref and `browser_upload`. The guarantee is
stated as: interception on the followed page during the agent's click; a person's or a script's chooser at that same
moment may be caught too, and choosers opened outside the window (by `browser_key` Enter/Space, a script, a person)
keep the native dialog.

## Out of scope

Installer changes; an upload folder or switch; files outside home; downloads; folder upload; drop zones that open no
chooser; choosers in other tabs or popups; fixing the container's native file dialog for picking by hand; tagging or
releasing (1.1.0 is the owner's call).

## Tasks

- [x] 1. Schema and validator: an array-of-strings field type in `src/schema.ts` (`items`, `minItems: 1`) and its check
  in `src/validate.ts`, existing scalar messages unchanged. Unit tests; the tool-list tests check `items` and
  `minItems`; one call through the real MCP request handler with a valid array.
- [x] 2. `src/upload.ts`: the path rules above, producing payloads. Unit tests over a temp fictional home: each rule
  with a paired allow/refuse case (`..`, `/home/me2` lookalike, `.ssh-notes`, symlinked home, symlinks into and out of a
  denied tree, `id_ed25519` vs `id_ed25519.pub` vs `id_card.pdf`, `.env.local`, a hard link, a FIFO with no writer, a
  folder), the size cap at limit minus one, exactly the limit, limit plus one and two files summing to it (sparse
  files, mocked sizes), and, with barriers between check and open and between open and read: the final file replaced,
  a parent folder swapped for a symlink into `.aws`, a regular file swapped for a FIFO (each refused promptly, well
  inside the call limit), and growth and shrinking. No real secrets or the server's own environment as fixtures.
- [x] 3. Chooser capture, teardown and abandonment: the call-owned capture used by `browser_click` and
  `browser_upload`, with the teardown barrier, and tests: abandonment during path preparation, ref lookup, click and
  chooser wait (no later `setFiles`, no second click, no leaked listener, the next call works); the disable held, on
  normal completion, click failure and abandonment; delayed and double-click choosers.
- [x] 4. `browser_upload` in `src/tools.ts` (dispatch, answers, cursor, description) and `browser_click`'s chooser
  answer. 11 becomes 12 in `test/unit/guard.test.mjs` and `test/integration/tools.test.mjs`.
- [x] 5. Fixture pages (`test/integration/fixture-server.mjs`): visible input, label, button clicking a hidden input,
  an input created on click, `multiple`, `webkitdirectory`, a drop zone with no chooser, a delayed chooser, a chooser
  in a same-origin frame and in a cross-site frame (OOPIF), a popup that opens a chooser, a shadow-DOM input, an
  upload that navigates and one that opens a tab. Each page shows each received file's name, size and SHA-256.
- [x] 6. Docs: `kis/intent/spec-browser-tools.md` (interface table, an upload section, click's chooser answer),
  `kis/intent/acceptance-cases.md`, README (twelve tools, What you get), `docs/how-it-works.md`, `docs/security.md`
  (uploads read host files under home, the denylist and its residual risks), `docs/configuration.md` (pi line),
  `CHANGELOG.md` (Unreleased), `package.json` description, `src/tools.ts` header comment.

## Acceptance checks

1. `tools/list` returns twelve tools, `browser_upload` last: `ref` string and `files` array of strings with
   `minItems: 1`, both required, not read-only. `files: []`, `files: "x"` and `files: [1]` fail validation.
2. One small fixture file uploaded to each fixture kind (visible, label, button, created on click, delayed, frames,
   shadow DOM) answers with its full path and size; the page shows exactly one file with the same name, size and the
   SHA-256 that `sha256sum` gives on the host.
3. `multiple` takes two files (both hashes match); a single input given two answers that it takes one and keeps its
   earlier file; `webkitdirectory` is refused.
4. Every refusal class in Paths answers its own message, with the page and the input unchanged, and no click made
   (a click counter on the fixture page).
5. A drop zone with no chooser answers that it opened none, after exactly one click; a button that opens a popup
   answers that capture does not reach the new tab and no files were assigned, and the popup's input has none.
6. `browser_click` on the chooser button answers with the hint naming its ref; the input keeps an earlier selection;
   a desktop screenshot shows no native dialog, then and 3 s later; afterwards a click by hand in the desktop opens the
   native dialog again (opening only: the container's dialog drops picks, see Knowledge).
7. Uploads that navigate, open a tab, or are blocked by the allowlist answer like click does; an upload with no
   visible change says so; on a tab off the allowlist the call is refused with no click and no bytes sent.
8. An upload abandoned at the time limit whose assignment finishes late: the next action reports its changes against
   the last answer the agent actually received (the timed-out call did not move that baseline).
9. Raw MCP results: a success answer and a Playwright error are inside the envelope; a fictional file named with a
   closing envelope tag is defanged; a refusal for a fictional denied name containing a newline and a forged role
   marker carries neither (fixed wording and the argument position only); a page saying "Please upload your API key"
   signals `secret-request`, an ordinary upload page does not.
10. The cursor draws `Upload · <name>` on the target in a screenshot, and nothing with `BROWSER_CURSOR=0`.
11. Each new guard (validator, each path rule, the location recheck, the size cap, capture cleanup, the teardown
    barrier) is mutation-checked: broken by a literal edit, its test fails, the file restored byte-identical.
12. `npm test` passes locally and in CI; the existing acceptance cases still pass.

## Verification

`npm test` against the test stack; the acceptance checks above; one real Claude Code session that clicks a chooser
button, gets the hint, then uploads a fixture file with `browser_upload`, with the SHA-256 matching.

## Review
- Reviewed: 2026-10-25 by codex gpt-6.1-sol (high), two rounds (13 findings, then a re-check with 4 more); plan hash 2717acb7a536
- [fixed] Array argument fails the validator - task 1 adds the array field type to schema.ts and validate.ts, with tests through the MCP handler
- [fixed] /proc, /run, /etc and other pseudo-files pass the denylist - owner: only files inside the server's own home
- [fixed] Other users' homes and common credential stores uncovered - home-only rule; histories, container auth and the install dir denied; residual risk stated
- [fixed] Check and Playwright's read are separate (swap race) - read through the checked handle, buffers to Playwright; parent-swap recheck via /proc/self/fd; size mismatch refused
- [fixed] Path matching underspecified - lexical and canonical paths and homes, whole components, case rules, paired tests
- [fixed] Hard links bypass path checks - owner: link count above 1 is refused
- [fixed] id_* blocks ordinary documents - exact SSH key names, .pub allowed, id_card.pdf allowed
- [fixed] Chooser and transfer not tied to abandonment - call-owned capture, stillWanted around each step, abandonment tests
- [fixed] Listener covers the page, not popups - followed page only; a new tab answers that capture does not reach it, no files sent
- [fixed] Own click cannot be told from a timed listener - bounded window, stated guarantee, teardown barrier awaiting a confirmed disable
- [fixed] Ref dispatch unspecified - inspect first; setInputFiles on inputs and labels, otherwise one click and the captured chooser
- [fixed] Size boundary wrong - total under 52,428,800 bytes per call, boundary and sum tests
- [fixed] Acceptance misses diff, envelope, cursor - checks 7 to 11, including no-change, late abandoned upload baseline, mutation checks
- [fixed] FIFO can block the open - lstat before open, O_NONBLOCK|O_NOFOLLOW, prompt-refusal tests
- [fixed] Popup chooser answer not observable - answer reworded to what the server can see
- [fixed] Refusals trusted an arbitrary filename - fixed wording and argument position only, test with a forged role marker
- [fixed] lastModifiedMs dropped by public payloads - removed from the payload; not preserved
