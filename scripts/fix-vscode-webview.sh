#!/usr/bin/env bash
#
# fix-vscode-webview.sh
# Fixes: "Error loading webview: Could not register service worker:
#         InvalidStateError: Failed to register a ServiceWorker:
#         The document is in an invalid state."
#
# This is a VS Code webview cache problem (not a Claude Code bug). The script
# quits VS Code, deletes ONLY the webview/service-worker caches, and relaunches.
# Settings, extensions, and keybindings are NOT touched.
#
# Supports macOS, Linux, and Windows (Git Bash / WSL).

set -euo pipefail

# --- Pick the VS Code variant -------------------------------------------------
# Default is stable "Code". Pass "insiders" as the first arg for Insiders.
VARIANT="${1:-stable}"
case "$VARIANT" in
  insiders) APP_DIR="Code - Insiders"; PROC="Electron|Code - Insiders" ;;
  *)        APP_DIR="Code";            PROC="Visual Studio Code|Code Helper" ;;
esac

# --- Locate the user-data directory per OS ------------------------------------
OS="$(uname -s)"
case "$OS" in
  Darwin)  BASE="$HOME/Library/Application Support/$APP_DIR" ;;
  Linux)   BASE="$HOME/.config/$APP_DIR" ;;
  MINGW*|MSYS*|CYGWIN*) BASE="$APPDATA/$APP_DIR" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

if [ ! -d "$BASE" ]; then
  echo "VS Code user-data dir not found at: $BASE"
  echo "If you use a different build, edit APP_DIR in this script."
  exit 1
fi

echo "Target VS Code data dir: $BASE"

# --- Quit VS Code -------------------------------------------------------------
echo "Quitting VS Code..."
case "$OS" in
  Darwin)
    osascript -e "quit app \"$APP_DIR\"" 2>/dev/null || true
    sleep 2
    pkill -f "$PROC" 2>/dev/null || true
    ;;
  Linux)
    pkill -f "$APP_DIR" 2>/dev/null || true
    ;;
  *)
    # Windows (Git Bash): taskkill
    taskkill //IM Code.exe //F 2>/dev/null || true
    ;;
esac
sleep 1

# --- Delete only the caches ---------------------------------------------------
for d in \
  "Service Worker" \
  "Cache" \
  "CachedData" \
  "Code Cache" \
  "GPUCache" \
  "DawnCache" \
  "DawnGraphiteCache" \
  "DawnWebGPUCache"
do
  if [ -e "$BASE/$d" ]; then
    echo "Removing: $d"
    rm -rf "$BASE/$d"
  fi
done

echo "Caches cleared."

# --- Relaunch -----------------------------------------------------------------
echo "Relaunching VS Code..."
case "$OS" in
  Darwin) open -a "$APP_DIR" 2>/dev/null || true ;;
  Linux)  (command -v code >/dev/null && code >/dev/null 2>&1 &) || true ;;
  *)      (command -v code >/dev/null && code >/dev/null 2>&1 &) || true ;;
esac

echo "Done. If the error persists, update VS Code (Help → Check for Updates)"
echo "and update the Claude Code extension, then run this script once more."
