#!/usr/bin/env bash
# digg installer — downloads a prebuilt binary from GitHub Releases.
#   curl -fsSL https://raw.githubusercontent.com/notshekhar/digg/main/install.sh | bash
#
# Layout after install:
#   $DIGG_HOME/               (default: ~/.digg-bin)
#     ├── digg                (standalone binary; reads your kubeconfig directly)
#     └── package.json
#   $BIN_DIR/digg → $DIGG_HOME/digg   (symlink on PATH)
#
# Env knobs:
#   DIGG_REPO_SLUG  notshekhar/digg      override repo
#   DIGG_VERSION    vX.Y.Z               pin a tag
#   DIGG_HOME       $HOME/.digg-bin      install dir
#   DIGG_BIN_DIR                         symlink dir (auto-detected)
#   DIGG_FORCE      1                    skip "already up to date" gate
#   DIGG_UNINSTALL  1                    remove install + symlink and exit

set -euo pipefail

REPO_SLUG="${DIGG_REPO_SLUG:-notshekhar/digg}"
DIGG_HOME="${DIGG_HOME:-$HOME/.digg-bin}"
FORCE="${DIGG_FORCE:-0}"
UNINSTALL="${DIGG_UNINSTALL:-0}"
PIN_VERSION="${DIGG_VERSION:-}"

# GitHub serves release files from several CDN addresses, and one of them can
# be unreachable from a given network (measured 2026-11-14: 185.199.109.133
# never answered while its three siblings connected in 10ms). With no connect
# timeout curl waits the OS's full 75s on a dead address before trying the
# next, once per request. curl gives the first address half this budget, so a
# dead one now costs ~5s.
CONNECT_TIMEOUT=10
fetch() { curl --connect-timeout "$CONNECT_TIMEOUT" "$@"; }

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
dim()  { printf "\033[2m%s\033[0m\n" "$*"; }
err()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

need_tool() { command -v "$1" >/dev/null 2>&1 || { err "Missing required tool: $1"; exit 1; }; }

# ── Download progress bar ─────────────────────────────────────────────────
# Download in the background and draw a ■■■･･･ 42% bar from how big the output
# file has grown. Only used when stderr is a TTY; anything else (or any
# failure) falls back to plain curl in the caller.
#
# It used to read curl's --trace-ascii stream instead, which meant curl wrote a
# hex+ascii transcript of EVERY BYTE of the tarball into a FIFO and bash parsed
# the ~100MB that came out, one `read` at a time. That turned a 5-second
# download into 82 (measured, 27MB over a fast link) and left the bar sitting
# at 0% for the first stretch — indistinguishable from a hang, on the one path
# every upgrade takes. Polling a file size costs nothing per frame.
#
# The total comes from the download's own response headers (curl -D), not a
# separate HEAD request: each request is another connect, and on a network
# with a dead CDN address another wait before the bar appears.

PROGRESS_COLOR='\033[38;5;215m'
PROGRESS_NC='\033[0m'

# Bytes in a file, or empty if it isn't there yet. stat's flags differ by libc.
file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo ""
}

# Content-Length of the last response in a curl -D header dump — after
# redirects, that is the file itself. Empty when the server didn't say.
header_length() {
  tr -d '\r' < "$1" 2>/dev/null \
    | awk 'tolower($1) == "content-length:" {n=$2} END{if (n+0 > 0) print n}'
}

print_progress() {
  local bytes="$1" length="$2"
  local width=50

  if [ "${length:-0}" -le 0 ]; then
    # No total to divide by: show what has arrived rather than a fake bar.
    printf "\r${PROGRESS_COLOR}  %s MB${PROGRESS_NC}" "$(( bytes / 1048576 ))" >&4
    return 0
  fi

  local percent=$(( bytes * 100 / length ))
  [ "$percent" -gt 100 ] && percent=100
  local on=$(( percent * width / 100 ))
  local off=$(( width - on ))

  local filled=$(printf "%*s" "$on" "")
  filled=${filled// /■}
  local empty=$(printf "%*s" "$off" "")
  empty=${empty// /･}

  printf "\r${PROGRESS_COLOR}%s%s %3d%%${PROGRESS_NC}" "$filled" "$empty" "$percent" >&4
}

download_with_progress() {
  local url="$1" output="$2"

  if [ -t 2 ]; then
    exec 4>&2
  else
    exec 4>/dev/null
  fi

  local headers="${output}.headers" donefile="${output}.done"
  # Hide the cursor while the bar redraws; always restore it on the way out.
  printf "\033[?25l" >&4
  trap "trap - RETURN; rm -f \"$donefile\" \"$headers\"; printf '\033[?25h' >&4; exec 4>&-" RETURN

  # -f so an HTTP error fails the download (and the caller's fallback runs)
  # instead of writing a 404 page to the output file. The exit status lands in
  # a file rather than being polled for: a finished background child is a
  # zombie until it is waited on, and `kill -0` on a zombie still succeeds, so
  # watching the pid is a loop that never ends.
  rm -f "$donefile" "$headers"
  { fetch -f -s -L -D "$headers" -o "$output" "$url"; echo "$?" > "$donefile"; } &

  local bytes length=""
  while [ ! -s "$donefile" ]; do
    bytes="$(file_size "$output")"
    # The final response's headers land before its first body byte, so once
    # bytes arrive the last Content-Length in the dump is the file's.
    if [ -n "$bytes" ]; then
      [ -z "$length" ] && length="$(header_length "$headers")"
      print_progress "$bytes" "${length:-0}"
    fi
    sleep 0.1
  done

  wait
  local ret
  ret="$(cat "$donefile" 2>/dev/null || echo 1)"
  # Land the bar on the real final size rather than wherever the last poll got.
  if [ "$ret" -eq 0 ]; then
    bytes="$(file_size "$output")"
    [ -n "$bytes" ] && print_progress "$bytes" "${length:-$bytes}"
  fi
  echo "" >&4
  return $ret
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else err "missing sha256sum/shasum"; return 1; fi
}

ver_gt() {
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 1
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) err "Windows: use install.ps1 — irm https://raw.githubusercontent.com/${REPO_SLUG}/main/install.ps1 | iex"; exit 1 ;;
    *) err "unsupported OS: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) err "unsupported arch: $(uname -m)"; exit 1 ;;
  esac
  printf "%s-%s" "$os" "$arch"
}

resolve_latest_tag() {
  local final tag
  final="$(fetch -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO_SLUG}/releases/latest" 2>/dev/null || true)"
  tag="${final##*/}"
  case "$tag" in v[0-9]*) printf "%s" "$tag" ;; esac
}

resolve_bin_dir() {
  if [ -n "${DIGG_BIN_DIR:-}" ]; then mkdir -p "$DIGG_BIN_DIR"; printf "%s" "$DIGG_BIN_DIR"; return; fi
  for d in /usr/local/bin /opt/homebrew/bin; do
    [ -w "$d" ] 2>/dev/null && { printf "%s" "$d"; return; }
  done
  local fallback="$HOME/.local/bin"; mkdir -p "$fallback"; printf "%s" "$fallback"
}

uninstall() {
  bold "▶ Uninstalling digg"
  for link in "$HOME/.local/bin/digg" "/usr/local/bin/digg" "/opt/homebrew/bin/digg" \
              "${DIGG_BIN_DIR:+$DIGG_BIN_DIR/digg}"; do
    [ -n "$link" ] || continue
    { [ -L "$link" ] || [ -f "$link" ]; } && rm -f "$link" 2>/dev/null && dim "  removed $link" || true
  done
  rm -rf "$DIGG_HOME" 2>/dev/null && dim "  removed $DIGG_HOME" || true
  bold "✓ Uninstalled."
}

main() {
  [ "$UNINSTALL" = "1" ] && { uninstall; exit 0; }

  bold "▶ digg installer"
  need_tool curl; need_tool tar
  # digg talks to the API server itself; kubectl is not a runtime dependency.
  # A missing kubeconfig is the thing that actually stops it working.
  [ -n "${KUBECONFIG:-}" ] || [ -f "$HOME/.kube/config" ] || \
    dim "  note: no kubeconfig found — digg needs one to reach a cluster."

  local target latest installed
  target="$(detect_target)"
  dim "  target: $target"

  latest="${PIN_VERSION:-$(resolve_latest_tag)}"
  if [ -z "$latest" ]; then
    err "could not resolve latest release tag from $REPO_SLUG"
    err "set DIGG_VERSION=vX.Y.Z to pin a release"
    exit 1
  fi
  case "$latest" in v*) ;; *) latest="v$latest" ;; esac

  installed=""
  [ -f "$DIGG_HOME/package.json" ] && \
    installed="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DIGG_HOME/package.json" | head -n1 || true)"
  if [ "$FORCE" != "1" ] && [ -n "$installed" ] && ! ver_gt "${latest#v}" "${installed#v}"; then
    bold "✓ Up to date (installed $installed, latest $latest)"
    dim "  DIGG_FORCE=1 to reinstall"
    exit 0
  fi

  local scratch tar url base
  scratch="${DIGG_HOME}.new.$$"
  trap 'rm -rf "$scratch" 2>/dev/null || true' EXIT
  mkdir -p "$scratch"

  base="https://github.com/${REPO_SLUG}/releases/download/${latest}"
  url="${base}/digg-${target}.tar.gz"
  tar="$scratch/digg.tar.gz"

  bold "▶ Downloading ${url##*/}"
  # The bar needs a terminal; without one, or if it fails, plain curl.
  { [ -t 2 ] && download_with_progress "$url" "$tar"; } \
    || fetch -fL --progress-bar "$url" -o "$tar" \
    || { err "download failed: $url"; exit 1; }

  if fetch -fsSL "${url}.sha256" -o "$scratch/sum" 2>/dev/null && [ -s "$scratch/sum" ]; then
    local expected got
    expected="$(awk '{print $1}' "$scratch/sum")"
    got="$(sha256_of "$tar")"
    [ "$expected" = "$got" ] || { err "sha256 mismatch"; exit 1; }
    dim "  sha256 ok"
  fi

  bold "▶ Extracting"
  tar -xzf "$tar" -C "$scratch"
  [ -x "$scratch/$target/digg" ] || { err "tarball missing $target/digg"; exit 1; }

  if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$scratch/$target" 2>/dev/null || true
  fi

  bold "▶ Installing to $DIGG_HOME"
  [ -e "$DIGG_HOME" ] && rm -rf "${DIGG_HOME}.old.$$" && mv "$DIGG_HOME" "${DIGG_HOME}.old.$$"
  mv "$scratch/$target" "$DIGG_HOME"
  rm -rf "${DIGG_HOME}.old.$$" 2>/dev/null || true
  trap - EXIT
  rm -rf "$scratch" 2>/dev/null || true

  local bin_dir; bin_dir="$(resolve_bin_dir)"
  ln -sf "$DIGG_HOME/digg" "$bin_dir/digg"
  hash -r 2>/dev/null || true

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) err "warning: $bin_dir is not on PATH — add it to your shell rc" ;;
  esac

  "$DIGG_HOME/digg" --version >/dev/null 2>&1 || { err "installed binary failed to run"; exit 1; }
  bold "✓ Installed digg $latest → $bin_dir/digg"
}

main "$@"
