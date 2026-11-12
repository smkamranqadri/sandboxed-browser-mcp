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
| `update` | Installs it, keeping `docker/.env`, the client entries and every browser profile (your signed-in sessions), and restarts each profile's stack. |
| `uninstall` | Stops every stack, removes the client entries it added and the install directory. `--purge` also deletes every browser profile; with more than one it lists them and needs `--yes`. |
| `profile add <name> [--hosts …]` | Starts another, separate browser (see [Profiles](#profiles)). |
| `profile list` | Shows each profile: name, ports, allowed hosts, state. |
| `profile remove <name> [--purge]` | Stops that profile's browser; its sessions (volume) stay unless `--purge`. A kept volume is recorded in `.kept-profiles`: `profile add <name>` brings it back, and `profile remove <name> --purge` or `uninstall --purge` can still delete it. |
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
unless you want any host. (An install made by `install.sh` has a `profiles.json` and takes the hosts from it; the entry
`install.sh --client` adds does not set them. See [Profiles](#profiles).)

```sh
# Codex
codex mcp add browser --env 'BROWSER_ALLOWED_HOSTS=docs.example.com,*.example.org' -- node "$PWD/dist/server.js"

# Claude Code (-s user: in every project, not only the current one)
claude mcp add -s user browser -e BROWSER_ALLOWED_HOSTS='docs.example.com,*.example.org' -- node "$PWD/dist/server.js"

# pi (its default exposure is "codemode"; --exposure direct lists the twelve tools as they are)
pi mcp add browser --exposure direct --env BROWSER_ALLOWED_HOSTS='docs.example.com,*.example.org' -- node "$PWD/dist/server.js"
```

Any other MCP client: run `node <path>/dist/server.js` over stdio, with the environment below.

## Profiles

A profile is a whole, separate browser: its own container, volume (cookies and logins), ports, password and allowed
hosts. Use one per identity, for example `work` and `personal`. They run at the same time, and one client entry
(`browser`) serves all of them: a tool call picks one with its optional `profile` argument (default `default`). The
agent cannot create profiles; only `install.sh` does.

```sh
install.sh profile add work --hosts 'docs.example.com,*.example.org'   # a second browser, on the next free ports
install.sh profile list
install.sh profile remove work            # stops it, keeps its sessions; --purge deletes them
```

- `default` is the install's own browser (`docker/.env`, the compose project `sandboxed-browser-mcp`), so an existing
  install keeps its volume and sessions: nothing is migrated.
- Another profile `N` is the same compose file under the project `sandboxed-browser-mcp-N`, with its own env file
  `profiles/N/.env` (mode 600; its password, ports and `BROWSER_ALLOWED_HOSTS`). Ports are the first free ones from
  `3101`, `9322` and `8082` upward, on `127.0.0.1`. Names: lowercase letters, digits and `-`, starting with a letter,
  at most 24 characters; `default`, `test` and every `test-*` are reserved (the test stacks use those project names, and
  `npm run stack:test-b:down` deletes their volumes).
- Each running profile costs about 1 GB of shared memory plus its Chromium. There is no cap in the code.
- `profiles.json` in the install folder (written by `install.sh`; name, CDP port and hosts of each profile, no
  password) is how the server learns them, when it starts. Restart your MCP clients after adding or removing a profile.
  Without that file (a manual setup, or a 1.1.0 install not yet updated) there is one profile, `default`, from
  `BROWSER_CDP_URL` and `BROWSER_ALLOWED_HOSTS`, as before.
- With a `profiles.json`, each profile's hosts come from it. A client entry that still sets `BROWSER_ALLOWED_HOSTS`
  (1.1.0 put the hosts there) to a list that differs from the default profile's hosts makes the server refuse to start,
  with a message saying so: two fences that disagree would leave one of them silently unused. Remove the variable from
  the client entry and set the hosts in `docker/.env` (then `install.sh update`), or make the lists equal. The same value is also in
  the profile's env file, for the browser's own policy. To change a profile's hosts, edit its env file and
  `profiles.json`, then `docker compose` up again for that project; `install.sh update` rebuilds `profiles.json` from
  the env files.
- `BROWSER_PROFILES` on a client entry limits that client to some profiles (`BROWSER_PROFILES=personal`). Other names
  are refused, and if `default` is not in the list a call must name a profile. Unset: all profiles. `install.sh` does not set it: add it yourself to the client entry (for example `claude mcp add -s user browser-personal -e BROWSER_PROFILES=personal -- node "$HOME/.local/share/sandboxed-browser-mcp/dist/server.js"`).
- A ref belongs to the profile that showed it. When a client has several profiles, refs of every profile but `default` end in `@name` (`e12@work`), and a call refuses a ref of another profile with a clear error.
- Calls still run one at a time, across all profiles. Each profile keeps its own followed tab.
- `install.sh` reads `COMPOSE_PROJECT_NAME`, if set, as the base of the project names (for a trial install next to a
  real one). Do not set it on a normal install.

## Allowed hosts

`BROWSER_ALLOWED_HOSTS` is set in two places. Without a `profiles.json` nothing checks that they match; with one, the server refuses to start when the client entry's list differs from the default profile's:

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
| `BROWSER_PROFILES` | empty (all profiles) | Comma list of profile names this client may use. See [Profiles](#profiles). |
| `BROWSER_PROFILES_FILE` | `profiles.json` one folder above `dist/` | Where the profile list is. Mainly for tests. |
| `BROWSER_CALL_TIMEOUT_MS` | `90000` | How long one call may take before it is answered as failed and stopped, so a page that never answers holds up only that call. |
| `BROWSER_CURSOR` | on | `0` turns the cursor off completely: no arrow is drawn and nothing is put into the pages (see [How it works](how-it-works.md#the-cursor)). |

Used by the tests only: `TEST_BROWSER_CONTAINER`, `TEST_STACK_PROJECT`, `FIXTURE_PORT` (see [Testing](testing.md)).

## Ports

Published on `127.0.0.1` only: `3101` (the desktop in a web page), `9322` (CDP), `8082` (the desktop's frame stream,
for watching; the MCP server does not use it). Move them with `BROWSER_WEB_PORT`, `BROWSER_CDP_PORT`,
`BROWSER_STREAM_PORT` in `docker/.env`. Other [profiles](#profiles) take the next free ports; `install.sh profile list`
shows them.

## Using another Chrome

`BROWSER_CDP_URL` can point at any Chrome with remote debugging on. Start it with
`--disable-features=BackForwardCache`, as the compose file does and as Playwright's own launcher does: a page restored
by "back" otherwise keeps element refs the tools no longer know. The Chromium policy (allowed hosts in the browser
itself) is then yours to set up.
