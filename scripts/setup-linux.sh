#!/usr/bin/env bash
# Sets up a Linux machine (Debian/Ubuntu) to build, run and test W3Proj Studio.
#
#   scripts/setup-linux.sh               install what's missing (asks for sudo for system packages)
#   scripts/setup-linux.sh --check       only report what's there and what's missing; changes nothing
#   scripts/setup-linux.sh --game PATH   use this Warcraft III folder (else the newest install found)
#
# Safe to run again: anything already installed is left alone, and a chosen game folder is kept.
# What it sets up, and why, is in README.md ("Build & run", Linux).

set -euo pipefail

CHECK_ONLY=0
GAME_ARG=""
while (( $# )); do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --game) GAME_ARG="${2:?--game needs a folder}"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR=22           # Vite 7 needs Node 20.19+ or 22.12+
NVM_VERSION=v0.40.3

# Tauri's build dependencies on Linux, plus what the app smoke test needs:
# webkit2gtk-driver (WebKitWebDriver, driven by tauri-driver) and xvfb (an invisible display).
APT_PACKAGES=(
  build-essential curl wget file pkg-config
  libwebkit2gtk-4.1-dev libssl-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev
  webkit2gtk-driver xvfb
)

missing=()
ok()   { printf '  \033[32mok\033[0m       %s\n' "$*"; }
miss() { printf '  \033[33mmissing\033[0m  %s\n' "$*"; missing+=("$1"); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if ! command -v apt-get >/dev/null; then
  echo "This script knows Debian/Ubuntu (apt) only. For other distributions see README.md." >&2
  exit 1
fi

# --- System packages -------------------------------------------------------------------------
step "System packages"
apt_missing=()
for p in "${APT_PACKAGES[@]}"; do
  if dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed"; then ok "$p"
  else miss "$p"; apt_missing+=("$p"); fi
done
if (( ${#apt_missing[@]} )) && (( ! CHECK_ONLY )); then
  echo "  installing: ${apt_missing[*]}"
  sudo apt-get update
  sudo apt-get install -y "${apt_missing[@]}"
fi

# --- Rust --------------------------------------------------------------------------------------
step "Rust (version pinned in rust-toolchain.toml)"
if command -v rustup >/dev/null; then
  ok "rustup"
  if (( ! CHECK_ONLY )); then
    (cd "$REPO" && rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install)
  fi
  (cd "$REPO" && rustc --version 2>/dev/null | sed 's/^/  /') || true
else
  miss "rustup"
  if (( ! CHECK_ONLY )); then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
    (cd "$REPO" && rustup toolchain install)
  fi
fi

# --- Node --------------------------------------------------------------------------------------
step "Node $NODE_MAJOR+ (through nvm)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
if command -v nvm >/dev/null; then ok "nvm"; else
  miss "nvm"
  if (( ! CHECK_ONLY )); then
    curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
    # shellcheck disable=SC1091
    source "$NVM_DIR/nvm.sh"
  fi
fi
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
if [[ "$(node_major)" -ge $NODE_MAJOR ]] 2>/dev/null; then ok "node $(node -v)"; else
  miss "node $NODE_MAJOR (have: $(node -v 2>/dev/null || echo none))"
  if (( ! CHECK_ONLY )) && command -v nvm >/dev/null; then
    nvm install "$NODE_MAJOR"
    nvm alias default "$NODE_MAJOR"
  fi
fi

# --- tauri-driver --------------------------------------------------------------------------
step "tauri-driver (WebDriver bridge for the app smoke test)"
if command -v tauri-driver >/dev/null; then ok "tauri-driver"; else
  miss "tauri-driver"
  if (( ! CHECK_ONLY )); then cargo install tauri-driver --locked; fi
fi
case ":$PATH:" in *":$HOME/.cargo/bin:"*) ;; *)
  echo "  note: ~/.cargo/bin isn't on PATH; add it so tauri-driver is found" ;;
esac

# --- compiler cache (sccache) -------------------------------------------------------------------
# Every worktree under .worktrees/ builds the Rust code from scratch; sccache shares compiled crates between them.
# The binary and its cache stay inside this checkout's target/, and the local .cargo/config.toml (git-ignored) points
# cargo at it; worktrees below this folder read that file too. Optional: without it builds are only slower.
step "sccache (a compiler cache shared by the worktrees)"
SCCACHE="$REPO/target/tools/bin/sccache"
if [[ -x "$SCCACHE" ]]; then ok "sccache"; else
  miss "sccache"
  if (( ! CHECK_ONLY )); then cargo install sccache --locked --root "$REPO/target/tools"; fi
fi
if [[ -x "$SCCACHE" && ! -f "$REPO/.cargo/config.toml" ]] && (( ! CHECK_ONLY )); then
  mkdir -p "$REPO/.cargo"
  cat > "$REPO/.cargo/config.toml" <<EOF
# Local only (git-ignored), written by scripts/setup-linux.sh: a shared compiler cache for this checkout and every
# worktree under .worktrees/ (cargo reads this file from the parent folders).
[build]
rustc-wrapper = "$SCCACHE"

[env]
SCCACHE_DIR = "$REPO/target/sccache"
SCCACHE_CACHE_SIZE = "15G"
EOF
  ok ".cargo/config.toml (sccache)"
fi

# --- npm packages ------------------------------------------------------------------------------
step "npm packages in app/"
if [[ -d "$REPO/app/node_modules/.bin" ]]; then ok "app/node_modules"; else
  miss "app/node_modules"
  if (( ! CHECK_ONLY )) && [[ "$(node_major)" -ge $NODE_MAJOR ]] 2>/dev/null; then
    (cd "$REPO/app" && npm ci)
  fi
fi

# --- Warcraft III ------------------------------------------------------------------------------
# The game's files (CASC storage) are read, never run or copied. On Linux the game lives in a Wine prefix:
# Steam (Proton), Lutris/Battle.net or plain Wine. The choice goes into .game-path (git-ignored), which the
# gate and the test scripts read when W3PROJ_GAME isn't set (tests/gamepath.mjs).
step "Warcraft III (the game's files, for new maps and the corpus tests)"

# The build of an install, from its .build.info (a |-separated table with a "Version!STRING:0" column).
game_build() {
  local info="$1/.build.info"
  [[ -f "$info" ]] || return 1
  awk -F'|' 'NR == 1 { for (i = 1; i <= NF; i++) if ($i ~ /^Version!/) col = i; next }
             col && $col != "" { print $col; exit }' "$info"
}

# Every Warcraft III folder in the usual Wine prefixes.
find_games() {
  local libs=() lib
  for lib in "$HOME/.steam/steam" "$HOME/.steam/debian-installation" "$HOME/.local/share/Steam" \
             "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam"; do
    [[ -d "$lib/steamapps" ]] && libs+=("$lib")
    # Further Steam libraries (other drives) are listed in libraryfolders.vdf.
    if [[ -f "$lib/steamapps/libraryfolders.vdf" ]]; then
      while IFS= read -r p; do [[ -d "$p/steamapps" ]] && libs+=("$p"); done \
        < <(sed -nE 's/^[[:space:]]*"path"[[:space:]]+"(.*)"/\1/p' "$lib/steamapps/libraryfolders.vdf")
    fi
  done
  {
    for lib in "${libs[@]}"; do
      for g in "$lib"/steamapps/compatdata/*/pfx/drive_c/"Program Files (x86)"/"Warcraft III"; do echo "$g"; done
    done
    for g in "$HOME"/Games/*/drive_c/"Program Files (x86)"/"Warcraft III" \
             "$HOME"/.wine/drive_c/"Program Files (x86)"/"Warcraft III" \
             "$HOME"/.local/share/lutris/prefixes/*/drive_c/"Program Files (x86)"/"Warcraft III"; do echo "$g"; done
  } | while IFS= read -r g; do
    [[ -d "$g" && -f "$g/.build.info" ]] && (cd "$g" && pwd -P)
  done | sort -u
}

GAME_FILE="$REPO/.game-path"
current=""
[[ -f "$GAME_FILE" ]] && current="$(grep -v '^[[:space:]]*#' "$GAME_FILE" | head -1)"

found=()
while IFS= read -r g; do [[ -n "$g" ]] && found+=("$g"); done < <(find_games)
newest=""; newest_build=""
for g in "${found[@]}"; do
  b="$(game_build "$g" || echo "?")"
  mark=""; [[ "$g" == "$current" ]] && mark=" (chosen)"
  echo "  found    build $b  $g$mark"
  if [[ "$b" != "?" ]] && [[ -z "$newest_build" || "$(printf '%s\n%s\n' "$newest_build" "$b" | sort -V | tail -1)" == "$b" ]]; then
    newest="$g"; newest_build="$b"
  fi
done

if [[ -n "$GAME_ARG" ]]; then
  pick="$(cd "$GAME_ARG" 2>/dev/null && pwd -P || true)"
  [[ -n "$pick" && -f "$pick/.build.info" ]] || { echo "  --game: no Warcraft III install (no .build.info) in $GAME_ARG" >&2; exit 1; }
elif [[ -n "$current" ]]; then
  pick="$current"
else
  pick="$newest"
fi

if [[ -n "${W3PROJ_GAME:-}" ]]; then
  echo "  note: W3PROJ_GAME is set ($W3PROJ_GAME) and wins over .game-path"
fi
if [[ -z "$pick" ]]; then
  miss "Warcraft III"
  echo "  none found. Install it (Steam with Proton, or Battle.net through Lutris), then run this again,"
  echo "  or point to it: scripts/setup-linux.sh --game \"/path/to/Warcraft III\""
elif [[ ! -f "$pick/.build.info" ]]; then
  miss "Warcraft III (.game-path points to $pick, which isn't an install)"
else
  ok "Warcraft III build $(game_build "$pick")  $pick"
  if [[ -n "$newest" && "$pick" != "$newest" && -z "$GAME_ARG" ]]; then
    echo "  note: a newer build ($newest_build) is at $newest; choose it with --game"
  fi
  if (( ! CHECK_ONLY )) && [[ "$pick" != "$current" ]]; then
    printf '# The Warcraft III folder for the tests and tools (tests/gamepath.mjs). Written by scripts/setup-linux.sh.\n%s\n' "$pick" > "$GAME_FILE"
    echo "  wrote .game-path"
  elif (( CHECK_ONLY )) && [[ "$pick" != "$current" ]]; then
    miss ".game-path (run without --check to choose the folder above)"
  fi
  echo "  the app asks for its game folder at start when it has none that opens (it finds the same installs);"
  echo "  later: \"Game Data: Choose Warcraft III Folder…\""
fi

# --- Summary ----------------------------------------------------------------------------------
step "Summary"
if (( CHECK_ONLY )); then
  if (( ${#missing[@]} )); then echo "  missing: ${missing[*]}"; echo "  run without --check to install"; exit 1; fi
  echo "  everything is there"
else
  echo "  done. Open a new terminal (or: source ~/.bashrc) so nvm's Node is on PATH,"
  echo "  then check with: scripts/setup-linux.sh --check"
fi
