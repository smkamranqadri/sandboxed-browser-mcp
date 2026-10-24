#!/usr/bin/env bash
# Installs sandboxed-browser-mcp: fetches a tagged release, builds it, starts the browser stack (docker/compose.yaml)
# and, if asked, adds the server to Codex, Claude Code or pi.
#
#   curl -fsSL https://raw.githubusercontent.com/smkamranqadri/sandboxed-browser-mcp/main/install.sh | bash -s -- install
#
# The browser's password is generated into docker/.env (mode 600) and never printed. Any host is allowed unless
# --hosts is given. An update keeps docker/.env, the client registrations and the browser profile (signed-in sessions).
set -euo pipefail
# Lists like --hosts '*.example.org' are split, never matched against files here.
set -f

usage() {
  cat <<'EOF'
Usage: install.sh <install|check|update|uninstall> [options]

Commands:
  install    Fetch, build, start the browser stack, and add the server to the clients named by --client.
  check      Say whether a newer release exists.
  update     Install the newest release (or --ref) over the current one; keeps docker/.env and the browser profile.
  uninstall  Stop the stack, remove the client entries this script added, and delete the install directory.

Options:
  --hosts <list>     Allowed hosts, comma-separated (docs.example.com,*.example.org). Default: any host. (install)
  --client <list>    claude, codex, pi, comma-separated, or none (default): print the commands instead. (install)
  --ref <tag>        Release tag to install. Default: the newest v* tag.
  --dir <path>       Install directory. Default: ${XDG_DATA_HOME:-~/.local/share}/sandboxed-browser-mcp
  --repo <git-url>   Repository to fetch. Default: https://github.com/smkamranqadri/sandboxed-browser-mcp.git
  --source <path>    A local checkout to install instead of fetching (its working tree, ignored files left out).
  --purge            With uninstall: also delete the browser profile (the stack's volumes).
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
  install | check | update | uninstall) ;;
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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts) [[ $# -ge 2 ]] || die "--hosts needs a list"; hosts="$2"; shift 2 ;;
    --client) [[ $# -ge 2 ]] || die "--client needs a list"; clients="$2"; shift 2 ;;
    --ref) [[ $# -ge 2 ]] || die "--ref needs a tag"; ref="$2"; shift 2 ;;
    --dir) [[ $# -ge 2 ]] || die "--dir needs a path"; dir="$2"; shift 2 ;;
    --repo) [[ $# -ge 2 ]] || die "--repo needs a git URL"; repo="$2"; shift 2 ;;
    --source) [[ $# -ge 2 ]] || die "--source needs a path"; source_dir="$2"; shift 2 ;;
    --purge) purge=true; shift ;;
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

start_stack() {
  compose up -d --quiet-pull >/dev/null 2>&1 || { compose up -d; say "the browser stack did not start"; return 1; }
  local port
  port="$(sed -n 's/^BROWSER_CDP_PORT=//p' "$dir/docker/.env")"
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${port:-9322}/json/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  say "the browser did not answer on 127.0.0.1:${port:-9322} within 60 s (docker compose -f $dir/docker/compose.yaml logs)"
  return 1
}

# The command that adds the server to client $1, into the array `cmd` (bash 3.2 has no mapfile).
add_command() {
  local env=()
  [[ -z "$hosts" ]] || env=("BROWSER_ALLOWED_HOSTS=$hosts")
  case "$1" in
    claude) cmd=(claude mcp add -s user browser) ;;
    codex) cmd=(codex mcp add browser) ;;
    pi) cmd=(pi mcp add browser --exposure direct) ;;
  esac
  if [[ ${#env[@]} -gt 0 && "$1" == claude ]]; then cmd+=(-e "${env[0]}"); elif [[ ${#env[@]} -gt 0 ]]; then cmd+=(--env "${env[0]}"); fi
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
    rm -rf "$dir.old"
    mv "$dir" "$dir.old"
    mv "$stage" "$dir"
    if ! start_stack; then
      rm -rf "$dir" && mv "$dir.old" "$dir" && compose up -d >/dev/null 2>&1 || true
      die "the new release did not start; the previous one is back"
    fi
    rm -rf "$dir.old"
    say "updated to $(installed_version); restart your MCP clients to load it"
    ;;
  uninstall)
    [[ -d "$dir" ]] || die "not installed in $dir"
    if [[ -f "$dir/docker/compose.yaml" ]] && command -v docker >/dev/null 2>&1; then
      if $purge; then compose down -v >/dev/null 2>&1 || true; else compose down >/dev/null 2>&1 || true; fi
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
    say "removed $dir$($purge && echo ' and the browser profile' || echo '; the browser profile (docker volumes) is kept: uninstall --purge removes it')"
    ;;
esac
