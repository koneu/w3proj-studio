#!/usr/bin/env bash
# Sets up a Linux machine (Debian/Ubuntu) to build, run and test W3Proj Studio.
#
#   scripts/setup-linux.sh           install what's missing (asks for sudo for system packages)
#   scripts/setup-linux.sh --check   only report what's there and what's missing; changes nothing
#
# Safe to run again: anything already installed is left alone.
# What it sets up, and why, is in README.md ("Build & run", Linux).

set -euo pipefail

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

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

# --- npm packages ------------------------------------------------------------------------------
step "npm packages in app/"
if [[ -d "$REPO/app/node_modules/.bin" ]]; then ok "app/node_modules"; else
  miss "app/node_modules"
  if (( ! CHECK_ONLY )) && [[ "$(node_major)" -ge $NODE_MAJOR ]] 2>/dev/null; then
    (cd "$REPO/app" && npm ci)
  fi
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
