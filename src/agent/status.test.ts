import { describe, expect, it } from 'vitest';
import { elapsed, statusFromEvent, summarize } from './status';

describe('agent status line', () => {
  it('describes tools in a few words', () => {
    expect(statusFromEvent('tool', 'Read /Users/a/prong/src/state/store.ts')).toBe('Reading store.ts');
    expect(statusFromEvent('tool', 'Edit /x/src/components/Sidebar.tsx')).toBe('Editing Sidebar.tsx');
    expect(statusFromEvent('tool', 'Write /x/new.md')).toBe('Writing new.md');
    expect(statusFromEvent('tool', 'Bash npx tsc --noEmit 2>&1 | tail -20')).toBe('Type-checking');
    expect(statusFromEvent('tool', 'Bash npm test')).toBe('Running tests');
    expect(statusFromEvent('tool', 'Bash git log --oneline -5')).toBe('Running git log --oneline -5');
    expect(statusFromEvent('tool', 'Bash ' + 'x'.repeat(100))).toMatch(/^Running x+…$/);
    expect(statusFromEvent('tool', 'Grep collapsedGroups')).toBe('Searching “collapsedGroups”');
    expect(statusFromEvent('tool', 'Glob src/**/*.tsx')).toBe('Finding src/**/*.tsx');
    expect(statusFromEvent('tool', 'TodoWrite {}')).toBe('Planning');
    expect(statusFromEvent('tool', 'Mystery thing')).toBe('Mystery thing');
  });
  it('maps session start to thinking and ignores other status lines', () => {
    expect(statusFromEvent('status', 'session 0ac27848 · claude-opus-5')).toBe('Thinking…');
    expect(statusFromEvent('status', 'Ignoring 3 permissions.allow entries')).toBeNull();
    expect(statusFromEvent('text', 'Done.')).toBe('Writing the answer…');
    expect(statusFromEvent('result', '{}')).toBeNull();
  });
  it('formats elapsed time', () => {
    expect(elapsed(900)).toBe('0.9 s');
    expect(elapsed(12_400)).toBe('12 s');
    expect(elapsed(65_000)).toBe('1 min 05 s');
  });
});

describe('agent notice summary', () => {
  it('counts what the agent did', () => {
    expect(summarize(['Read /a/x.ts', 'Read /a/y.ts', 'Edit /a/x.ts', 'Edit /a/x.ts', 'Write /a/z.md', 'Bash npx tsc', 'Grep foo', 'commit 1a2b3c4 in /src'])).toBe('2 files edited · 2 read · 1 command · commit 1a2b3c4 in /src');
    expect(summarize(['TodoWrite {}', 'Task explore'])).toBe('2 more steps');
    expect(summarize(['⚠ /p is not a git repository: edits applied, no version recorded.'])).toBe('⚠ /p is not a git repository: edits applied, no version recorded.');
    expect(summarize([])).toBe('');
  });
});
