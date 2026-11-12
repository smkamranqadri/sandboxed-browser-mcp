#!/usr/bin/env bash
# Installs sandboxed-browser-mcp: fetches a tagged release, builds it, starts the browser stack (docker/compose.yaml)
# and, if asked, adds the server to Codex, Claude Code or pi.
#
#   curl -fsSL https://raw.githubusercontent.com/smkamranqadri/sandboxed-browser-mcp/main/install.sh | bash -s -- install
#
# The browser's password is generated into docker/.env (mode 600) and never printed. Any host is allowed unless
# --hosts is given. An update keeps docker/.env, the client registrations and the browser profile (signed-in sessions).
#
# Named browser profiles: `profile add work` starts a second, separate browser (own container, volume, ports, password
# and allowed hosts, in profiles/work/.env). profiles.json (name, CDP port, hosts; no password) is how the server learns
# them. The profile `default` is the install's own docker/.env stack and keeps its volume.
set -euo pipefail
# Lists like --hosts '*.example.org' are split, never matched against files here.
set -f

usage() {
  cat <<'EOF'
Usage: install.sh <install|check|update|uninstall|profile> [options]

Commands:
  install    Fetch, build, start the browser stack, and add the server to the clients named by --client.
  check      Say whether a newer release exists.
  update     Install the newest release (or --ref) over the current one; keeps docker/.env and the browser profile.
  uninstall  Stop every stack, remove the client entries this script added, and delete the install directory.
  profile add <name>      Start another, separate browser (own sessions, ports, password, hosts). Names: ^[a-z][a-z0-9-]{0,23}$,
                          not default, test or test-*. Ports are the first free ones from 3101, 9322 and 8082 up, on 127.0.0.1.
  profile list            Show each profile: name, ports, allowed hosts, state.
  profile remove <name>   Stop that profile's browser. Its sessions (volume) stay unless --purge is given.

Options:
  --hosts <list>     Allowed hosts, comma-separated (docs.example.com,*.example.org). Default: any host. (install, profile add)
  --client <list>    claude, codex, pi, comma-separated, or none (default): print the commands instead. (install)
  --ref <tag>        Release tag to install. Default: the newest v* tag.
  --dir <path>       Install directory. Default: ${XDG_DATA_HOME:-~/.local/share}/sandboxed-browser-mcp
  --repo <git-url>   Repository to fetch. Default: https://github.com/smkamranqadri/sandboxed-browser-mcp.git
  --source <path>    A local checkout to install instead of fetching (its working tree, ignored files left out).
  --purge            With uninstall: also delete every browser profile (the stacks' volumes). With profile remove: that one's.
  --yes              With uninstall --purge and more than one profile: confirm the deletion of all of them.
  -h, --help         Show this help.
EOF
}

die() {
  echo "install.sh: $*" >&2
  exit 1
}
say() { echo "install.sh: $*"; }

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage; exit 1; }
shift
case "$command_name" in
  install | check | update | uninstall | profile) ;;
  -h | --help) usage; exit 0 ;;
  *) die "unknown command: $command_name (see --help)" ;;
esac

repo="${SBM_REPO:-https://github.com/smkamranqadri/sandboxed-browser-mcp.git}"
dir="${XDG_DATA_HOME:-$HOME/.local/share}/sandboxed-browser-mcp"
ref=""
source_dir=""
hosts=""
clients="none"
purge=false
yes=false
profile_cmd=""
profile_name=""
if [[ "$command_name" == profile ]]; then
  profile_cmd="${1:-}"
  case "$profile_cmd" in
    add | remove)
      shift
      if [[ $# -gt 0 && "$1" != -* ]]; then profile_name="$1"; shift; fi
      ;;
    list) shift ;;
    *) die "profile needs add <name>, list or remove <name> (see --help)" ;;
  esac
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts) [[ $# -ge 2 ]] || die "--hosts needs a list"; hosts="$2"; shift 2 ;;
    --client) [[ $# -ge 2 ]] || die "--client needs a list"; clients="$2"; shift 2 ;;
    --ref) [[ $# -ge 2 ]] || die "--ref needs a tag"; ref="$2"; shift 2 ;;
    --dir) [[ $# -ge 2 ]] || die "--dir needs a path"; dir="$2"; shift 2 ;;
    --repo) [[ $# -ge 2 ]] || die "--repo needs a git URL"; repo="$2"; shift 2 ;;
    --source) [[ $# -ge 2 ]] || die "--source needs a path"; source_dir="$2"; shift 2 ;;
    --purge) purge=true; shift ;;
    --yes) yes=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
dir="${dir%/}"

for c in ${clients//,/ }; do
  case "$c" in claude | codex | pi | none) ;; *) die "unknown client: $c (claude, codex, pi or none)" ;; esac
done

# A release fetched but not yet in place is removed however the script ends.
stage=""
trap 'rm -rf "${stage:-/nonexistent}"' EXIT

compose() { docker compose --env-file "$dir/docker/.env" -f "$dir/docker/compose.yaml" "$@"; }

# ---- Profiles ----------------------------------------------------------------------------------------------------
# `default` is the install's own stack (docker/.env, the compose file's own project name, so it keeps its volume).
# Another profile N is the same compose file under the project <base>-N with its own env file, so it has its own
# container, volume, network and ports. <base> is COMPOSE_PROJECT_NAME if set, else the compose file's name.
PROFILE_RE='^[a-z][a-z0-9-]{0,23}$'
base_project="${COMPOSE_PROJECT_NAME:-sandboxed-browser-mcp}"

# Fails, before any docker call, on a name that cannot be a new profile.
check_profile_name() {
  [[ -n "$1" ]] || die "profile: a name is needed (lowercase letters, digits and -, starting with a letter, at most 24 characters)"
  [[ "$1" =~ $PROFILE_RE ]] || die "profile: '$1' is not a valid name (lowercase letters, digits and -, starting with a letter, at most 24 characters)"
  # `test` and test-* are the names of the test stacks (sandboxed-browser-mcp-test, -test-b): `npm run stack:test-b:down` deletes their volumes.
  case "$1" in default | test | test-*) die "profile: '$1' is a reserved name" ;; esac
}

env_file_of() { if [[ "$1" == default ]]; then echo "$dir/docker/.env"; else echo "$dir/profiles/$1/.env"; fi; }

# Setting $2 of profile $1, else $3. For `default` a variable in the shell wins over the file, as it does for compose.
profile_value() {
  local v=""
  if [[ "$1" == default ]]; then v="${!2:-}"; fi
  [[ -n "$v" ]] || v="$(sed -n "s/^$2=//p" "$(env_file_of "$1")" 2>/dev/null | head -1)"
  echo "${v:-$3}"
}

# `default` first, then the other profiles by name.
profile_names() {
  echo default
  if [[ -d "$dir/profiles" ]]; then
    local n
    for n in $(ls -1 "$dir/profiles" | sort); do
      if [[ "$n" =~ $PROFILE_RE && -f "$dir/profiles/$n/.env" ]]; then echo "$n"; fi
    done
  fi
}

# Profiles removed without --purge: their volumes (sessions) stay, so that profile add brings them back and a purge
# can still delete them. One name per line.
kept_file() { echo "$dir/.kept-profiles"; }
kept_names() { if [[ -f "$(kept_file)" ]]; then grep -E "$PROFILE_RE" "$(kept_file)" | sort -u || true; fi; }
is_kept() { kept_names | grep -qx "$1"; }
forget_kept() { if is_kept "$1"; then { kept_names | grep -vx "$1" || true; } >"$(kept_file).tmp" && mv "$(kept_file).tmp" "$(kept_file)"; fi; }
remember_kept() { if ! is_kept "$1"; then echo "$1" >>"$(kept_file)"; fi; }

# Deletes the docker volumes of profile $1's project, whatever env file it had. Succeeds when none is left.
drop_volumes() {
  local ids
  ids="$(docker volume ls -q --filter "label=com.docker.compose.project=$base_project-$1" 2>/dev/null)" || return 1
  [[ -z "$ids" ]] && return 0
  # shellcheck disable=SC2086
  docker volume rm $ids >/dev/null 2>&1
}

# docker compose for profile $1. A profile's stack takes nothing from the shell's BROWSER_* variables.
pcompose() {
  local name="$1"
  shift
  if [[ "$name" == default ]]; then compose "$@"; return; fi
  env -u BROWSER_PASSWORD -u BROWSER_ALLOWED_HOSTS -u BROWSER_WEB_PORT -u BROWSER_CDP_PORT -u BROWSER_STREAM_PORT -u COMPOSE_PROJECT_NAME \
    docker compose -p "$base_project-$name" --env-file "$dir/profiles/$name/.env" -f "$dir/docker/compose.yaml" "$@"
}

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# The first port from $2 up that no profile has claimed (in its env file) and nothing listens on; $1 is the setting.
pick_port() {
  local key="$1" p="$2" claimed n
  claimed=" $(for n in $(profile_names); do profile_value "$n" "$key" "$2"; done | tr '\n' ' ') "
  while [[ "$claimed" == *" $p "* ]] || port_busy "$p"; do
    p=$((p + 1))
    [[ $p -le 65535 ]] || die "no free port found from $2 up"
  done
  echo "$p"
}

# profiles.json from the env files: name, CDP port and allowed hosts of every profile; no password. Written whole.
sync_profiles() {
  local args=() n
  for n in $(profile_names); do
    args+=("$n" "$(profile_value "$n" BROWSER_CDP_PORT 9322)" "$(profile_value "$n" BROWSER_ALLOWED_HOSTS "")")
  done
  node -e '
    const fs = require("fs");
    const [file, ...rest] = process.argv.slice(1);
    const profiles = [];
    for (let i = 0; i < rest.length; i += 3) {
      profiles.push({ name: rest[i], cdpPort: Number(rest[i + 1]), hosts: rest[i + 2].split(",").map((h) => h.trim()).filter(Boolean) });
    }
    fs.writeFileSync(file + ".tmp", JSON.stringify({ profiles }, null, 2) + "\n");
    fs.renameSync(file + ".tmp", file);
  ' "$dir/profiles.json" "${args[@]}"
}

need_tools() {
  local missing=()
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  [[ ${#missing[@]} -eq 0 ]] || die "missing: ${missing[*]}"
  if [[ " $* " == *" node "* ]]; then
    # 22.4: its WebSocket client (the guard's connection) without the "experimental" warning of 22.0-22.3.
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 4) ? 0 : 1)' ||
      die "Node 22.4 or later is needed (found $(node -v))"
  fi
  if [[ " $* " == *" docker "* ]]; then
    docker compose version >/dev/null 2>&1 || die "Docker Compose (docker compose) is needed"
  fi
}

# The newest v* tag of the repository, or nothing when it has none.
latest_tag() {
  git ls-remote --tags --refs --sort=-v:refname "$repo" 'v*' 2>/dev/null | head -1 | sed 's|.*refs/tags/||'
}

installed_version() { node -p "require('$dir/package.json').version" 2>/dev/null || true; }

# The commit the install was fetched at, when it keeps its git metadata (a --source install has none), or nothing.
installed_commit() {
  [[ -e "$dir/.git" ]] || return 0
  git -C "$dir" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true
}

# The commit tag $1 points to: the peeled ^{} line of an annotated tag, the tag's own line otherwise.
tag_commit() {
  local lines
  lines="$(git ls-remote "$repo" "refs/tags/$1" "refs/tags/$1^{}" 2>/dev/null)" || return 0
  { grep '\^{}$' <<<"$lines" || grep -v '\^{}$' <<<"$lines" || true; } | head -1 | cut -f1
}

# Puts the release (or --source) into $1, then builds it there.
fetch_and_build() {
  local into="$1"
  rm -rf "$into"
  if [[ -n "$source_dir" ]]; then
    [[ -f "$source_dir/package.json" ]] || die "--source $source_dir has no package.json"
    mkdir -p "$into"
    # Its working tree as git sees it: tracked and new files, never ignored ones (docker/.env, node_modules, dist).
    (cd "$source_dir" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf - --) | tar -xf - -C "$into"
    say "copied $source_dir"
  else
    [[ -n "$ref" ]] || ref="$(latest_tag)"
    [[ -n "$ref" ]] || die "no release tag found in $repo (give one with --ref)"
    # init + fetch rather than clone --branch, which warns "is not a commit" for an annotated tag.
    mkdir -p "$into"
    { git -C "$into" init -q && git -C "$into" fetch -q --depth 1 "$repo" "$ref" &&
      git -C "$into" -c advice.detachedHead=false checkout -q FETCH_HEAD; } || die "could not fetch $ref from $repo"
    say "fetched $ref"
  fi
  (cd "$into" && npm ci --no-audit --no-fund --no-update-notifier --loglevel=error >/dev/null && npm run -s --no-update-notifier build) || die "the build failed in $into"
}

# Fails, before anything starts, on a host list the browser's policy would refuse.
check_hosts() {
  local tmp
  tmp="$(mktemp -d)"
  if ! BROWSER_ALLOWED_HOSTS="$1" POLICY_DIR="$tmp" sh "$2/docker/policy.sh" >/dev/null 2>"$tmp/err"; then
    local why
    why="$(cat "$tmp/err")"
    rm -rf "$tmp"
    why="${why#policy.sh: }"
    die "--hosts: ${why%%; wrote*}"
  fi
  rm -rf "$tmp"
}

# Starts the stack of profile $1 (default: the install's own) and waits until its browser answers.
start_stack() {
  local name="${1:-default}" port
  pcompose "$name" up -d --quiet-pull >/dev/null 2>&1 || { pcompose "$name" up -d; say "the browser stack of profile $name did not start"; return 1; }
  port="$(profile_value "$name" BROWSER_CDP_PORT 9322)"
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  say "the browser of profile $name did not answer on 127.0.0.1:${port} within 60 s (docker compose -f $dir/docker/compose.yaml logs)"
  return 1
}

# The command that adds the server to client $1, into the array `cmd` (bash 3.2 has no mapfile).
add_command() {
  # The allowed hosts are not set here: the server reads them, per profile, from profiles.json.
  case "$1" in
    claude) cmd=(claude mcp add -s user browser) ;;
    codex) cmd=(codex mcp add browser) ;;
    pi) cmd=(pi mcp add browser --exposure direct) ;;
  esac
  cmd+=(-- node "$dir/dist/server.js")
}

has_server() {
  case "$1" in
    claude) claude mcp get browser >/dev/null 2>&1 ;;
    codex) codex mcp get browser >/dev/null 2>&1 ;;
    pi) pi mcp list --json 2>/dev/null | grep -q '"browser"' ;;
  esac
}

register_clients() {
  local client cmd
  for client in ${clients//,/ }; do
    [[ "$client" == none ]] && continue
    command -v "$client" >/dev/null 2>&1 || { say "$client: not found, skipped"; continue; }
    if has_server "$client"; then
      say "$client: already has an MCP server named browser; left as it is"
      continue
    fi
    add_command "$client"
    "${cmd[@]}" >/dev/null || die "$client: adding the server failed"
    echo "$client" >>"$dir/.clients"
    say "$client: added as browser"
  done
}

print_commands() {
  local client cmd
  echo
  echo "Add it to a client (or run install with --client claude,codex,pi):"
  for client in claude codex pi; do
    add_command "$client"
    printf '  %s\n' "$(printf '%q ' "${cmd[@]}")"
  done
}

case "$command_name" in
  install)
    need_tools git node npm docker curl
    [[ ! -e "$dir" ]] || die "$dir exists: use update, or uninstall first"
    stage="$dir.new"
    fetch_and_build "$stage"
    check_hosts "$hosts" "$stage"
    (
      umask 077
      printf 'BROWSER_PASSWORD=%s\nBROWSER_ALLOWED_HOSTS=%s\n' "$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)" "$hosts" >"$stage/docker/.env"
    )
    mv "$stage" "$dir"
    sync_profiles
    start_stack || die "installed in $dir, but the browser is not up: fix it, then uninstall and install again"
    register_clients
    say "installed $(installed_version) in $dir"
    say "browser desktop: https://127.0.0.1:3101 (user agent, password in $dir/docker/.env)"
    say "allowed hosts: ${hosts:-any}"
    if [[ "$clients" == none ]]; then print_commands; fi
    ;;
  check)
    need_tools git node
    [[ -f "$dir/package.json" ]] || die "not installed in $dir"
    now="$(installed_version)"
    newest="$(latest_tag)"
    [[ -n "$newest" ]] || die "no release tag found in $repo"
    commit="$(installed_commit)"
    if [[ -n "$commit" ]]; then
      # The same version string can be on a different commit (a tag moved, or an install from a branch): the commits decide.
      newest_commit="$(tag_commit "$newest")"
      [[ -n "$newest_commit" ]] || die "could not read the commit of $newest from $repo"
      if [[ "$commit" == "$newest_commit" ]]; then
        say "up to date ($now, ${commit:0:12})"
      else
        say "installed $now (${commit:0:12}), newest $newest (${newest_commit:0:12}): run update"
      fi
    elif [[ "v$now" == "$newest" ]]; then say "up to date ($now)"; else say "installed $now, newest $newest: run update"; fi
    ;;
  update)
    need_tools git node npm docker curl
    [[ -f "$dir/docker/.env" ]] || die "not installed in $dir"
    stage="$dir.new"
    fetch_and_build "$stage"
    cp -p "$dir/docker/.env" "$stage/docker/.env"
    [[ ! -f "$dir/.clients" ]] || cp -p "$dir/.clients" "$stage/.clients"
    [[ ! -d "$dir/profiles" ]] || cp -pR "$dir/profiles" "$stage/profiles"
    [[ ! -f "$dir/.kept-profiles" ]] || cp -p "$dir/.kept-profiles" "$stage/.kept-profiles"
    rm -rf "$dir.old"
    mv "$dir" "$dir.old"
    mv "$stage" "$dir"
    sync_profiles
    if ! start_stack default; then
      rm -rf "$dir" && mv "$dir.old" "$dir" && compose up -d >/dev/null 2>&1 || true
      die "the new release did not start; the previous one is back"
    fi
    rm -rf "$dir.old"
    for n in $(profile_names); do
      [[ "$n" == default ]] || start_stack "$n" || say "profile $n did not start: fix it, then run: install.sh profile list"
    done
    say "updated to $(installed_version); restart your MCP clients to load it"
    ;;
  uninstall)
    [[ -d "$dir" ]] || die "not installed in $dir"
    all="$(profile_names | tr '\n' ' ')"
    kept="$(kept_names | tr '\n' ' ')"
    if $purge && [[ "$all$kept" != "default " ]] && ! $yes; then
      die "uninstall --purge would delete the sessions (volumes) of every profile: ${all% }${kept:+, and of the removed profiles ${kept% }}. Run it again with --yes to confirm, or remove profiles one by one with: profile remove <name> --purge"
    fi
    failed=""
    if [[ -f "$dir/docker/compose.yaml" ]] && command -v docker >/dev/null 2>&1; then
      for n in $(profile_names); do
        if $purge; then pcompose "$n" down -v >/dev/null 2>&1 || failed+="$n "; else pcompose "$n" down >/dev/null 2>&1 || true; fi
      done
      if $purge; then
        for n in $kept; do drop_volumes "$n" || failed+="$n "; done
      fi
    elif $purge; then
      failed="$all$kept"
    fi
    if [[ -f "$dir/.clients" ]]; then
      while read -r client; do
        case "$client" in
          claude) claude mcp remove -s user browser >/dev/null 2>&1 || true ;;
          codex) codex mcp remove browser >/dev/null 2>&1 || true ;;
          pi) pi mcp remove browser >/dev/null 2>&1 || true ;;
        esac
        say "$client: removed browser"
      done <"$dir/.clients"
    fi
    rm -rf "$dir"
    if $purge; then
      say "removed $dir; sessions deleted for: $(echo "$all$kept" | tr ' ' '\n' | grep -vxF -f <(echo "$failed" | tr ' ' '\n') | grep . | tr '\n' ' ')"
      [[ -z "${failed// /}" ]] || die "could not delete the sessions (docker volumes) of: ${failed% }; delete them with docker volume rm"
    else
      say "removed $dir; the browser profiles (docker volumes) are kept: uninstall --purge removes them"
    fi
    ;;
  profile)
    case "$profile_cmd" in
      add)
        check_profile_name "$profile_name"
        need_tools node docker curl
        [[ -f "$dir/docker/.env" ]] || die "not installed in $dir"
        [[ ! -e "$dir/profiles/$profile_name" ]] || die "profile $profile_name exists (profile list shows it)"
        check_hosts "$hosts" "$dir"
        if is_kept "$profile_name"; then say "profile $profile_name: its kept sessions (docker volume) are used again"; fi
        web="$(pick_port BROWSER_WEB_PORT 3101)"
        cdp="$(pick_port BROWSER_CDP_PORT 9322)"
        stream="$(pick_port BROWSER_STREAM_PORT 8082)"
        (
          umask 077
          mkdir -p "$dir/profiles/$profile_name"
          printf 'BROWSER_PASSWORD=%s\nBROWSER_ALLOWED_HOSTS=%s\nBROWSER_WEB_PORT=%s\nBROWSER_CDP_PORT=%s\nBROWSER_STREAM_PORT=%s\n' \
            "$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)" "$hosts" "$web" "$cdp" "$stream" >"$dir/profiles/$profile_name/.env"
        )
        forget_kept "$profile_name"
        sync_profiles
        if ! start_stack "$profile_name"; then
          pcompose "$profile_name" down -v >/dev/null 2>&1 || true
          rm -rf "$dir/profiles/$profile_name"
          sync_profiles
          die "profile $profile_name did not start, and was removed again"
        fi
        say "profile $profile_name: browser desktop https://127.0.0.1:$web (user agent, password in $dir/profiles/$profile_name/.env), CDP 127.0.0.1:$cdp"
        say "allowed hosts: ${hosts:-any}; restart your MCP clients to learn the new profile"
        ;;
      list)
        [[ -f "$dir/docker/.env" ]] || die "not installed in $dir"
        printf '%-26s %-8s %-6s %-7s %-9s %s\n' PROFILE DESKTOP CDP STREAM STATE HOSTS
        for n in $(profile_names); do
          state=unknown
          if command -v docker >/dev/null 2>&1; then
            if [[ -n "$(pcompose "$n" ps --status running -q browser 2>/dev/null || true)" ]]; then state=running; else state=stopped; fi
          fi
          printf '%-26s %-8s %-6s %-7s %-9s %s\n' "$n" "$(profile_value "$n" BROWSER_WEB_PORT 3101)" "$(profile_value "$n" BROWSER_CDP_PORT 9322)" "$(profile_value "$n" BROWSER_STREAM_PORT 8082)" "$state" "$(profile_value "$n" BROWSER_ALLOWED_HOSTS "" | sed 's/^$/any/')"
        done
        ;;
      remove)
        [[ -n "$profile_name" ]] || die "profile remove needs a name"
        [[ "$profile_name" =~ $PROFILE_RE ]] || die "profile: '$profile_name' is not a valid name"
        [[ "$profile_name" != default ]] || die "profile: default is the install's own browser; uninstall removes it"
        need_tools docker
        if [[ -f "$dir/profiles/$profile_name/.env" ]]; then
          if $purge; then pcompose "$profile_name" down -v || die "profile $profile_name: could not delete its sessions"; else pcompose "$profile_name" down; fi
          rm -rf "$dir/profiles/$profile_name"
          sync_profiles
          if $purge; then
            say "profile $profile_name removed with its sessions"
          else
            remember_kept "$profile_name"
            say "profile $profile_name removed; its sessions (docker volume) are kept: profile add $profile_name brings them back, profile remove $profile_name --purge deletes them"
          fi
        elif $purge && is_kept "$profile_name"; then
          drop_volumes "$profile_name" || die "profile $profile_name: could not delete its sessions (docker volume rm)"
          forget_kept "$profile_name"
          say "profile $profile_name: its kept sessions are deleted"
        else
          die "no profile named $profile_name (profile list shows them)$($purge && echo '; no kept sessions of that name either')"
        fi
        ;;
    esac
    ;;
esac
