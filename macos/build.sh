#!/bin/bash
# Builds Prong.app: web UI (expo export) + git engine (compiled server + portable node) + Swift shell.
# Usage: macos/build.sh [--run]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/macos/build"
APP="$OUT/Prong.app"
# the bundle is put together next to the old one and swapped in at the very end: a Prong that runs from it keeps
# working through the build (the agent's builds run inside it), and a failed build leaves the old app as it was
STAGE="$OUT/.next/Prong.app"
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
rm -rf "$OUT/.next"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources/server" "$STAGE/Contents/Resources/bin"
cp "$ROOT/macos/Info.plist" "$STAGE/Contents/Info.plist"
cp -R "$OUT/web" "$STAGE/Contents/Resources/web"
cp -R "$ROOT/server/dist/src" "$STAGE/Contents/Resources/server/src"
printf '{ "name": "prong-engine", "type": "module", "private": true }\n' > "$STAGE/Contents/Resources/server/package.json"
cp "$NODE_BIN" "$STAGE/Contents/Resources/bin/node"
chmod +x "$STAGE/Contents/Resources/bin/node"
[ -f "$ROOT/macos/Prong.icns" ] && cp "$ROOT/macos/Prong.icns" "$STAGE/Contents/Resources/Prong.icns"

echo "▸ swift shell"
xcrun swiftc -O -target arm64-apple-macos13.0 -o "$STAGE/Contents/MacOS/Prong" "$ROOT/macos/Sources/main.swift" -framework Cocoa -framework WebKit 2>&1 | grep -v "^$" || true
[ -x "$STAGE/Contents/MacOS/Prong" ] || { echo "swift build failed" >&2; exit 1; }

echo "▸ sign (ad hoc)"
codesign --force --deep --sign - "$STAGE" 2>&1 | grep -v "replacing existing signature" || true

# the swap: the new bundle takes the old one's place in one move each way
rm -rf "$OUT/.old"
[ -d "$APP" ] && mkdir -p "$OUT/.old" && mv "$APP" "$OUT/.old/Prong.app"
mv "$STAGE" "$APP"
rm -rf "$OUT/.next" "$OUT/.old"

du -sh "$APP" | awk '{print "▸ built " $2 " (" $1 ")"}'
if [ "${1:-}" = "--run" ]; then
  open "$APP"
fi
