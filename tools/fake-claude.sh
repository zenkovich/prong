#!/bin/sh
# Stand-in for the Claude Code CLI in tests: prints the stream-json events Prong reads, costs nothing.
# The prompt (after -p) steers it: "slow task" waits 30 s (for the stop button), "fake-fail" exits with an error,
# "edit-ui" edits the app sources. With PRONG_FAKE_AGENT_LOG set, the prompt and the working folder are appended there.
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
prompt=""
resume=""
system=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then prompt="$2"; shift; fi
  if [ "$1" = "--resume" ]; then resume="$2"; shift; fi
  if [ "$1" = "--append-system-prompt" ]; then system="$2"; shift; fi
  shift
done
if [ -n "$PRONG_FAKE_AGENT_LOG" ]; then
  printf 'cwd: %s\nresume: %s\nssh: %s\nsystem: %s\n%s\n---\n' "$(pwd)" "$resume" "$GIT_SSH_COMMAND" "$system" "$prompt" >> "$PRONG_FAKE_AGENT_LOG"
fi
echo '{"type":"system","subtype":"init","session_id":"fake-session","model":"fake-model"}'
sleep 0.3
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/repo/src/state/store.ts"}}]}}'
sleep 0.3
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npx tsc --noEmit"}}]}}'
case "$prompt" in
  *"slow task"*) sleep 30 ;;
  *fake-fail*) echo "fake failure" >&2; exit 3 ;;
  *edit-ui*)
    # an interface change in the app sources (the working directory)
    echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/Toolbar.tsx"}}]}}'
    echo "// edited by fake agent: $(echo "$prompt" | head -1)" >> src/Toolbar.tsx ;;
esac
sleep 0.3
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Checked the store and the types."}]}}'
# the answer in Markdown, as Claude Code writes it (printf: sh's echo would turn the \n escapes into line breaks)
printf '%s\n' '{"type":"result","subtype":"success","result":"**Done: checked src/state/store.ts**, types are clean.\n\n### Checked\n- `src/state/store.ts`: no problems\n- `npx tsc --noEmit`: no errors\n\n```sh\ngit status\n```","total_cost_usd":0.0123}'
