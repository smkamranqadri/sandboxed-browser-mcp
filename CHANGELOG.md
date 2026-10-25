# Changelog

## Unreleased

### Added

- **`browser_upload { ref, files }`**, the twelfth tool: gives a page's file input files from this machine, under the
  server's home only, minus a denylist of credential, key, history and browser-profile files. A file input or its
  label gets them directly; any other control (a button that opens a chooser, one that makes its input on click) is
  clicked once and the file chooser it opens gets them. Files are read on the host and sent as bytes over CDP: no
  folder is shared with the container. Linux only.

### Changed

- **`browser_click` catches a file chooser** its click opens on the followed tab: no native dialog appears, no file is
  chosen (an earlier selection stays), and the answer points to `browser_upload` with the ref.

### Known limits

- A page that removes its file input right after opening the chooser reads as uploaded, though the page got nothing.
- The container's native file dialog drops the file picked in it (seen on Wayland without a desktop portal), so
  picking by hand in the browser's desktop does not upload either.

## 1.0.0 (2026-10-24)

The first release: an MCP server that lets a coding agent use a real Chromium in Docker, read as short text and kept
to the hosts you allow.

- **Eleven tools** over stdio: `browser_navigate`, `browser_back`, `browser_snapshot`, `browser_click`,
  `browser_type`, `browser_select`, `browser_key`, `browser_scroll`, `browser_find`, `browser_get_text` and
  `browser_screenshot`. Calls run one at a time, and a call that runs past its time limit
  (`BROWSER_CALL_TIMEOUT_MS`) is answered as failed and takes no further step.
- **The page as text.** A view of the viewport and half a screen around it, one line per element
  (`role "name": text [ref] states`), with a header for title, address and scroll position and counts of what lies
  above and below. Long text is cut with a pointer to `browser_get_text`, which reads it in parts; `browser_find`
  searches the whole page.
- **Answers sized for a model.** Actions answer with what changed since the agent last looked, or with the new page,
  or the new tab they opened, which the session then follows. Refs from a page that is gone, and things that are not
  refs, get one plain answer. Missing options, fields that cannot take text and bad addresses are answered at once.
- **A fence in three layers** when `BROWSER_ALLOWED_HOSTS` is set: the browser's own managed policy, a CDP guard that
  fails page requests to other hosts in every tab and frame, and a check of where each navigation and action ended up,
  which puts the tab back and refuses to read a tab that is off the list.
- **Untrusted text.** Everything read from a page comes wrapped in `<untrusted-web-content>`, with a closing tag in the
  page defanged, and with a warning line when the text looks like an attempt to instruct the model (override,
  addressed, persona, role-markup, hidden, secret-request).
- **A visible cursor** that moves to each target and says what it is doing, drawn where the page cannot see, style or
  drive it; `BROWSER_CURSOR=0` turns it off completely.
- **An installer** (`install.sh`) that builds a release, starts the browser stack and registers the server with
  Claude Code, Codex or pi, with `check` (by commit when it can), `update` and `uninstall` (`--purge` also deletes the
  browser profile).
- Requires Node 22.4 or later and Docker with Compose.
