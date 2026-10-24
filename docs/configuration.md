# Configuration

The [install script](../README.md#quick-start) sets everything up. Everything below is for doing it by hand, or for
changing it later.

## The install script

```sh
curl -fsSL https://raw.githubusercontent.com/smkamranqadri/sandboxed-browser-mcp/main/install.sh \
  | bash -s -- install --client claude
```

It fetches the newest release into `~/.local/share/sandboxed-browser-mcp` (or `$XDG_DATA_HOME/sandboxed-browser-mcp`),
builds it, writes `docker/.env` there (a generated browser password, mode 600, never printed), starts the browser
stack, and adds the server as `browser` to the clients named by `--client` (`claude`, `codex`, `pi`, comma-separated;
without it, the commands are printed instead). A client that already has a server named `browser` is left as it is.

| Command or option | What it does |
| --- | --- |
| `--hosts 'docs.example.com,*.example.org'` | Fences the browser to those hosts (see [Security](security.md)). Without it, any host. |
| `check` | Says whether a newer release exists. |
| `update` | Installs it, keeping `docker/.env`, the client entries and the browser profile (your signed-in sessions). |
| `uninstall` | Stops the stack, removes the client entries it added and the install directory. `--purge` also deletes the browser profile. |
| `--ref v1.0.0` | Installs that release instead of the newest. |
| `--dir <path>` | Installs somewhere else. |
| `--help` | Lists the rest. |

## Manual setup

From a clone of this repository.

```sh
# 1. The browser. The password never goes through the terminal output. The allowed hosts: the same list you give the
#    MCP server below (leave it out for any host).
( umask 077; printf 'BROWSER_PASSWORD=%s\nBROWSER_ALLOWED_HOSTS=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" \
  'docs.example.com,*.example.org' > docker/.env )
docker compose -f docker/compose.yaml up -d

# 2. Sign in by hand once (user: agent, password: in docker/.env), so the agent browses with your sessions,
#    or leave it signed out. Self-signed certificate:
#    https://127.0.0.1:3101

# 3. The server
npm ci
npm run build          # -> dist/server.js
```

## Add it to a client

Use the absolute path of `dist/server.js` (below: `$PWD`, from the repository root). Add `BROWSER_ALLOWED_HOSTS`
unless you want any host.

```sh
# Codex
codex mcp add browser --env 'BROWSER_ALLOWED_HOSTS=docs.example.com,*.example.org' -- node "$PWD/dist/server.js"

# Claude Code (-s user: in every project, not only the current one)
claude mcp add -s user browser -e BROWSER_ALLOWED_HOSTS='docs.example.com,*.example.org' -- node "$PWD/dist/server.js"

# pi (its default exposure is "codemode"; --exposure direct lists the eleven tools as they are)
pi mcp add browser --exposure direct --env BROWSER_ALLOWED_HOSTS='docs.example.com,*.example.org' -- node "$PWD/dist/server.js"
```

Any other MCP client: run `node <path>/dist/server.js` over stdio, with the environment below.

## Allowed hosts

`BROWSER_ALLOWED_HOSTS` is set in two places, and nothing checks that they match:

- on the MCP server (the `--env` / `-e` above), for the server's own checks;
- in `docker/.env`, where it becomes a Chromium policy (`docker/policy.sh`, run by the compose file's `policy` service
  before the browser starts), so the browser itself refuses other hosts even while the MCP server is not connected.

To change the browser's side, edit `docker/.env` and run `docker compose -f docker/compose.yaml up -d` again; the
browser applies it within seconds. An entry that is not a host name makes the policy allow nothing, and the browser
does not start.

## Environment

Set on the MCP server.

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_CDP_URL` | `http://127.0.0.1:9322` | The browser's debugging endpoint. Must match `BROWSER_CDP_PORT` if you moved it. |
| `BROWSER_ALLOWED_HOSTS` | empty (any host) | Comma list of host names, `*.example.com` for any subdomain (not `example.com` itself: list it too). Host names only, no ports or paths. |
| `BROWSER_CALL_TIMEOUT_MS` | `90000` | How long one call may take before it is answered as failed and stopped, so a page that never answers holds up only that call. |
| `BROWSER_CURSOR` | on | `0` turns the cursor off completely: no arrow is drawn and nothing is put into the pages (see [How it works](how-it-works.md#the-cursor)). |

Used by the tests only: `TEST_BROWSER_CONTAINER`, `TEST_STACK_PROJECT`, `FIXTURE_PORT` (see [Testing](testing.md)).

## Ports

Published on `127.0.0.1` only: `3101` (the desktop in a web page), `9322` (CDP), `8082` (the desktop's frame stream,
for watching; the MCP server does not use it). Move them with `BROWSER_WEB_PORT`, `BROWSER_CDP_PORT`,
`BROWSER_STREAM_PORT` in `docker/.env`.

## Using another Chrome

`BROWSER_CDP_URL` can point at any Chrome with remote debugging on. Start it with
`--disable-features=BackForwardCache`, as the compose file does and as Playwright's own launcher does: a page restored
by "back" otherwise keeps element refs the tools no longer know. The Chromium policy (allowed hosts in the browser
itself) is then yours to set up.
