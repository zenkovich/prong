#!/bin/bash
# Builds Prong.app: web UI (expo export) + git engine (compiled server + portable node) + Swift shell.
# Usage: macos/build.sh [--run]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/macos/build"
APP="$OUT/Prong.app"
NODE_BIN="${PRONG_NODE_BIN:-$ROOT/macos/vendor/node}"

if [ ! -x "$NODE_BIN" ]; then
  echo "portable node binary not found at $NODE_BIN; run macos/fetch-node.sh first" >&2
  exit 1
fi

echo "▸ file icons"
(cd "$ROOT" && node tools/gen-file-icons.mjs >/dev/null)

echo "▸ web build"
(cd "$ROOT" && npx expo export --platform web --output-dir "$OUT/web" >/dev/null)

echo "▸ engine build"
(cd "$ROOT/server" && rm -rf dist && npx tsc -p tsconfig.json)

echo "▸ bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/server" "$APP/Contents/Resources/bin"
cp "$ROOT/macos/Info.plist" "$APP/Contents/Info.plist"
cp -R "$OUT/web" "$APP/Contents/Resources/web"
cp -R "$ROOT/server/dist/src" "$APP/Contents/Resources/server/src"
printf '{ "name": "prong-engine", "type": "module", "private": true }\n' > "$APP/Contents/Resources/server/package.json"
cp "$NODE_BIN" "$APP/Contents/Resources/bin/node"
chmod +x "$APP/Contents/Resources/bin/node"
[ -f "$ROOT/macos/Prong.icns" ] && cp "$ROOT/macos/Prong.icns" "$APP/Contents/Resources/Prong.icns"

echo "▸ swift shell"
xcrun swiftc -O -target arm64-apple-macos13.0 -o "$APP/Contents/MacOS/Prong" "$ROOT/macos/Sources/main.swift" -framework Cocoa -framework WebKit 2>&1 | grep -v "^$" || true
[ -x "$APP/Contents/MacOS/Prong" ] || { echo "swift build failed" >&2; exit 1; }

echo "▸ sign (ad hoc)"
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true

du -sh "$APP" | awk '{print "▸ built " $2 " (" $1 ")"}'
if [ "${1:-}" = "--run" ]; then
  open "$APP"
fi
