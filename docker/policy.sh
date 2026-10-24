#!/bin/sh
# Writes BROWSER_ALLOWED_HOSTS as a Chromium managed policy, so that the browser itself refuses navigations and frames
# to any other host, whether or not the MCP server's guard (src/navguard.ts) is connected: while its CDP connection is
# down (the relay or the browser restarting), the policy still holds. Chromium reloads the file within seconds.
#
# Same list as the MCP server's: comma-separated host names; `*.example.com` for its subdomains. In the policy that
# becomes `example.com`, which also allows example.com itself (the policy format has no "subdomains only"): the
# server's guard still refuses it. A plain host allows that host only. Empty, or a lone `*`, writes no policy (any host).
#
# An entry that is not a host name writes a policy that allows nothing and exits 1, so that a typo blocks rather than
# opens the browser.
#
# Usage: BROWSER_ALLOWED_HOSTS=... POLICY_DIR=/policies sh policy.sh
set -eu
# The list is split on commas unquoted: `*` must stay a word, not the files here.
set -f

dir="${POLICY_DIR:-/policies}"
file="$dir/sandboxed-browser-mcp.json"
mkdir -p "$dir"

write() {
  printf '{"URLBlocklist":["*"],"URLAllowlist":["about:blank"%s]}\n' "$1" > "$file.tmp"
  chmod 644 "$file.tmp"
  mv "$file.tmp" "$file"
}

allow=""
any=no
entries=0
old_ifs=$IFS
IFS=,
for raw in ${BROWSER_ALLOWED_HOSTS:-}; do
  IFS=$old_ifs
  host=$(printf '%s' "$raw" | tr 'A-Z' 'a-z' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  host=${host%.}
  [ -z "$host" ] && continue
  entries=$((entries + 1))
  if [ "$host" = "*" ]; then
    any=yes
    continue
  fi
  case "$host" in
    \*.*) name=${host#\*.} pattern=${host#\*.} ;;
    *) name=$host pattern=".$host" ;;
  esac
  case "$name" in
    "" | .* | *. | *..* | *[!a-z0-9.-]*)
      write ""
      echo "policy.sh: \"$raw\" is not a host name; wrote a policy that allows nothing" >&2
      exit 1
      ;;
  esac
  allow="$allow,\"$pattern\""
done
IFS=$old_ifs

if [ "$entries" -eq 0 ] || [ "$any" = yes ]; then
  rm -f "$file"
  echo "policy.sh: any host allowed (no policy)"
else
  write "$allow"
  echo "policy.sh: allowed: $allow"
fi
