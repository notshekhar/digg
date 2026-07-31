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

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
dim()  { printf "\033[2m%s\033[0m\n" "$*"; }
err()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

need_tool() { command -v "$1" >/dev/null 2>&1 || { err "Missing required tool: $1"; exit 1; }; }

# ── Download progress bar ──────────────────────────────────────────────────
# A ■■■･･･ 42% bar driven by the size of the file on disk, which is the only
# unambiguous measure of how much has actually arrived. TTY only — anything
# else falls back to plain curl.
#
# This replaces a version that parsed `curl --trace-ascii` out of a FIFO. That
# had three problems. It wrote an 11MB trace to disk for a 10MB download. It
# needed a sed that could line-buffer, with a padding hack for ones that could
# not. And it counted `<= recv data` records, which are socket reads rather
# than body bytes — so the bar hit 100% while the transfer was still running,
# and on a slow link that is indistinguishable from a hang.
#
# The rate is shown for the same reason: a slow network should read as slow.

PROGRESS_COLOR='\033[38;5;215m'
PROGRESS_NC='\033[0m'

file_size() {
  [ -f "$1" ] || { echo 0; return; }
  wc -c < "$1" 2>/dev/null | tr -d ' '
}

# The asset's real size, after redirects — the last content-length in the
# chain. Costs one HEAD (~0.5s) and is what gives the bar an honest
# denominator; 0 when the server will not say, and the bar then just counts up.
remote_size() {
  curl -fsIL "$1" 2>/dev/null | tr -d '\r' \
    | awk 'tolower($1) == "content-length:" { n = $2 } END { if (n ~ /^[0-9]+$/) print n; else print 0 }'
}

print_progress() {
  local bytes="$1" length="$2" secs="$3"
  local width=42 percent=0
  [ "$length" -gt 0 ] && percent=$(( bytes * 100 / length ))
  [ "$percent" -gt 100 ] && percent=100
  local on=$(( percent * width / 100 ))
  local off=$(( width - on ))
  local filled empty
  filled=$(printf "%*s" "$on" ""); filled=${filled// /■}
  empty=$(printf "%*s" "$off" ""); empty=${empty// /･}
  awk -v f="$filled" -v e="$empty" -v p="$percent" -v b="$bytes" -v s="$secs" \
      -v c="$PROGRESS_COLOR" -v n="$PROGRESS_NC" 'BEGIN {
        rate = (s > 0) ? sprintf("  %.1f MB/s", b / s / 1048576) : ""
        printf "\r%s%s%s %3d%%%s  %.1f MB%s ", c, f, e, p, n, b / 1048576, rate
      }' >&4
}

download_with_progress() {
  local url="$1" output="$2"
  if [ -t 2 ]; then exec 4>&2; else exec 4>/dev/null; fi

  local length; length="$(remote_size "$url")"

  printf "\033[?25l" >&4
  trap "trap - RETURN; printf '\033[?25h' >&4; exec 4>&-" RETURN

  curl -fL -s -o "$output" "$url" &
  local curl_pid=$! start now
  start="$(date +%s)"

  while kill -0 "$curl_pid" 2>/dev/null; do
    now="$(date +%s)"
    print_progress "$(file_size "$output")" "$length" "$(( now - start ))"
    sleep 0.2
  done

  wait "$curl_pid"
  local ret=$?
  if [ "$ret" -eq 0 ]; then
    now="$(date +%s)"
    # Finish on the real size, so the bar always lands on 100% rather than
    # stopping at whatever the last poll happened to catch.
    local final; final="$(file_size "$output")"
    print_progress "$final" "$final" "$(( now - start ))"
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
  final="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
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
  # The bar needs a FIFO and a terminal; where either is missing, plain curl.
  download_with_progress "$url" "$tar" \
    || curl -fL --progress-bar "$url" -o "$tar" \
    || { err "download failed: $url"; exit 1; }

  if curl -fsSL "${url}.sha256" -o "$scratch/sum" 2>/dev/null && [ -s "$scratch/sum" ]; then
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
