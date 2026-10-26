#!/bin/sh
# Stand-in for `expo export` in tests (PRONG_UI_BUILD_CMD): copies the factory web build into the output folder
# and marks it, so the interface stays the same but a new build can be told apart. A source containing BREAK fails
# like a syntax error would.
set -e
out="$1"
if grep -rq BREAK src 2>/dev/null; then echo "SyntaxError: Unexpected token BREAK in src/Toolbar.tsx" >&2; exit 1; fi
mkdir -p "$out"
cp -R "$PRONG_WEB_DIR"/. "$out"/
stamp="$$-$(date +%s)"
sed -i.bak "s#<head>#<head><meta name=\"prong-build\" content=\"$stamp\">#" "$out/index.html"
rm -f "$out/index.html.bak"
