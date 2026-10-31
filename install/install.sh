#!/usr/bin/env bash
# install.sh — install, update or remove orca-openbot (Linux).
# Idempotent: rerun to update. Prints the command to set in Orca for Pi.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${OPENBOT_ORCA_PREFIX:-${OPENBOT_HERDR_PREFIX:-$HOME/.local}}"
MARKER='managed-by: orca-openbot install.sh'
SHARE_MARKER='.managed-by-orca-openbot'
RUNTIME='package.json LICENSE bin core events control pi'
OPTIONAL='README.md CHANGELOG.md'
MIN_NODE=20
DRY_RUN=0
UNINSTALL=0
PURGE=0
FORCE=0

usage() {
  cat <<'USAGE'
Usage: install.sh [--prefix DIR] [--dry-run] [--force]
       install.sh --uninstall [--purge] [--prefix DIR] [--dry-run]

Installs (or updates) orca-openbot, links the command and prints the value for
Orca > Ajustes > Agentes > Pi > Comando.
  --prefix DIR  install root (default: ~/.local; env OPENBOT_ORCA_PREFIX)
                runtime -> DIR/share/orca-openbot, command -> DIR/bin/orca-openbot
  --dry-run     print what would change; write nothing
  --force       replace files this installer did not create
  --uninstall   remove the runtime and the command
  --purge       with --uninstall, also delete config.env and local state
Exit: 0 ok, 1 dependency/target problem, 4 bad arguments.
USAGE
}

while (( $# > 0 )); do
  case "$1" in
    --prefix)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'install: --prefix needs a directory\n' >&2; exit 4; }
      PREFIX="$2"
      shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'install: unknown argument: %s\n' "$1" >&2; usage >&2; exit 4 ;;
  esac
done
if (( PURGE && !UNINSTALL )); then
  printf 'install: --purge requires --uninstall\n' >&2
  exit 4
fi

case "$PREFIX" in
  /*) ;;
  *) PREFIX="$(pwd -P)/$PREFIX" ;;
esac
PREFIX="$(realpath -m -- "$PREFIX")"

SHARE="$PREFIX/share/orca-openbot"
BIN="$PREFIX/bin"
CMD="$BIN/orca-openbot"

# New name wins; the old OPENBOT_HERDR_* name is read for one release.
CONFIG_FILE_OVERRIDE="${OPENBOT_ORCA_CONFIG_FILE:-${OPENBOT_HERDR_CONFIG_FILE:-}}"
STATE_OVERRIDE="${OPENBOT_ORCA_STATE_DIR:-${OPENBOT_HERDR_STATE_DIR:-}}"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}"
if [[ -n "$CONFIG_FILE_OVERRIDE" ]]; then
  CONFIG="$CONFIG_FILE_OVERRIDE"
else
  CONFIG="$CONFIG_ROOT/orca-openbot/config.env"
fi
# Old config location (migrated once when the new one is absent).
OLD_CONFIG="$CONFIG_ROOT/herdr-openbot/config.env"
if [[ -n "$STATE_OVERRIDE" ]]; then
  STATE="$STATE_OVERRIDE"
else
  STATE="${XDG_STATE_HOME:-$HOME/.local/state}/orca-openbot"
fi

problems=0
problem() {
  printf 'install: %s\n' "$*" >&2
  problems=$((problems + 1))
}

# act DESCRIPTION CMD...: run CMD, or only describe it under --dry-run.
act() {
  local what="$1"
  shift
  if (( DRY_RUN )); then
    printf '[dry-run] %s\n' "$what"
  else
    "$@"
    printf '%s\n' "$what"
  fi
}

# Swap the staged runtime in; INSTALLED_COMMIT of the previous copy is restored if the copy fails.
swap_share() {
  local st=0
  mkdir -p "$(dirname "$SHARE")" && rm -rf "$SHARE" && cp -R "$STAGE/share" "$SHARE" || st=$?
  if [[ -n "${aside-}" && ! -f "$SHARE/INSTALLED_COMMIT" ]]; then
    mkdir -p "$SHARE" && cp "$aside" "$SHARE/INSTALLED_COMMIT" || st=$?
  fi
  if [[ -n "${aside-}" && -f "$SHARE/INSTALLED_COMMIT" ]]; then
    rm -f "$aside"
  fi
  return "$st"
}

# version_ge A B: true when dotted version A >= B (numeric parts, suffixes ignored).
version_ge() {
  local a="$1" b="$2" i x y
  local IFS=.
  # shellcheck disable=SC2206 # intentional split on dots
  local pa=(${a%%[!0-9.]*}) pb=(${b%%[!0-9.]*})
  for i in 0 1 2; do
    x="${pa[i]:-0}"
    y="${pb[i]:-0}"
    if (( 10#$x > 10#$y )); then return 0; fi
    if (( 10#$x < 10#$y )); then return 1; fi
  done
  return 0
}

NODE="${OPENBOT_ORCA_NODE:-${OPENBOT_HERDR_NODE:-$(command -v node || true)}}"
check_node() {
  local ver
  if [[ -z "$NODE" ]] || ! ver="$("$NODE" -p 'process.versions.node' 2>/dev/null)"; then
    problem "node $MIN_NODE+ not found (set OPENBOT_ORCA_NODE or add node to PATH)"
  elif ! version_ge "$ver" "$MIN_NODE"; then
    problem "node $MIN_NODE+ required (found $ver at $NODE)"
  else
    NODE="$(command -v "$NODE")"
    # The wrapper runs from any directory: store an absolute path.
    case "$NODE" in
      /*) ;;
      *) NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")" ;;
    esac
    printf 'ok   node %s (%s)\n' "$ver" "$NODE"
  fi
}

# The command is ours if missing or a symlink to this runtime's entrypoint.
is_managed() {
  [[ ! -e "$1" && ! -L "$1" ]] || [[ "$(readlink "$1" 2>/dev/null)" == */share/orca-openbot/bin/orca-openbot.js ]]
}

check_target() {
  is_managed "$1" && return 0
  if (( FORCE )); then
    printf 'warn %s is not managed; replacing (--force)\n' "$1"
  else
    problem "$1 exists and was not created by this installer (rerun with --force to replace)"
  fi
}

check_share() {
  [[ -e "$SHARE" ]] || return 0
  [[ -f "$SHARE/$SHARE_MARKER" ]] && return 0
  if (( FORCE )); then
    printf 'warn %s is not managed; replacing (--force)\n' "$SHARE"
  else
    problem "$SHARE exists and was not created by this installer (rerun with --force to replace)"
  fi
}

write_config_template() {
  mkdir -p "$(dirname "$CONFIG")"
  chmod 700 "$(dirname "$CONFIG")" 2>/dev/null || true
  (umask 077 && cat >"$CONFIG" <<'TEMPLATE'
# orca-openbot configuration. Keep this file private (0600).
# Environment variables with the same names take precedence.
OPENBOT_ORCA_WEBHOOK_URL=
# OpenBot signing secret (whsec_ + 43 characters). Paste it with an editor, never with echo
# (shell history and process lists would keep it).
OPENBOT_ORCA_WEBHOOK_SECRET=
# Optional short name for this machine, e.g. escritorio or notebook.
#OPENBOT_ORCA_MACHINE_LABEL=
# Positive finite integer milliseconds for every webhook request (default 30000).
OPENBOT_ORCA_TIMEOUT_MS=30000
TEMPLATE
  )
  chmod 600 "$CONFIG"
}

# Same webhook and secret as the old herdr-openbot config; the old file is left in place.
migrate_config() {
  mkdir -p "$(dirname "$CONFIG")"
  chmod 700 "$(dirname "$CONFIG")" 2>/dev/null || true
  (umask 077 && cp "$OLD_CONFIG" "$CONFIG")
  chmod 600 "$CONFIG"
}

# Value for Orca > Ajustes > Agentes > Pi > Comando.
pi_command() {
  printf 'gentle-shell -- -e %s\n' "$SHARE/pi/orca-openbot-attention.ts"
}

# --- uninstall

if (( UNINSTALL )); then
  for f in "$CMD"; do
    [[ -e "$f" || -L "$f" ]] || continue
    if is_managed "$f" || (( FORCE )); then
      act "removed $f" rm -f "$f"
    else
      problem "$f was not created by this installer; left in place (use --force)"
    fi
  done
  if [[ -e "$SHARE" ]]; then
    if [[ -f "$SHARE/$SHARE_MARKER" ]] || (( FORCE )); then
      act "removed $SHARE" rm -rf "$SHARE"
    else
      problem "$SHARE was not created by this installer; left in place (use --force)"
    fi
  fi
  if (( PURGE )); then
    [[ ! -e "$CONFIG" ]] || act "removed $CONFIG" rm -f "$CONFIG"
    [[ ! -e "$STATE" ]] || act "removed $STATE" rm -rf "$STATE"
  elif [[ -e "$CONFIG" ]]; then
    printf 'kept %s (use --purge to delete)\n' "$CONFIG"
  fi
  (( problems == 0 )) || exit 1
  printf 'uninstall complete%s\n' "$( (( DRY_RUN )) && printf ' (dry run, nothing changed)')"
  exit 0
fi

# --- install

check_node
for f in $RUNTIME; do
  [[ -e "$SRC/$f" ]] || problem "missing source $f (run from a repository checkout)"
done
check_share
check_target "$CMD"
if (( problems > 0 )); then
  printf 'install: %s problem(s); nothing was written\n' "$problems" >&2
  exit 1
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/orca-install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# Runtime: stage a clean copy, then swap it in only when something changed.
mkdir -p "$STAGE/share"
for f in $RUNTIME; do cp -R "$SRC/$f" "$STAGE/share/"; done
for f in $OPTIONAL; do [[ ! -e "$SRC/$f" ]] || cp "$SRC/$f" "$STAGE/share/"; done
printf '%s\n' "$MARKER" >"$STAGE/share/$SHARE_MARKER"
if [[ -f "$SHARE/$SHARE_MARKER" ]]; then
  prev="$("$NODE" -p 'require(process.argv[1]).version' "$SHARE/package.json" 2>/dev/null)" || prev=''
  printf 'previous orca-openbot %s\n' "${prev:-unknown}"
fi
if [[ -d "$SHARE" ]] && diff -rq --exclude=INSTALLED_COMMIT "$STAGE/share" "$SHARE" >/dev/null 2>&1; then
  printf 'unchanged %s\n' "$SHARE"
else
  aside=""
  if (( !DRY_RUN )) && [[ -f "$SHARE/INSTALLED_COMMIT" ]]; then
    aside="$(mktemp)"; cp "$SHARE/INSTALLED_COMMIT" "$aside"
  fi
  act "updated   $SHARE" swap_share
fi

# Command: symlink into DIR/bin (the entrypoint has a node shebang and is executable).
link_command() {
  mkdir -p "$BIN" && ln -sfn "$SHARE/bin/orca-openbot.js" "$CMD" && chmod 755 "$SHARE/bin/orca-openbot.js"
}
if [[ "$(readlink "$CMD" 2>/dev/null)" == "$SHARE/bin/orca-openbot.js" ]]; then
  printf 'unchanged %s\n' "$CMD"
else
  act "linked    $CMD -> $SHARE/bin/orca-openbot.js" link_command
fi

# Config: migrated once from the herdr-openbot location, else created from a template; never overwritten.
if [[ -e "$CONFIG" ]]; then
  if [[ "$(stat -c %a "$CONFIG" 2>/dev/null || echo 600)" != 600 ]]; then
    act "tightened $CONFIG to 0600" chmod 600 "$CONFIG"
  else
    printf 'kept %s\n' "$CONFIG"
  fi
elif [[ -z "$CONFIG_FILE_OVERRIDE" && -f "$OLD_CONFIG" ]]; then
  act "migrated $OLD_CONFIG -> $CONFIG (same webhook and secret)" migrate_config
else
  act "created $CONFIG (edit it to set OPENBOT_ORCA_WEBHOOK_URL)" write_config_template
fi

if (( DRY_RUN )); then
  printf 'dry run complete; nothing was written\n'
  exit 0
fi
# Last step: full 40-char sha, or unknown. Temp file in the share dir, then rename.
installed_commit="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)"
if [[ ! "$installed_commit" =~ ^[0-9a-f]{40}$ ]]; then installed_commit=unknown; fi
commit_tmp="$SHARE/.INSTALLED_COMMIT.tmp"
printf '%s\n' "$installed_commit" >"$commit_tmp"
mv -f "$commit_tmp" "$SHARE/INSTALLED_COMMIT"
commit="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
printf 'installed orca-openbot (%s); next: orca-openbot doctor\n' "$commit"
printf 'Orca > Ajustes > Agentes > Pi > Comando:\n  %s\n' "$(pi_command)"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) printf 'note: %s is not on PATH; add it to your shell profile\n' "$BIN" ;;
esac
