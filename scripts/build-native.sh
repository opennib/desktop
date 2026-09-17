#!/usr/bin/env bash
set -euo pipefail

# Compile the macOS-only Swift helpers used by the desktop app:
#   - fn-key-monitor: prints DOWN/UP on Fn-key state changes
#   - paste-helper:   posts a Cmd+V keystroke
#
# Both are spawned by the main process (see main/services/hotkey.ts and
# main/services/paster.ts). The compiled output lands next to the .swift
# sources so app.getAppPath()/native/<name> resolves at runtime in both
# dev (electron-vite) and packaged builds.

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-native: macOS only (current OS: $(uname -s)); nothing to do"
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "build-native: swiftc not found — install Xcode command-line tools (xcode-select --install)" >&2
  exit 1
fi

mkdir -p native

# -O = release-level optimisation. swiftc only honours one -target at a
# time, so build each arch separately and lipo them into one universal
# binary that runs on Apple Silicon and Intel from a single file.
build_universal() {
  local src="$1"
  local out="$2"
  local tmp_arm64="${out}.arm64"
  local tmp_x86_64="${out}.x86_64"
  swiftc -O -target arm64-apple-macos11  "$src" -o "$tmp_arm64"
  swiftc -O -target x86_64-apple-macos11 "$src" -o "$tmp_x86_64"
  lipo -create -output "$out" "$tmp_arm64" "$tmp_x86_64"
  rm -f "$tmp_arm64" "$tmp_x86_64"
  # Explicit ad-hoc codesign. Without this, swiftc emits a "linker-signed"
  # signature that the macOS Accessibility framework treats as ephemeral —
  # the user's permission grant in System Settings never persists across
  # rebuilds, and the binary loses trust on every recompile. Explicitly
  # re-signing produces a stable adhoc signature (flags=0x2, not 0x20002)
  # tied to the binary's hash, which is what the qvac-dictate POC ships.
  codesign --force --sign - "$out"
}

build_universal native/fn-key-monitor.swift native/fn-key-monitor
build_universal native/paste-helper.swift   native/paste-helper

echo "build-native: built universal native/fn-key-monitor and native/paste-helper"
