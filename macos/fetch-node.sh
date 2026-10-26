#!/bin/bash
# Downloads the official self-contained Node.js (LTS 22, arm64) binary used inside Prong.app.
# Homebrew's node is dynamically linked against brew libraries and cannot be bundled.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/macos/vendor"
mkdir -p "$DEST"
VER=$(curl -s https://nodejs.org/dist/index.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(x['version'] for x in d if x['version'].startswith('v22.') and x.get('lts')))")
TMP=$(mktemp -d)
echo "▸ downloading node $VER (darwin-arm64)"
curl -sL -o "$TMP/node.tar.gz" "https://nodejs.org/dist/$VER/node-$VER-darwin-arm64.tar.gz"
tar xzf "$TMP/node.tar.gz" -C "$TMP"
cp "$TMP/node-$VER-darwin-arm64/bin/node" "$DEST/node"
chmod +x "$DEST/node"
echo "$VER" > "$DEST/node.version"
rm -rf "$TMP"
"$DEST/node" -v
