# Project

sandboxed-browser-mcp: a stdio MCP server (TypeScript, Node >= 22.4, `@modelcontextprotocol/sdk`, `playwright-core`,
`zod`) that drives a Chromium in a Docker container over CDP with text-first browser tools (eleven in 1.0.0; twelve with `browser_upload`, see
Uploads). MIT, public repo
`smkamranqadri/sandboxed-browser-mcp`, solo maintainer. For agents (Claude Code, Codex, pi, any stdio MCP client) on
the user's own machine.

Design, threat model and setup are documented in the repo; read them there instead of restating them here:
`docs/how-it-works.md`, `docs/security.md`, `docs/configuration.md`, `docs/testing.md`. The tool contract is
`kis/intent/spec-browser-tools.md` (tool names, arguments and defaults are a public interface).

## Gates

- `npm test` = unit (`test/unit`, fake browser) then integration (`test/integration`, one at a time against the test
  stack: `npm run stack:test:up`, env in `docker/.env.test`, see `docs/testing.md`).
- CI: four checks, required by branch protection on `main`.
- A client counts as supported only after one real session against the test stack.

## The browser container

- Image `lscr.io/linuxserver/chromium`, desktop served by Selkies at `https://127.0.0.1:3101` (login user `agent`,
  password `BROWSER_PASSWORD`). The browser runs as user `abc`, home `/config` (the `profile` volume).
- Container name on a default install: `sandboxed-browser-mcp-browser-1`.
- No host directory is mounted into it: the browser sees only `/config` and the managed-policy volume.

## Uploads

`browser_upload` (branch `upload-impl`; whether it is merged is in State). Contract: `kis/intent/plan-file-upload.md`
and the spec's upload section; threat model: `docs/security.md`. Facts that are not obvious from those:

- Host files reach a page as bytes over CDP: `connectOverCDP` without `isLocal` marks the browser as not co-located,
  so Playwright reads buffers on the host (50 MiB total per call, `>=` refused). No mount, no native dialog.
- Playwright's `setInputFiles` does not follow a `<label>` to its control; the tool resolves the input itself.
- Choosers are caught through Playwright's private `page._channel.updateSubscription({ event: "fileChooser" })`
  (src/chooser.ts), because public `on`/`off` do not wait for the browser to confirm. Pinned to playwright-core
  1.64.0: an upgrade that drops it makes every click fail in the tests.
- Playwright 1.64.0 discards a CDP error from `Page.setInterceptFileChooserDialog` on a frame session, so a disable
  the browser rejects on a live session is not seen (owner accepted this gap 2026-10-25; documented in security.md).
- The location recheck reads `/proc/self/fd`: uploads work on Linux only; elsewhere every upload is refused.
- The container has `wtype`: `docker exec -u abc -e XDG_RUNTIME_DIR=/config/.XDG -e WAYLAND_DISPLAY=wayland-0
  <container> wtype -k Escape` types on its desktop (the tests use it to see whether a native dialog is open).
- A popup cannot open a chooser from its opener's click (user activation does not carry over); a test needs a
  trusted click inside the popup.

## Known limits

- **The container's native file dialog drops the pick** (seen 2026-10-25 on LinkedIn: the dialog opens, the person
  picks a file, the input still has 0 files). The desktop is labwc on Wayland (`--ozone-platform=wayland`), with no
  xdg-desktop-portal and no session D-Bus; likely, not confirmed, the cause. Picking by hand through the desktop page
  does not upload; use `browser_upload`.
- Sites often add their hidden `<input type=file>` only once the upload button is clicked (LinkedIn does).
- No downloads: no tool fetches a file, and a navigation that turns into a download fails as `ERR_ABORTED`
  (`src/tools.ts` says so in its answer).
