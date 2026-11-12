# Plan: named browser profiles

Status: scope decided by the owner 2026-11-12 (interview below). Implemented on branch
`brigade/implement-multiple-named-browser-5b9823` (not released; the owner releases). No second-CLI review of this plan
was recorded before the code was written (the worker could not start another agent); the instructions sentence (open
question 1) was taken as recommended.

Goal: a person keeps separate signed-in sessions, for example `work` and `personal`. The agent picks one per call with
an optional `profile` argument. Today there is one stack, one `profile` volume at `/config` and one fixed project name.

## Decisions (owner, 2026-11-12)

1. Several profiles run at the same time.
2. A profile is chosen by an **optional `profile` tool argument**, default `default`. (The recommendation was the
   client entry name; the owner chose the argument.)
3. The server learns the profiles from `profiles.json`, written by `install.sh`. The agent cannot create profiles.
4. The session keeps **one followed tab per profile**. Calls still run one at a time.
5. `install.sh profile add|list|remove` manages profiles. One client entry `browser` serves all of them.
6. Allowed hosts are per profile.
7. `uninstall --purge` without `--profile` deletes every profile, after listing them; it needs `--yes` when more than
   one exists.
8. Names match `^[a-z][a-z0-9-]{0,23}$`. `default` and `test` are reserved.
9. Order: profiles **before** Command Code as a client.

10. Version 1.2.0: the new argument is optional.
11. A client entry may limit its profiles with `BROWSER_PROFILES` (default: all). Unlisted names are refused.

## Findings that shape the plan

- A profile is one whole stack: its own container, volume, ports, password and allowed-hosts policy.
- The compose file has `name: sandboxed-browser-mcp`. Docker names the volume `sandboxed-browser-mcp_profile` from it.
  Another stack needs another project name (`docker compose -p`), which gives it its own volumes and network.
- `default` keeps today's project name, so it keeps the existing volume and sessions. **No migration is needed.**
  Another profile `N` uses the project `sandboxed-browser-mcp-N`.
- The server today holds one connection, one guard, one followed tab and one set of refs. `cdpUrl()` is read from
  `BROWSER_CDP_URL`. This is the main code change: that state must exist once per profile.
- Each running profile costs about 1 GB of shared memory plus Chromium. Document it; no cap in code.

## Design

**Installer.** `profile add N [--hosts ...]` picks the first free ports from 3101, 9322 and 8082 upward (all on
`127.0.0.1`), writes `$dir/profiles/N/.env` (mode 600, own random password, own `BROWSER_ALLOWED_HOSTS`), starts the
stack, and updates `$dir/profiles.json`. `default` keeps `docker/.env`. `profile list` shows name, ports, hosts and
state. `profile remove N [--purge]` stops that stack, and deletes its volume only with `--purge`. `install` creates
`default`. `update` keeps all env files and volumes, and restarts every profile's stack. `.clients` is unchanged, since
there is one client entry. `profiles.json` holds only name, CDP port and hosts. No password.

**Server.**
- On start, read `profiles.json` (the install dir is known from the server's own path). If it is missing, use one
  profile `default` from `BROWSER_CDP_URL` and `BROWSER_ALLOWED_HOSTS`, as now. So manual setups and 1.1.0 installs
  keep working.
- Every one of the twelve tools gets `profile`: string, optional, default `"default"`. An unknown name gets one error
  that lists the known names. A name that breaks the rule is refused before any lookup.
- The tool schemas list the profile names in the description (read at start), not as an enum, so the list can change
  without a schema change.
- Per profile: connection, navguard, followed tab, last view for the diff, refs. A ref belongs to its profile; a ref
  used with another profile gets the normal "not on the page" error. Connections open on first use of a profile.
- Calls stay serial across all profiles. The time limit and abandonment (`stillWanted`) apply as now.
- The allowlist check, the injection envelope and the upload rules run with the profile's own hosts.
- The cursor label and the answers do not need the profile name, except where an answer says "You are still on <host>".
  Add the profile name to answers only when it is not `default`, so single-profile output is byte-identical to 1.1.0.

## Security impact

- **Isolation is now a rule of the server, not only of the container.** One agent holds both `work` and `personal`.
  A page-driven agent (prompt injection) in `personal` can call `browser_navigate` with `profile: "work"` and act in
  signed-in sessions there. This is the cost of the owner's choice. The container boundary still separates cookies
  and files, but the tools do not. State it in `docs/security.md`, and in the server instructions: use a profile only
  when the user's task names it. The instructions text is a prompt, not a control.
- The control (decision 11): a per-client list of allowed profiles, set in the client entry
  (`BROWSER_PROFILES=personal`), so a client can be fenced to some profiles.
- CDP stays unauthenticated on loopback: any local process reaches every profile. More profiles mean more such ports.
- The fence is per profile, in both places (`profiles.json`/entry env for the server, the profile's `.env` for the
  Chromium policy). `profile add --hosts` writes both from one value; `profile list` shows them.
- The upload denylist already refuses the install folder, so `profiles/N/.env` is covered. A unit test pins it.
- To test once by hand and record: a page in one container cannot reach another profile's published port.
- Upload from `profile` A only reads host files (unchanged); the profile decides only where the bytes go.

## Tool contract impact

Public interface: the twelve names, argument names, types, defaults and required lists. The change is **additive**:
one optional argument `profile` on all twelve tools. A call without it behaves as in 1.1.0. Update
`kis/intent/spec-browser-tools.md` (section 2 table, a new section for profiles) when built. Prompts and clients that
validate strictly against a stored schema see a new optional property only.

## Challenges

- The argument gives the agent the power to cross profiles; the client-entry choice did not. The owner chose the
  argument, so the plan keeps it and adds the per-client limit (decision 11).
- Three of the twelve tools read a ref. A model may pass a ref from one profile with another profile's name. The
  refusal must be clear (says which profile the ref came from if known; otherwise "take a new snapshot").
- Profile names appear in answers and prompts; a page cannot set them. They are not escaped into the envelope.

## Files likely involved

`src/tools.ts`, `src/connection.ts`, `src/tabs.ts`, `src/navguard.ts`, `src/cdp.ts`, `src/guard.ts`, `src/schema.ts`,
`src/validate.ts`, `src/server.ts`, a new `src/profiles.ts`, `install.sh`, `docker/compose.yaml` (project name
override, ports), `docs/{configuration,security,how-it-works,testing}.md`, `README.md`, the spec, `test/`.

## Acceptance checks

- A 1.1.0 install updated keeps its volume and sessions: write a cookie in the old stack, update, read it back.
- Every tool without `profile` gives the same answers as 1.1.0 (kept tests pass unchanged).
- Two profiles run together: different ports and passwords; a cookie set in one is absent in the other; each fence
  holds on its own list; a ref from one is refused in the other; each profile has its own followed tab.
- Unknown or invalid profile names fail with one plain error before any browser work.
- `profile remove N` leaves `default` untouched; `--purge` deletes only `N`'s volume. `uninstall --purge` lists all
  profiles and needs `--yes` with more than one.
- Bad names (`Work`, `a b`, `../x`, `default`, `test`, 25 characters, empty) fail before any docker call.
- Tool list: the same twelve tools; each has the optional `profile` property and nothing else changed.

## Verification method

- Unit: profile file parsing, name validation, per-profile state (fake browser, two profiles), schema check of all
  twelve tools. Mutation-check each guard.
- Installer: a bash test for names and port choice, plus a manual run on a scratch `--dir` with `XDG_DATA_HOME` set,
  with `docker volume ls` before and after. Never the installed copy.
- Integration: the test stack plus a second test profile on other ports (cookie, fence, ref and tab isolation).
- One real client session using both profiles, as the project requires.

## Work mode and review

Standard to Phase: the server change touches the session core. A review by a different CLI than the author is needed
before code (`plan.md` Review). Not done yet.

## KIS writes this plan implies

- Knowledge: profile-to-project mapping, `profiles.json` format, per-profile session state (when built).
- Intent: this file, and the spec's tool table and a profiles section (when built).
- State: the Next line (done); proof when built.

## Open questions still for the owner

1. **Server instructions.** Recommended: add one sentence: use a profile only when the user names it; otherwise omit
   `profile`. (Low stakes; assumed unless the owner objects at plan review.)
