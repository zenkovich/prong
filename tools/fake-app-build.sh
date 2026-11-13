#!/bin/sh
# Stand-in for macos/build.sh in tests (PRONG_APP_BUILD_CMD), run by the engine in the app sources: prints the
# real script's steps, notes each build in the engine's state folder, and fails like a type error in the engine
# would when its sources (server/) contain BREAK. It makes no bundle: the restart after it quits nothing.
echo "▸ web build"
sleep 0.3
echo "▸ engine build"
if grep -rq BREAK server 2>/dev/null; then echo "server/src/engine.ts(1,4): error TS1005: ';' expected near BREAK" >&2; exit 1; fi
sleep 0.3
echo "▸ swift shell"
echo "built $(date +%s)" >> "$PRONG_STATE_DIR/app-builds.log"
echo "▸ built Prong.app (fake)"
