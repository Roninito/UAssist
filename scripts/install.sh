#!/usr/bin/env bash
# Installs uassist for macOS and Linux: builds standalone `uassist` and
# `uassist-server` binaries (bun --compile — no Bun runtime needed to run
# them afterward, only to build them) and puts them on PATH.
#
# Usage:  scripts/install.sh
# Override the install location with UASSIST_INSTALL_DIR.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${UASSIST_INSTALL_DIR:-$HOME/.uassist/bin}"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to build uassist (https://bun.sh)." >&2
  exit 1
fi

echo "Building uassist from $REPO_ROOT..."
cd "$REPO_ROOT"
bun install
bun run build:cli
bun run build:server

mkdir -p "$INSTALL_DIR"
cp "$REPO_ROOT/dist/uassist" "$INSTALL_DIR/uassist"
cp "$REPO_ROOT/dist/uassist-server" "$INSTALL_DIR/uassist-server"
chmod +x "$INSTALL_DIR/uassist" "$INSTALL_DIR/uassist-server"
echo "Installed to $INSTALL_DIR"

# The two binaries must stay siblings — `uassist start` finds uassist-server
# next to its own executable path (process.execPath), not on PATH.
if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
  echo "$INSTALL_DIR is already on PATH."
else
  case "$(basename "${SHELL:-}")" in
    zsh) RC_FILE="$HOME/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    *) RC_FILE="" ;;
  esac

  if [[ -n "$RC_FILE" ]]; then
    if ! grep -qF "$INSTALL_DIR" "$RC_FILE" 2>/dev/null; then
      {
        echo ""
        echo "# Added by uassist's install.sh"
        echo "export PATH=\"$INSTALL_DIR:\$PATH\""
      } >> "$RC_FILE"
      echo "Added $INSTALL_DIR to PATH in $RC_FILE."
    fi
    echo "Restart your shell, or run:  export PATH=\"$INSTALL_DIR:\$PATH\""
  else
    echo "Add this to your shell's startup file:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
  fi
fi

echo
echo "Done. Open a new shell and try: uassist --help"
