# Plan: named browser profiles

Status: draft, not approved. Written 2026-11-12 from the code, with no owner interview yet. The answers to the open
questions below decide the scope. Nothing is implemented.

Goal: a person keeps separate signed-in sessions, for example `work` and `personal`, and picks one per MCP client
entry. Today there is one stack, one `profile` volume mounted at `/config`, and one fixed project name.

## Findings that shape the plan

- A profile is one whole stack: its own browser container, its own `profile` volume and its own ports. The volume
  alone is not enough. Two containers on one port, one password or one allowed-hosts policy would collide.
- The compose file already has `name: sandboxed-browser-mcp`. Docker names the volume `sandboxed-browser-mcp_profile`
  from it. A second stack needs another project name (`docker compose -p`), which gives it its own volumes, network and
  container names for free.
- The MCP server needs no change. It already reads `BROWSER_CDP_URL`. A client entry that points at another port is
  already "another profile".
- Several profiles at once cost little in code. Each costs about 1 GB of shared memory plus Chromium.

## Proposal

1. **Profile = a compose project.** The profile `default` keeps today's project name `sandboxed-browser-mcp`, so its
   volume is the existing one. **No migration is needed.** Any other name `N` uses the project `sandboxed-browser-mcp-N`.
2. **Selection is the MCP client entry.** `install.sh ... --profile N` adds the client entry `browser-N` (the existing
   entry `browser` stays the default profile) with `BROWSER_CDP_URL=http://127.0.0.1:<port of N>`. The agent sees
   different server names, so it can tell the profiles apart. It cannot switch profile.
3. **Several run at once.** Each profile has its own env file, `$dir/profiles/N/.env` (mode 600): its own random
   password, its own web, CDP and stream ports, and its own `BROWSER_ALLOWED_HOSTS`. `default` keeps `docker/.env`.
   Ports are the first free ones from 3101, 9322 and 8082 upward, chosen at creation and then fixed. Every port stays
   bound to `127.0.0.1`.
4. **One code install, many profiles.** `install.sh profile add N [--hosts ...] [--client ...]`, `profile list` and
   `profile remove N [--purge]`. `install` and `update` act on every profile. `update` keeps all env files and
   volumes, and restarts each stack that is registered.
5. **Names:** `^[a-z][a-z0-9-]{0,23}$`, checked in `install.sh` before anything runs. `default` is reserved for the
   existing profile. `test` is reserved (the test stack is `sandboxed-browser-mcp-test`). A name is refused if its
   project or client entry already exists.
6. **Uninstall:** `uninstall` stops all stacks and removes all client entries, as today. `--purge` deletes all volumes.
   `uninstall --profile N [--purge]` and `profile remove` touch only that profile. `.clients` records
   `<client> <profile>` per line. An old one-word line means `default`.
7. **Tool contract:** unchanged. No `profile` argument, no new tool. Reason: the tool names and arguments are a public
   interface, and an argument would let a page-driven agent cross from `personal` to `work`. The server instructions
   and tool descriptions stay as they are.

## Security impact

- Isolation between profiles is the container and volume boundary. A tool call reaches only the CDP port of its own
  entry. This is the same trust as today: CDP stays unauthenticated on loopback, so any local process reaches
  **every** profile. `docs/security.md` must say that more profiles mean more such ports.
- The fence is per profile, in both places (the entry's env and the profile's `.env`). The two copies can drift, as now.
  `profile add --hosts` writes both from one value. `profile list` shows each profile's list.
- The upload denylist already refuses the install folder (`.local/share/sandboxed-browser-mcp`), so
  `profiles/N/.env` with its password is covered. A unit test must pin this for the `profiles/` path.
- To check, not assume: a page in one container cannot reach the other profile's published port. It is bound to
  `127.0.0.1` on the host, so it should not be reachable through the docker gateway. Test it once by hand and record
  the result.
- Not solved: a person who signs in to the same account in two profiles shares nothing, but the agent in `work` and in
  `personal` both have full web access if the list is empty.

## Challenges

- Is this wanted at all, or is `--dir` enough? It is not: two installs share the fixed project name, so the second
  `up` would replace the first. A profile flag is the smaller fix than a per-install project name.
- A tool argument `profile` is simpler to use, but it breaks the interface and the isolation. Rejected.
- A single container with several Chromium user-data dirs is rejected: one CDP port would see all of them, and the
  policy is shared.
- Resource use: five profiles is about 5 GB of shared memory reserved. Document it. Do not cap it in code.

## Files likely involved

`install.sh` (flag, `profile` command, per-profile env and ports, `.clients` format, uninstall), `docker/compose.yaml`
(`name:` must be overridable by `-p`; check that `${...}` ports need no change), `docs/configuration.md`,
`docs/security.md`, `docs/how-it-works.md` (layout), `README.md`, `docs/testing.md`, `test/` (below), `kis/state`.
No `src/` change expected, except the denylist test.

## Acceptance checks

- A fresh install is byte-for-byte the same as today for `default` (same project, volume, ports, entry name).
- An install made with 1.1.0 and updated keeps its volume and its sessions: write a cookie in the old stack, update,
  read it back.
- Two profiles run together: different ports and passwords, each cookie visible only in its own browser, each fence
  enforced on its own list.
- `profile remove N` leaves `default` untouched. `--purge` removes only `N`'s volume.
- Bad names (`Work`, `a b`, `../x`, `default`, `test`, 25 characters, empty) fail before any docker call.
- The tool list of every entry is the same twelve tools with the same schemas.

## Verification method

- Unit: name validation and port choice are shell, so test them with a small bash test run from `npm run test:unit`
  (use `install.sh` functions behind a `--dry-run`-style seam, or a sourced helper file). Add the denylist test for
  `profiles/`. Run mutation checks on each guard.
- Integration: bring up the test stack plus a second test profile on other ports; assert cookie isolation and fence
  isolation through MCP. Extend `docker/compose.test.yaml` use only if needed. Keep CI at four checks.
- Manual, on a scratch `--dir` with `XDG_DATA_HOME` set, never the installed copy: install, add, update, remove,
  uninstall, with `docker volume ls` before and after.
- One real client session against the second profile, as the project requires for a client.

## Work mode and review

Standard. A plan review by a different CLI than the author is needed before any code (see `plan.md` Review). It is not
done yet.

## KIS writes this plan implies

- Knowledge: the profile-to-project mapping and the `.clients` format, when built.
- Intent: this file. The spec stays unchanged because no tool changes.
- State: the Next line (done in this change); proof when built.

## Open questions for the owner

Each has a recommended answer. Answer in order; the later ones depend on the first.

1. **Several profiles at once, or one at a time?** Recommended: at once. It is the only way two client entries can use
   different profiles in one day, and it costs little extra code.
2. **How is a profile chosen?** Recommended: by client entry name (`browser-work`), set by `install.sh --profile`.
   Not an env var on the shared install, and not a tool argument.
3. **Does the server entry for `default` keep the name `browser`?** Recommended: yes, so current prompts and installs
   work unchanged.
4. **A `profile add|list|remove` command, or only `install --profile N` on a new `--dir`?** Recommended: the
   `profile` command, because `--dir` copies and rebuilds the code and keeps one project name.
5. **Per-profile allowed hosts?** Recommended: yes, `--hosts` applies to the profile being added. `work` and
   `personal` usually need different lists.
6. **Does `uninstall --purge` without `--profile` delete every profile's sessions?** Recommended: yes, but list the
   profiles and volumes it will delete and ask for `--yes` when more than one exists.
7. **Name rule** `^[a-z][a-z0-9-]{0,23}$` with `default` and `test` reserved. Recommended: accept.
8. **Version:** a feature with no tool change. Recommended: 1.2.0 (minor).
9. **Does this come before Command Code as a client (the current Next)?** Recommended: no. Finish Command Code first
   (small, planned), then profiles. Both touch `install.sh`, so do not run them in parallel.
