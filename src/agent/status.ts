/**
 * One short line for the agent bar describing what Claude Code is doing, from its stream events
 * (`tool:<Name> <summary>`, `text:…`, `status:…` lines the engine forwards). Returns null when the event does
 * not change what the user should see.
 */

const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function statusFromEvent(kind: string, payload: string): string | null {
  if (kind === 'status') return /^session /.test(payload) ? 'Thinking…' : null;
  if (kind === 'text') return 'Writing the answer…';
  if (kind !== 'tool') return null;
  const sp = payload.indexOf(' ');
  const name = sp < 0 ? payload : payload.slice(0, sp);
  const arg = sp < 0 ? '' : payload.slice(sp + 1).trim();
  switch (name) {
    case 'Read':
      return `Reading ${base(arg)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(arg)}`;
    case 'Write':
      return `Writing ${base(arg)}`;
    case 'NotebookEdit':
      return `Editing ${base(arg)}`;
    case 'Bash': {
      const cmd = arg.replace(/\s+/g, ' ');
      if (/^git\s/.test(cmd)) return `Running ${clip(cmd, 44)}`;
      if (/\btsc\b/.test(cmd)) return 'Type-checking';
      if (/\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bvitest\b|\bjest\b/.test(cmd)) return 'Running tests';
      return `Running ${clip(cmd, 44)}`;
    }
    case 'Grep':
      return `Searching “${clip(arg, 32)}”`;
    case 'Glob':
      return `Finding ${clip(arg, 36)}`;
    case 'WebFetch':
    case 'WebSearch':
      return 'Looking it up';
    case 'TodoWrite':
      return 'Planning';
    case 'Task':
    case 'Agent':
      return 'Delegating a subtask';
    default:
      return clip(`${name} ${arg}`.trim(), 48);
  }
}

/** "0.9 s", "12 s", "1 min 05 s" */
export function elapsed(ms: number) {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** "Read store.ts, Bash npx tsc …" → "2 files read · 1 command · commit 1a2b3c4" */
export function summarize(actions: string[]) {
  const n = (re: RegExp) => actions.filter((a) => re.test(a)).length;
  const read = n(/^Read /);
  const edited = new Set(actions.filter((a) => /^(Edit|MultiEdit|Write) /.test(a)).map((a) => a.split(' ')[1])).size;
  const cmds = n(/^Bash /);
  const commit = actions.find((a) => /^commit /.test(a));
  // outcome lines are not steps: the recorded version, the cost
  const other = actions.filter((a) => !/^(Read|Edit|MultiEdit|Write|Bash|Grep|Glob) |^commit |^no source changes|^⚠|^version v|^cost \$|^done$/.test(a)).length;
  const warn = actions.find((a) => a.startsWith('⚠'));
  return [edited ? `${edited} file${edited > 1 ? 's' : ''} edited` : null, read ? `${read} read` : null, cmds ? `${cmds} command${cmds > 1 ? 's' : ''}` : null, other ? `${other} more step${other > 1 ? 's' : ''}` : null, commit, warn]
    .filter(Boolean)
    .join(' · ');
}
